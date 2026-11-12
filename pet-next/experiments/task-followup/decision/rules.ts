/**
 * 四种冻结策略的透明确定性规则实现（scripted-rule）。
 *
 * P0 只记录（静默下界）
 * P1 每个有效事件都提醒（弱基线）
 * P2 强规则阈值 + 冷却 + 静默 + 事件去重（主基线）
 * P3 当前任务决策变化 + 证据绑定 + 问题合并（本轮方法）
 *
 * 共同点（避免给基线制造基础故障）：
 * - 都只通过 DecisionPort 提出建议，执行/取消/旧版本拦截由 runtime 统一执行；
 * - 收到用户明确回答后，都必须能触发本地分析，不因策略而失去完成能力；
 * - 都不读取评分期望，也不按用例 id 分支，不调用模型。
 *
 * @module pet-next/experiments/task-followup/decision
 */
import {
  DECISION_RULE_VERSION,
  DEFAULT_TIMEZONE,
  configSha,
  isQuietAt,
  millisBetween,
  nextZonedHour,
  quietEndsAt,
  stableId,
} from '../contracts.ts'
import type {
  AttentionOption,
  DecisionContext,
  DecisionKind,
  DecisionPort,
  PolicyId,
  ProposedDecision,
  QuietConfig,
  ToolRequest,
} from '../contracts.ts'

export interface PolicyConfig {
  /** P2 的冻结阈值：失败比例达到即提醒。 */
  readonly failureThreshold: number
  readonly cooldownMs: number
  readonly quiet: QuietConfig
}

export const FROZEN_CONFIG: PolicyConfig = {
  failureThreshold: 0.15,
  cooldownMs: 30 * 60_000,
  quiet: {
    timezone: DEFAULT_TIMEZONE,
    fromHour: 23,
    toHour: 7,
    allowUrgent: false,
    reminderQuotaPerHour: 3,
    minGapMs: 15 * 60_000,
    cooldownMs: 30 * 60_000,
    deadlineHour: 9,
  },
}

const ANALYZE_OPTION: AttentionOption = { id: 'analyze_failing', label: '分析失败样本' }
const WAIT_OPTION: AttentionOption = { id: 'wait_more', label: '继续等待更多结果' }
const ACCEPT_OPTION: AttentionOption = { id: 'accept_current', label: '接受当前结果' }
const RETRY_OPTION: AttentionOption = { id: 'retry_analysis', label: '重试本地分析' }
const ACCEPT_NO_ANALYSIS: AttentionOption = { id: 'accept_without_analysis', label: '不分析直接收尾' }
const CONTINUE_OPTION: AttentionOption = { id: 'continue_waiting', label: '继续跟进' }
const STOP_OPTION: AttentionOption = { id: 'stop_task', label: '停止任务' }

interface NecessaryDecision {
  readonly decisionKey: string
  readonly question: string
  readonly options: readonly AttentionOption[]
  readonly reasonCode: string
  readonly reasonText: string
  readonly deadline?: string
}

function writeAnalysisRequest(context: DecisionContext): ToolRequest {
  const result = context.task.result
  return {
    tool: 'write_analysis',
    args: {
      runId: result?.runId ?? 'unknown',
      revision: result?.revision ?? 0,
      resultPath: result?.resultPath ?? '',
      failed: result?.metrics.failed ?? 0,
      total: result?.metrics.total ?? 0,
    },
  }
}

/** 截止时刻按显式时区计算，不用宿主 getHours/setHours。 */
function deadlineAt(now: string, hour: number, timeZone: string): string {
  return nextZonedHour(now, hour, timeZone)
}

function sha8(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : 'unknown'
}

