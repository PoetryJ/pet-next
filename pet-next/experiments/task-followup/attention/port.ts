/**
 * AttentionPort 实现：问题合并、回答版本校验、静默/额度/最小间隔、可见性回执。
 *
 * 关键语义：
 * - 同 decisionKey 只保留一个问题；不同 revision 的旧问题被 supersede，记录保留；
 * - 回答必须引用当前 attentionId + taskRevision，旧问题回答记 stale_answer；
 * - 静默/额度/最小间隔只来自显式配置，不推断用户永久偏好；
 * - 静默期间问题仍可在面板看到，只是不进入主动通知队列；
 * - 通知有 queued → delivered → presented 三个可核验状态与时间；
 * - 回答只认“已送达或已呈现”的问题：没送达就是用户没看到，不能代替用户作答。
 *
 * @module pet-next/experiments/task-followup/attention
 */
import { millisBetween, stableId } from '../contracts.ts'
import type {
  AnswerInput,
  AnswerResult,
  AttentionPort,
  AttentionStore,
  AttentionView,
  NotificationReceipt,
  ProposedDecision,
  QuietConfig,
  VisibilityReceipt,
} from '../contracts.ts'
import { isQuietAt } from '../contracts.ts'

export class AttentionQueue implements AttentionPort {
  constructor(private readonly store: AttentionStore) {}

  open(proposal: ProposedDecision, now: string, _quiet: QuietConfig): { attention: AttentionView; merged: boolean } {
    const decisionKey = proposal.decisionKey ?? proposal.decisionId
    const existing = this.store
      .listAttentions(proposal.ticketId)
      .filter((attention) => attention.state === 'open')
    const same = existing.find((attention) => attention.decisionKey === decisionKey)
    if (same && same.taskRevision === proposal.taskRevision) {
      return { attention: same, merged: true }
    }
    for (const attention of existing) {
      // 同一时刻只保留一个问题：旧 key 或旧 revision 一律撤销，但保留记录。
      this.store.updateAttention(attention.attentionId, { state: 'superseded' })
    }
    const ordinal = this.store.listAttentions(proposal.ticketId).length
    const attentionId = stableId(
      'attn',
      proposal.ticketId,
      decisionKey,
      proposal.taskRevision,
      proposal.decisionId,
      String(ordinal),
    )
    const view: AttentionView = {
      attentionId,
      ticketId: proposal.ticketId,
      taskRevision: proposal.taskRevision,
      assignmentId: proposal.assignmentId,
      decisionId: proposal.decisionId,
      decisionKey,
      question: proposal.question ?? proposal.reasonText,
      options: proposal.options ?? [],
      evidenceRefs: proposal.evidenceRefs,
      state: 'open',
      createdAt: now,
      ...(proposal.notBefore ? { notBefore: proposal.notBefore } : {}),
      ...(proposal.deadline ? { deadline: proposal.deadline } : {}),
    }
    this.store.insertAttention(view, proposal.reasonText)
    return { attention: view, merged: false }
  }

  notify(
    attentionId: string,
    now: string,
    quiet: QuietConfig,
    urgent: boolean,
  ): { notified: boolean; reason: string; notificationId?: string } {
    const attention = this.store.getAttention(attentionId)
    if (!attention) return { notified: false, reason: 'unknown_attention' }
    if (attention.state !== 'open') return { notified: false, reason: `attention_${attention.state}` }
    if (attention.notBefore && attention.notBefore > now) return { notified: false, reason: 'not_before' }
    const quietNow = isQuietAt(now, quiet)
    if (quietNow && !(urgent && quiet.allowUrgent)) return { notified: false, reason: 'quiet_hours' }
    const last = this.store.lastNotificationAt(attention.ticketId)
    if (last && millisBetween(last, now) < quiet.minGapMs) {
      return { notified: false, reason: `min_gap:${quiet.minGapMs}` }
    }
    const since = new Date(Date.parse(now) - 60 * 60_000).toISOString()
    if (this.store.countNotificationsSince(attention.ticketId, since) >= quiet.reminderQuotaPerHour) {
      return { notified: false, reason: 'quota_exceeded' }
    }
    const notificationId = stableId('notif', attention.ticketId, attentionId, now)
    this.store.insertNotification({
      notificationId,
      ticketId: attention.ticketId,
      attentionId,
      decisionId: attention.decisionId,
      text: attention.question,
      createdAt: now,
      state: 'queued',
    })
    if (!attention.notifiedAt) this.store.updateAttention(attentionId, { notifiedAt: now })
    return { notified: true, reason: 'queued', notificationId }
  }

