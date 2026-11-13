/**
 * 介入计划：把已通过 submitAssessment 的提案落成持久状态。
 * - wait：持久化“等什么 + 最晚重新判断时间”；同一 task 版本+assignment 只有一个活动等待，
 *   重判只能提前、不能把最晚时间往后推（防止无限等待）。
 * - ask(不可合并/截止风险)：立即通知；ask(可合并)/digest：进入当前开放的合并通知，
 *   合并通知的送达时间 = 成员最晚送达时间中的最早者（保证每个成员都不迟到）。
 * - 合并通知内部保留每个任务的 decisionId/taskRevision/assignmentId；打开≠回答；
 *   单个成员被新证据撤销时其他成员不丢。
 * - 相同状态（任务版本、类型、理由、证据）不重复通知。
 * 不新增阈值：时间全部来自模型提案中带证据的 wakeAt/deadlineAt/deliverAt。
 */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { AssessmentRecord, Proposal, SubmitResult } from './assess.ts'

export interface WaitRow {
  readonly waitId: string
  readonly taskId: string
  readonly taskRevision: number
  readonly assignmentId: string | null
  readonly reasonCode: string
  readonly waitFor: string
  readonly recheckAt: string
  readonly createdAt: string
  readonly status: 'waiting' | 'due' | 'resolved' | 'cancelled'
  readonly note: string
}

export interface BundleMember {
  readonly decisionId: string
  readonly taskId: string
  readonly taskRevision: number
  readonly assignmentId: string | null
  readonly kind: 'ask' | 'digest'
  readonly reasonCode: string
  readonly question: string | null
  readonly evidence: readonly string[]
  readonly deliverBy: string
  readonly status: 'pending' | 'answered' | 'withdrawn'
  readonly answer: string | null
}

export interface NoticeRow {
  readonly noticeId: string
  readonly mode: 'immediate' | 'bundle'
  readonly deliverAt: string
  readonly status: 'open' | 'delivered' | 'closed'
  readonly seenAt: string | null
  readonly members: readonly BundleMember[]
}

export type PlanOutcome =
  | { readonly type: 'rejected'; readonly code: string }
  | { readonly type: 'waiting'; readonly wait: WaitRow }
  | { readonly type: 'notified'; readonly notice: NoticeRow; readonly decisionId: string }
  | { readonly type: 'suppressed_duplicate'; readonly decisionId: string }
  | { readonly type: 'execute'; readonly optionId: string; readonly decisionId: string }
  | { readonly type: 'none' }

const t = (s: string) => Date.parse(s)
const minIso = (a: string, b: string) => (t(a) <= t(b) ? a : b)