/** 当前状态真正需要用户做的决定；没有就返回 null。 */
function necessaryDecision(context: DecisionContext): NecessaryDecision | null {
  const task = context.task
  const result = task.result
  if (!result) return null
  const conflict = [...task.diagnostics].reverse().find((item) => item.startsWith('evidence_conflict'))
  if (conflict) {
    return {
      decisionKey: `conflict:${result.runId}:r${result.revision}`,
      question: `同一结果 ${result.runId} r${result.revision} 出现了不同 SHA（当前采用 ${sha8(result.artifactSha)}）。以哪个文件为准？`,
      options: [
        { id: 'use_latest', label: '采用最新观察到的文件' },
        { id: 'keep_current', label: '保留当前已核验版本' },
      ],
      reasonCode: 'evidence_conflict',
      reasonText: '同一 revision 的证据内容冲突，需要具体选择',
      deadline: deadlineAt(context.now, context.quiet.deadlineHour, context.quiet.timezone),
    }
  }
  // 已知的“执行前拒绝”：只有当前输入恢复后才提出重新授权问题。
  const continuation = task.continuation
  if (continuation && context.inputReady) {
    return {
      decisionKey: `continuation:${result.runId}:r${result.revision}:a${continuation.attempt}`,
      question: `上次的本地分析在执行前被输入校验拒绝（${continuation.detail}）。当前输入已恢复，要现在重新授权执行吗？`,
      options: [RETRY_OPTION, ACCEPT_NO_ANALYSIS],
      reasonCode: 'input_rejected_retry',
      reasonText: '已知的输入拒绝需要一次新的明确授权',
      deadline: deadlineAt(context.now, context.quiet.deadlineHour, context.quiet.timezone),
    }
  }
  const last = task.diagnostics.at(-1) ?? ''
  if (last.startsWith('tool_failed:')) {
    return {
      decisionKey: `tool_failed:${result.runId}:r${result.revision}`,
      question: `本地分析失败（${last}）。要显式重试，还是不分析直接收尾？`,
      options: [RETRY_OPTION, ACCEPT_NO_ANALYSIS],
      reasonCode: 'tool_failed',
      reasonText: '工具失败已记录，等待明确的下一步',
      deadline: deadlineAt(context.now, context.quiet.deadlineHour, context.quiet.timezone),
    }
  }
  const insufficient = task.goalCondition.insufficientStatuses.includes(result.status as 'succeeded' | 'failed' | 'partial')
  if (insufficient && !task.analysis) {
    return {
      decisionKey: `insufficient:${result.runId}:r${result.revision}`,
      question: `${result.runId} r${result.revision} 结果不足：${result.metrics.failed}/${result.metrics.total} 失败（sha ${sha8(result.artifactSha)}，${result.artifactPath ?? '无产物'}）。现在要做什么？`,
      options: [ANALYZE_OPTION, ACCEPT_OPTION, WAIT_OPTION],
      reasonCode: 'insufficient_result',
      reasonText: '结果不足以完成目标，存在真实的下一步选择',
      deadline: deadlineAt(context.now, context.quiet.deadlineHour, context.quiet.timezone),
    }
  }
  return null
}

function answerRequestsAnalysis(context: DecisionContext): boolean {
  const answer = context.task.lastAnswer
  if (!answer) return false
  if (answer.optionId !== 'analyze_failing' && answer.optionId !== 'retry_analysis') return false
  if (context.task.analysis) return false
  // 已经尝试并失败的同一次分析请求不再自动重做；失败要留给明确的选择。
  const last = context.task.diagnostics.at(-1) ?? ''
  if (last.startsWith('tool_failed:')) return false
  return true
}

function userAskedToWait(context: DecisionContext): boolean {
  return context.task.lastAnswer?.optionId === 'wait_more'
}

function lastAsk(context: DecisionContext, decisionKey: string): string | null {
  const rows = context.history
    .filter((item) => item.kind === 'ask_user' && item.decisionKey === decisionKey && item.outcome !== 'invalidated')
    .map((item) => item.createdAt)
    .sort()
  return rows.at(-1) ?? null
}