  deliverPending(now: string): readonly string[] {
    const delivered: string[] = []
    for (const notification of this.store.listNotificationReceipts()) {
      if (notification.state !== 'queued') continue
      this.store.markNotification(notification.notificationId, { state: 'delivered', at: now })
      if (notification.attentionId) {
        const attention = this.store.getAttention(notification.attentionId)
        if (attention && !attention.deliveredAt) {
          this.store.updateAttention(notification.attentionId, { deliveredAt: now })
        }
      }
      delivered.push(notification.notificationId)
    }
    return delivered
  }

  present(ticketId: string, now: string): readonly string[] {
    const presented: string[] = []
    for (const attention of this.store.listAttentions(ticketId)) {
      if (attention.state !== 'open') continue
      // 呈现即视为送达：打开面板这一动作本身就是明确的呈现回执。
      for (const notification of this.store.listNotificationReceipts(ticketId)) {
        if (notification.attentionId !== attention.attentionId) continue
        if (notification.state === 'presented') continue
        this.store.markNotification(notification.notificationId, { state: 'presented', at: now })
      }
      this.store.updateAttention(attention.attentionId, {
        ...(attention.notifiedAt ? {} : { notifiedAt: now }),
        ...(attention.deliveredAt ? {} : { deliveredAt: now }),
        presentedAt: now,
      })
      presented.push(attention.attentionId)
    }
    return presented
  }

  visibility(attentionId: string): VisibilityReceipt {
    const attention = this.store.getAttention(attentionId)
    if (!attention) return { attentionId, visible: false, via: null, at: null, queuedAt: null }
    const via: 'delivered' | 'presented' | null = attention.presentedAt
      ? 'presented'
      : attention.deliveredAt
        ? 'delivered'
        : null
    return {
      attentionId,
      visible: via !== null,
      via,
      at: attention.presentedAt ?? attention.deliveredAt ?? null,
      queuedAt: attention.notifiedAt ?? null,
    }
  }

  answer(input: AnswerInput): AnswerResult {
    const attention = this.store.getAttention(input.attentionId)
    if (!attention) return { ok: false, code: 'unknown_attention', detail: 'attention not found' }
    if (attention.state === 'answered') return { ok: false, code: 'already_answered', detail: 'already answered' }
    if (attention.state !== 'open') {
      return { ok: false, code: 'stale_answer', detail: `attention is ${attention.state}` }
    }
    if (attention.taskRevision !== input.taskRevision) {
      this.store.updateAttention(attention.attentionId, { state: 'stale_answer' })
      return { ok: false, code: 'stale_answer', detail: `attention r${attention.taskRevision} != answer r${input.taskRevision}` }
    }
    const option = attention.options.find((item) => item.id === input.optionId)
    if (!option) return { ok: false, code: 'invalid_option', detail: `option ${input.optionId} not offered` }
    const visibility = this.visibility(attention.attentionId)
    if (!visibility.visible) {
      return {
        ok: false,
        code: 'not_visible',
        detail: `question was never delivered or presented (queuedAt=${visibility.queuedAt ?? 'none'})`,
      }
    }
    this.store.updateAttention(attention.attentionId, {
      state: 'answered',
      answeredAt: input.now,
      answerOptionId: option.id,
      answerLabel: option.label,
    })
    return { ok: true, attention: this.store.getAttention(attention.attentionId)!, answerEventId: input.sourceId }
  }

  supersede(ticketId: string, _taskRevision: number, _reason: string, _now: string): AttentionView[] {
    const open = this.store.listAttentions(ticketId).filter((attention) => attention.state === 'open')
    for (const attention of open) this.store.updateAttention(attention.attentionId, { state: 'superseded' })
    return open
  }

  listOpen(ticketId?: string): AttentionView[] {
    return this.store.listAttentions(ticketId).filter((attention) => attention.state === 'open')
  }

  get(attentionId: string): AttentionView | undefined {
    return this.store.getAttention(attentionId)
  }

  /** 通知回执视图，供 demo / eval 展示；不属于回答判定。 */
  listNotifications(ticketId?: string): readonly NotificationReceipt[] {
    return this.store.listNotificationReceipts(ticketId)
  }
}
