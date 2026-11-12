/**
 * R5 强简单基线 NeedRule（N1）。
 *
 * 与 P3 共享：执行器、记忆事实、可见性、时区/额度、持久调度。
 * 不共享：P3 的失败阈值/冷却实现（这里用自己的冻结参数）。
 *
 * 规则（先冻结，再看结果）：
 * 1. 有真实待决问题（冲突/工具失败/结果不足/已知输入拒绝且已恢复）才询问；
 * 2. 普通进度只发一次有期限的汇总（同一结果修订只一次）；
 * 3. 用户明确要求等待 → 按其选择等待；
 * 4. 其余情况只记录并给出下一次重判时间；
 * 5. 不读 gold、不读未来结果、不把未回复当反馈。
 *
 * @module pet-next/experiments/task-followup/decision/r5/need-rule
 */
import { configSha, millisBetween, stableId } from '../../contracts.ts'
import type {
  AttentionOption,
  DecisionContext,
  DecisionPort,
  ProposedDecision,
  QuietConfig,
} from '../../contracts.ts'
import { NEED_RULE_CONFIG, NEED_RULE_DOC, NEED_RULE_ID } from './config.ts'

const ANALYZE_OPTION: AttentionOption = { id: 'analyze_failing', label: '分析失败样本' }
const ACCEPT_OPTION: AttentionOption = { id: 'accept_current', label: '接受当前结果' }
const WAIT_OPTION: AttentionOption = { id: 'wait_more', label: '继续等待更多结果' }
const RETRY_OPTION: AttentionOption = { id: 'retry_analysis', label: '重新授权分析' }
const STOP_OPTION: AttentionOption = { id: 'cancel_task', label: '取消这个任务' }
const USE_LATEST: AttentionOption = { id: 'use_latest', label: '采用最新观察到的文件' }
const KEEP_CURRENT: AttentionOption = { id: 'keep_current', label: '保留当前已核验版本' }

interface Necessary {
  readonly decisionKey: string
  readonly question: string
  readonly options: readonly AttentionOption[]
  readonly reasonCode: string
  readonly reasonText: string
  readonly deadline?: string
}

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

function sha8(value: string | null | undefined): string {
  return value ? value.slice(0, 8) : 'none'
}

function lastAsk(context: DecisionContext, decisionKey: string): string | null {
  const rows = context.history.filter((item) => item.decisionKey === decisionKey && item.kind === 'ask_user')
  return rows.length ? rows[rows.length - 1]!.createdAt : null
}

function proposal(
  context: DecisionContext,
  kind: ProposedDecision['kind'],
  code: string,
  text: string,
  extra: Partial<ProposedDecision> = {},
): ProposedDecision {
  const ticketId = context.task.ticketId
  const taskRevision = context.task.taskRevision
  const decisionId = stableId('dec', NEED_RULE_ID, ticketId, taskRevision, code, context.now, context.task.eventCursor)
  return {
    decisionId,
    ticketId,
    taskRevision,
    assignmentId: context.task.assignmentId ?? '',
    evidenceRefs: context.evidence,
    kind,
    reasonCode: code,
    reasonText: text,
    implementation: 'scripted-rule',
    ...extra,
  }
}

function defer(context: DecisionContext, code: string, text: string, notBefore: string): ProposedDecision {
  return proposal(context, 'defer', code, text, { decisionKey: `defer:${code}`, notBefore })
}