function buildProposal(
  policy: PolicyId,
  context: DecisionContext,
  kind: DecisionKind,
  reasonCode: string,
  reasonText: string,
  extra: Partial<ProposedDecision> = {},
): ProposedDecision {
  const task = context.task
  const decisionKey = extra.decisionKey ?? `${policy}:${reasonCode}:${task.taskRevision}`
  return {
    decisionId: stableId(
      'dec',
      policy,
      task.ticketId,
      task.taskRevision,
      kind,
      decisionKey,
      reasonCode,
      String(task.attempt),
      extra.question ?? '',
    ),
    ticketId: task.ticketId,
    taskRevision: task.taskRevision,
    assignmentId: task.assignmentId ?? '',
    evidenceRefs: context.evidence.slice(-2),
    kind,
    reasonCode,
    reasonText,
    decisionKey,
    implementation: 'scripted-rule',
    ...extra,
  }
}

function askFromNecessary(
  policy: PolicyId,
  context: DecisionContext,
  necessary: NecessaryDecision,
  decisionKey = necessary.decisionKey,
): ProposedDecision {
  return buildProposal(policy, context, 'ask_user', necessary.reasonCode, necessary.reasonText, {
    decisionKey,
    question: necessary.question,
    options: necessary.options,
    ...(necessary.deadline ? { deadline: necessary.deadline } : {}),
  })
}

function analysisProposal(policy: PolicyId, context: DecisionContext, code: string): ProposedDecision {
  return buildProposal(policy, context, 'continue_local', code, '按用户选择生成失败样本分析产物', {
    decisionKey: `analysis:${context.task.taskRevision}`,
    toolRequest: writeAnalysisRequest(context),
  })
}

function recordOnly(policy: PolicyId, context: DecisionContext, code: string, text: string): ProposedDecision {
  return buildProposal(policy, context, 'record_only', code, text)
}

function defer(policy: PolicyId, context: DecisionContext, code: string, text: string, notBefore: string): ProposedDecision {
  return buildProposal(policy, context, 'defer', code, text, { decisionKey: `defer:${code}`, notBefore })
}

/** 用户已经做出选择时，各策略都必须执行同一个动作；这是共享能力，不是策略差异。 */
function answeredAction(policy: PolicyId, context: DecisionContext): ProposedDecision | null {
  if (!answerRequestsAnalysis(context)) return null
  return analysisProposal(policy, context, context.task.lastAnswer?.optionId === 'retry_analysis' ? 'retry_requested' : 'analysis_requested')
}

/** 输入尚未恢复时先不提问：避免制造一个必然被拒绝的问题。 */
function continuationWait(policy: PolicyId, context: DecisionContext): ProposedDecision | null {
  if (!context.task.continuation || context.inputReady) return null
  return defer(
    policy,
    context,
    'continuation_wait_input',
    '上次执行被输入校验拒绝，当前输入尚未恢复，先等待可核验的当前版本',
    new Date(Date.parse(context.now) + 10 * 60_000).toISOString(),
  )
}

function proposeP0(context: DecisionContext): ProposedDecision[] {
  return [recordOnly('P0', context, 'record_only', 'P0 只记录当前事实，不主动打扰')]
}

function proposeP1(context: DecisionContext): ProposedDecision[] {
  const action = answeredAction('P1', context)
  if (action) return [action]
  const waitingForInput = continuationWait('P1', context)
  if (waitingForInput) return [waitingForInput]
  const necessary = necessaryDecision(context)
  if (necessary) return [askFromNecessary('P1', context, necessary, `P1:${necessary.decisionKey}`)]
  return [
    buildProposal('P1', context, 'ask_user', 'event_reminder', '每个有效事件都提醒一次', {
      decisionKey: `P1:event:${context.task.eventCursor}`,
      question: `有新信息到达（任务 ${context.task.title}）。继续跟进吗？`,
      options: [CONTINUE_OPTION, STOP_OPTION],
    }),
  ]
}