export class InterventionStore {
  readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS cap_assessments (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, task_id TEXT NOT NULL, identity TEXT NOT NULL, raw_text TEXT, model TEXT, session_id TEXT, proposal TEXT, submit TEXT, outcome TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cap_waits (wait_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, json TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cap_notices (notice_id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cap_decision_keys (dedupe_key TEXT PRIMARY KEY, decision_id TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cap_cancelled_tasks (task_id TEXT PRIMARY KEY, at TEXT NOT NULL);
    `)
  }

  /** guard 前提案与 guard 后结果两层都写入，便于“guard 前错误”统计。 */
  logAssessment(record: AssessmentRecord, submit: SubmitResult | null, outcome: PlanOutcome | null, at: string): void {
    this.db.prepare('INSERT INTO cap_assessments (request_id, task_id, identity, raw_text, model, session_id, proposal, submit, outcome, at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      record.request.requestId, record.identity.taskId, JSON.stringify(record.identity), record.rawText, JSON.stringify(record.model), record.sessionId,
      JSON.stringify(record.proposal), JSON.stringify(submit), JSON.stringify(outcome), at,
    )
  }

  assessments(): any[] {
    return this.db.prepare('SELECT * FROM cap_assessments ORDER BY seq').all() as any[]
  }

  waits(): WaitRow[] {
    return (this.db.prepare('SELECT json FROM cap_waits').all() as any[]).map((r) => JSON.parse(r.json))
  }
  private saveWait(w: WaitRow): void {
    this.db.prepare('INSERT INTO cap_waits (wait_id, task_id, json, status) VALUES (?,?,?,?) ON CONFLICT(wait_id) DO UPDATE SET json = excluded.json, status = excluded.status').run(w.waitId, w.taskId, JSON.stringify(w), w.status)
  }
  notices(): NoticeRow[] {
    return (this.db.prepare('SELECT json FROM cap_notices').all() as any[]).map((r) => JSON.parse(r.json))
  }
  private saveNotice(n: NoticeRow): void {
    this.db.prepare('INSERT INTO cap_notices (notice_id, json, status) VALUES (?,?,?) ON CONFLICT(notice_id) DO UPDATE SET json = excluded.json, status = excluded.status').run(n.noticeId, JSON.stringify(n), n.status)
  }
  isCancelled(taskId: string): boolean {
    return this.db.prepare('SELECT 1 FROM cap_cancelled_tasks WHERE task_id = ?').get(taskId) !== undefined
  }

  /** 把已提交的评估落成介入状态。submit 未通过时只记录，不产生任何提醒或执行。 */
  apply(record: AssessmentRecord, submit: SubmitResult, now: string): PlanOutcome {
    const outcome = this.applyInner(record, submit, now)
    this.logAssessment(record, submit, outcome, now)
    return outcome
  }

  private applyInner(record: AssessmentRecord, submit: SubmitResult, now: string): PlanOutcome {
    if (!submit.accepted || !submit.proposal) return { type: 'rejected', code: submit.code }
    const p: Proposal = submit.proposal
    const id = record.identity
    if (this.isCancelled(id.taskId)) return { type: 'rejected', code: 'task_cancelled' }
    const evidence = [...p.evidenceTurnIds, ...p.evidenceItemIds].sort()
    const dedupeKey = createHash('sha256').update(JSON.stringify([id.taskId, id.taskRevision, id.assignmentId, p.kind, p.reasonCode, evidence, p.optionIds])).digest('hex').slice(0, 24)
    const decisionId = `dec-${dedupeKey.slice(0, 16)}`

    if (p.kind === 'none') return { type: 'none' }
    if (p.kind === 'wait') {
      const waitId = `wait-${createHash('sha256').update(JSON.stringify([id.taskId, id.taskRevision, id.assignmentId])).digest('hex').slice(0, 16)}`
      const prior = this.waits().find((w) => w.waitId === waitId)
      const bound = p.deadlineAt ? minIso(p.wakeAt!, p.deadlineAt) : p.wakeAt!
      const recheckAt = prior && (prior.status === 'waiting' || prior.status === 'due') ? minIso(prior.recheckAt, bound) : bound
      const wait: WaitRow = {
        waitId, taskId: id.taskId, taskRevision: id.taskRevision, assignmentId: id.assignmentId, reasonCode: p.reasonCode,
        waitFor: p.waitFor ?? '(unspecified)', recheckAt, createdAt: prior?.createdAt ?? now, status: 'waiting',
        note: prior ? `rejudged_at:${now}${recheckAt !== bound ? ':kept_earlier_bound' : ''}` : 'created',
      }
      this.saveWait(wait)
      return { type: 'waiting', wait }
    }
    // 新的 ask/digest/act 说明不再等待：结束本任务的等待
    for (const w of this.waits()) if (w.taskId === id.taskId && (w.status === 'waiting' || w.status === 'due')) this.saveWait({ ...w, status: 'resolved', note: `superseded_by:${p.kind}@${now}` })
    // 同一任务的旧版本成员撤回（新证据改变了问题），其他任务成员保留
    this.withdrawTaskMembers(id.taskId, (m) => m.taskRevision !== id.taskRevision || m.assignmentId !== id.assignmentId, `stale_version@${now}`)

    if (this.db.prepare('SELECT 1 FROM cap_decision_keys WHERE dedupe_key = ?').get(dedupeKey)) return { type: 'suppressed_duplicate', decisionId }
    this.db.prepare('INSERT INTO cap_decision_keys (dedupe_key, decision_id, at) VALUES (?,?,?)').run(dedupeKey, decisionId, now)
    // 同任务同版本的其他未答问题被新的判断取代
    this.withdrawTaskMembers(id.taskId, (m) => m.decisionId !== decisionId, `replaced_by:${decisionId}`)

    if (p.kind === 'act') return { type: 'execute', optionId: p.optionIds[0]!, decisionId }

    const member: BundleMember = {
      decisionId, taskId: id.taskId, taskRevision: id.taskRevision, assignmentId: id.assignmentId,
      kind: p.kind, reasonCode: p.reasonCode, question: p.question, evidence,
      deliverBy: p.kind === 'digest' ? (p.deliverAt ?? p.deadlineAt ?? now) : (p.deliverAt ?? p.deadlineAt ?? now),
      status: 'pending', answer: null,
    }
    const immediate = p.kind === 'ask' && (!p.batchable || p.reasonCode === 'deadline_risk' || !p.deliverAt)
    if (immediate) {
      const notice: NoticeRow = { noticeId: `ntc-${decisionId.slice(4)}`, mode: 'immediate', deliverAt: now, status: 'open', seenAt: null, members: [{ ...member, deliverBy: now }] }
      this.saveNotice(notice)
      return { type: 'notified', notice, decisionId }
    }
    const open = this.notices().find((n) => n.mode === 'bundle' && n.status === 'open')
    const notice: NoticeRow = open
      ? { ...open, deliverAt: minIso(open.deliverAt, member.deliverBy), members: [...open.members, member] }
      : { noticeId: `bnd-${decisionId.slice(4)}`, mode: 'bundle', deliverAt: member.deliverBy, status: 'open', seenAt: null, members: [member] }
    this.saveNotice(notice)
    return { type: 'notified', notice, decisionId }
  }

  private withdrawTaskMembers(taskId: string, pred: (m: BundleMember) => boolean, why: string): void {
    for (const n of this.notices()) {
      if (n.status === 'closed') continue
      let changed = false
      const members = n.members.map((m) => {
        if (m.taskId === taskId && m.status === 'pending' && pred(m)) {
          changed = true
          return { ...m, status: 'withdrawn' as const, answer: why }
        }
        return m
      })
      if (changed) this.saveNotice({ ...n, members, status: members.every((m) => m.status !== 'pending') ? 'closed' : n.status })
    }
  }

  /** 真实时钟调度入口：返回到期等待（标记 due，宿主应重新 readForDecision+assess）。 */
  dueWaits(now: string): WaitRow[] {
    const out: WaitRow[] = []
    for (const w of this.waits()) {
      if (w.status === 'waiting' && t(w.recheckAt) <= t(now) && !this.isCancelled(w.taskId)) {
        const due = { ...w, status: 'due' as const, note: `due@${now}` }
        this.saveWait(due)
        out.push(due)
      }
    }
    return out
  }

  /** 到期应呈现的通知；呈现由 UI 确认（markSeen），写库不等于用户已看到。 */
  dueNotices(now: string): NoticeRow[] {
    return this.notices().filter((n) => n.status === 'open' && t(n.deliverAt) <= t(now) && n.members.some((m) => m.status === 'pending'))
  }

  /** 下一次需要唤醒的时刻（等待到期或合并通知送达），供宿主 RealClock 调度。 */
  nextWakeAt(): string | null {
    const times = [
      ...this.waits().filter((w) => w.status === 'waiting' && !this.isCancelled(w.taskId)).map((w) => w.recheckAt),
      ...this.notices().filter((n) => n.status === 'open').map((n) => n.deliverAt),
    ]
    return times.length === 0 ? null : times.reduce(minIso)
  }

  markSeen(noticeId: string, at: string): void {
    const n = this.notices().find((x) => x.noticeId === noticeId)
    if (n) this.saveNotice({ ...n, status: 'delivered', seenAt: n.seenAt ?? at })
  }

  /** 只回答一个成员；其余成员保持 pending。 */
  answer(noticeId: string, decisionId: string, answer: string): boolean {
    const n = this.notices().find((x) => x.noticeId === noticeId)
    if (!n) return false
    const m = n.members.find((x) => x.decisionId === decisionId)
    if (!m || m.status !== 'pending' || this.isCancelled(m.taskId)) return false
    const members = n.members.map((x) => (x.decisionId === decisionId ? { ...x, status: 'answered' as const, answer } : x))
    this.saveNotice({ ...n, members, status: members.every((x) => x.status !== 'pending') ? 'closed' : n.status })
    return true
  }

  /** 新证据到来：结束本任务等待并撤回本任务未答成员（宿主随后重新评估）。 */
  evidenceArrived(taskId: string, at: string, what: string): void {
    for (const w of this.waits()) if (w.taskId === taskId && (w.status === 'waiting' || w.status === 'due')) this.saveWait({ ...w, status: 'resolved', note: `evidence:${what}@${at}` })
    this.withdrawTaskMembers(taskId, () => true, `new_evidence:${what}@${at}`)
  }

  cancelTask(taskId: string, at: string): void {
    this.db.prepare('INSERT OR IGNORE INTO cap_cancelled_tasks (task_id, at) VALUES (?,?)').run(taskId, at)
    for (const w of this.waits()) if (w.taskId === taskId && (w.status === 'waiting' || w.status === 'due')) this.saveWait({ ...w, status: 'cancelled', note: `cancelled@${at}` })
    this.withdrawTaskMembers(taskId, () => true, `cancelled@${at}`)
  }
}
