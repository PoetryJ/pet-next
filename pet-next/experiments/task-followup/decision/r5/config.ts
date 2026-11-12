/**
 * R5 强简单规则（NeedRule / N1）的冻结参数。
 *
 * 这些值在跑 12 条 R5 故事之前写定，之后不得为了“赢”而调整。
 * 与 R4 的 P0–P3 参数完全分离；R4 的 FROZEN_CONFIG 不被引用、不被修改。
 *
 * @module pet-next/experiments/task-followup/decision/r5/config
 */
export interface NeedRuleConfig {
  /** 同一 decisionKey 的再次提问冷却。 */
  readonly cooldownMs: number
  /** 没有可决策事实时的重判间隔。 */
  readonly idleWaitMs: number
  /** 用户明确要求等待时的重判间隔。 */
  readonly userWaitMs: number
  /** 进度汇总的本地截止小时（超过则不再发汇总）。 */
  readonly digestDeadlineHour: number
  /** 同一结果修订只发一次进度汇总。 */
  readonly oneDigestPerRevision: true
}

export const NEED_RULE_CONFIG: NeedRuleConfig = Object.freeze({
  cooldownMs: 20 * 60_000,
  idleWaitMs: 10 * 60_000,
  userWaitMs: 30 * 60_000,
  digestDeadlineHour: 22,
  oneDigestPerRevision: true,
})

export const NEED_RULE_ID = 'N1' as const

/** 冻结说明：给报告直接引用，避免口头解释。 */
export const NEED_RULE_DOC = {
  id: NEED_RULE_ID,
  name: 'NeedRule',
  description: '只在存在真实待决问题时询问；普通进度只发一次有期限的汇总；遵守静默/额度/冷却；问题失效即撤回。',
  whyWait: 'defer 提案带 notBefore 与可读理由，持久唤醒按它到期；到期只重判，不执行旧调用。',
  doesNotUse: ['gold', '未来结果', '模型', '未回复反馈'],
} as const