function proposeP2(context: DecisionContext, config: PolicyConfig): ProposedDecision[] {
  const action = answeredAction('P2', context)
  if (action) return [action]
  const waitingForInput = continuationWait('P2', context)
  if (waitingForInput) return [waitingForInput]
  const task = context.task
  if (!task.result) {
    return [defer('P2', context, 'awaiting_result', '还没有结果，继续等待', new Date(Date.parse(context.now) + 10 * 60_000).toISOString())]
  }
  if (userAskedToWait(context)) {
    return [defer('P2', context, 'user_wait', '用户选择继续等待', new Date(Date.parse(context.now) + 30 * 60_000).toISOString())]
  }
  const total = Math.max(1, task.result.metrics.total)
  const ratio = task.result.metrics.failed / total
  const necessary = necessaryDecision(context)
  if (ratio < config.failureThreshold || !necessary) {
    return [recordOnly('P2', context, necessary ? 'below_threshold' : 'no_decision_needed', `失败比例 ${ratio.toFixed(2)} 未达冻结阈值 ${config.failureThreshold}`)]
  }
  if (isQuietAt(context.now, config.quiet)) {
    return [defer('P2', context, 'quiet_defer', '显式静默时段，延后到静默结束', quietEndsAt(context.now, config.quiet))]
  }
  const eventKey = `P2:threshold:${task.result.runId}`
  const last = lastAsk(context, eventKey)
  if (last && millisBetween(last, context.now) < config.cooldownMs) {
    return [
      defer(
        'P2',
        context,
        'cooldown',
        '同一 runId 的提醒仍在冷却',
        new Date(Date.parse(last) + config.cooldownMs).toISOString(),
      ),
    ]
  }
  return [askFromNecessary('P2', context, necessary, eventKey)]
}

function proposeP3(context: DecisionContext, config: PolicyConfig): ProposedDecision[] {
  const task = context.task
  const action = answeredAction('P3', context)
  if (action) return [action]
  const waitingForInput = continuationWait('P3', context)
  if (waitingForInput) return [waitingForInput]
  if (context.goalSatisfied) {
    return [buildProposal('P3', context, 'notify_result', 'goal_satisfied', '目标条件已满足', { decisionKey: 'goal_satisfied' })]
  }
  if (!task.result) {
    return [defer('P3', context, 'awaiting_result', '还没有结果，保留待办并继续观察', new Date(Date.parse(context.now) + 10 * 60_000).toISOString())]
  }
  if (userAskedToWait(context)) {
    return [defer('P3', context, 'user_wait', '用户选择继续等待', new Date(Date.parse(context.now) + 30 * 60_000).toISOString())]
  }
  const necessary = necessaryDecision(context)
  if (!necessary) {
    return [recordOnly('P3', context, 'no_decision_needed', '当前没有需要用户决定的问题')]
  }
  const last = lastAsk(context, necessary.decisionKey)
  if (last && millisBetween(last, context.now) < config.cooldownMs) {
    return [
      defer('P3', context, 'cooldown', '同一决策仍在冷却', new Date(Date.parse(last) + config.cooldownMs).toISOString()),
    ]
  }
  return [askFromNecessary('P3', context, necessary)]
}

export function createPolicy(id: PolicyId, overrides: Partial<PolicyConfig> = {}): DecisionPort {
  const config: PolicyConfig = { ...FROZEN_CONFIG, ...overrides, quiet: { ...FROZEN_CONFIG.quiet, ...(overrides.quiet ?? {}) } }
  return {
    id,
    implementation: 'scripted-rule',
    configSha: configSha({ rule: DECISION_RULE_VERSION, id, config }),
    propose: (context) => {
      switch (id) {
        case 'P0':
          return proposeP0(context)
        case 'P1':
          return proposeP1(context)
        case 'P2':
          return proposeP2(context, config)
        case 'P3':
          return proposeP3(context, config)
        default:
          return [recordOnly('P0', context, 'unknown_policy', '未知策略按只记录处理')]
      }
    },
  }
}

export function policyConfig(): PolicyConfig {
  return { ...FROZEN_CONFIG, quiet: { ...FROZEN_CONFIG.quiet } }
}