function necessaryDecision(context: DecisionContext): Necessary | null {
  const task = context.task
  const result = task.result
  if (!result) return null
  const deadline = plus(context.now, 6 * 60 * 60_000)
  const conflict = [...task.diagnostics].reverse().find((item) => item.startsWith('evidence_conflict'))
  if (conflict) {
    return {
      decisionKey: `conflict:${result.runId}:r${result.revision}`,
      question: `同一结果 ${result.runId} r${result.revision} 出现了不同 SHA（当前采用 ${sha8(result.artifactSha)}）。以哪个文件为准？`,
      options: [USE_LATEST, KEEP_CURRENT],
      reasonCode: 'evidence_conflict',
      reasonText: '同一 revision 的证据内容冲突，需要具体选择',
      deadline,
    }
  }
  const continuation = task.continuation
  if (continuation && context.inputReady) {
    return {
      decisionKey: `continuation:${result.runId}:r${result.revision}:a${continuation.attempt}`,
      question: `上次的本地分析在执行前被输入校验拒绝（${continuation.detail}）。当前输入已恢复，要现在重新授权执行吗？`,
      options: [RETRY_OPTION, ACCEPT_OPTION],
      reasonCode: 'input_rejected_retry',
      reasonText: '已知的输入拒绝需要一次新的明确授权',
      deadline,
    }
  }
  const last = task.diagnostics.at(-1) ?? ''
  if (last.startsWith('tool_failed:')) {
    return {
      decisionKey: `tool_failed:${result.runId}:r${result.revision}`,
      question: `本地分析失败（${last}）。要显式重试，还是不分析直接收尾？`,
      options: [RETRY_OPTION, ACCEPT_OPTION],
      reasonCode: 'tool_failed',
      reasonText: '工具失败已记录，等待明确的下一步',
      deadline,
    }
  }
  const insufficient = task.goalCondition.insufficientStatuses.includes(result.status as 'failed' | 'partial' | 'succeeded')
  if (insufficient && !task.analysis) {
    return {
      decisionKey: `insufficient:${result.runId}:r${result.revision}`,
      question: `${result.runId} r${result.revision} 结果不足：${result.metrics.failed}/${result.metrics.total} 失败（sha ${sha8(result.artifactSha)}，${result.artifactPath ?? '无产物'}）。现在要做什么？`,
      options: [ANALYZE_OPTION, ACCEPT_OPTION, WAIT_OPTION],
      reasonCode: 'insufficient_result',
      reasonText: '结果不足以完成目标，存在真实的下一步选择',
      deadline,
    }
  }
  return null
}

export function createNeedRule(overrides: { readonly quiet: QuietConfig }): DecisionPort {
  const config = { ...NEED_RULE_CONFIG, quiet: overrides.quiet }
  return {
    id: NEED_RULE_ID,
    implementation: 'scripted-rule',
    configSha: configSha({ rule: 'need-rule/v1', ...config }),
    propose(context: DecisionContext): readonly ProposedDecision[] {
      const task = context.task
      // 用户已经授权分析：共享同一执行动作，不在这里做策略差异。
      if (task.lastAnswer && ['analyze_failing', 'retry_analysis'].includes(task.lastAnswer.optionId)) {
        return [
          proposal(context, 'continue_local', 'analysis_requested', '用户已授权本地分析', {
            decisionKey: 'analysis_requested',
            toolRequest: {
              tool: 'write_analysis',
              args: {
                runId: task.result?.runId ?? 'unknown',
                revision: task.result?.revision ?? 0,
                resultPath: task.result?.resultPath ?? '',
                failed: task.result?.metrics.failed ?? 0,
                total: task.result?.metrics.total ?? 0,
              },
            },
          }),
        ]
      }
      if (task.continuation && !context.inputReady) {
        return [defer(context, 'continuation_wait_input', '上次分析被输入校验拒绝，等输入恢复后再问', plus(context.now, config.idleWaitMs))]
      }
      // 用户已经明确要求等待：优先于任何新的“必要问题”，等到用户回来。
      if (task.lastAnswer?.optionId === 'wait_more') {
        return [defer(context, 'user_wait', '用户选择继续等待', plus(context.now, config.userWaitMs))]
      }
      const necessary = necessaryDecision(context)
      if (necessary) {
        const cooldownAnchor = lastAsk(context, necessary.decisionKey)
        if (cooldownAnchor && millisBetween(cooldownAnchor, context.now) < config.cooldownMs) {
          return [defer(context, 'cooldown', '同一决策仍在冷却', plus(cooldownAnchor, config.cooldownMs))]
        }
        return [
          proposal(context, 'ask_user', necessary.reasonCode, necessary.reasonText, {
            decisionKey: necessary.decisionKey,
            question: necessary.question,
            options: necessary.options,
            deadline: necessary.deadline,
          }),
        ]
      }
      if (!task.result) {
        return [defer(context, 'awaiting_result', '还没有结果，等下一次重判', plus(context.now, config.idleWaitMs))]
      }
      // 普通进度：同一结果修订只发一次有期限的汇总。
      const digestKey = `digest:${task.result.runId}:r${task.result.revision}`
      if (!lastAsk(context, digestKey) && !context.history.some((item) => item.decisionKey === digestKey)) {
        return [
          proposal(context, 'notify_result', 'progress_digest', `已拿到 ${task.result.runId} r${task.result.revision} 的结果，先做一次进度汇总`, {
            decisionKey: digestKey,
            deadline: plus(context.now, 6 * 60 * 60_000),
          }),
        ]
      }
      return [defer(context, 'idle', '当前没有需要用户决定的问题', plus(context.now, config.idleWaitMs))]
    },
  }
}

export { NEED_RULE_CONFIG, NEED_RULE_DOC, NEED_RULE_ID }
