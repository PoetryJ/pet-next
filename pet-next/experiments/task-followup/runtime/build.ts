/**
 * 运行时组装：CLI / demo / eval 共用同一套端口实现，避免各写一份入口。
 *
 * @module pet-next/experiments/task-followup/runtime/build
 */
import { join } from 'node:path'
import { AttentionQueue } from '../attention/port.ts'
import { createPolicy } from '../decision/rules.ts'
import { R31MemoryBridge } from '../memory-bridge/port.ts'
import { LocalTools } from '../tools/workspace.ts'
import type { ClockPort, DecisionPort, PolicyId, QuietConfig } from '../contracts.ts'
import { DEFAULT_QUIET, normalizeTimeZone } from '../contracts.ts'
import { RealClock } from './clock.ts'
import { FollowupDb } from './db.ts'
import { FollowupRuntime } from './engine.ts'

export interface BuildRuntimeOptions {
  readonly workspaceRoot: string
  readonly policy: PolicyId
  readonly dbPath?: string
  readonly clock?: ClockPort
  readonly quiet?: QuietConfig
  /** 关闭笔记派生，用于 H1 消融；默认开启。 */
  readonly deriveNotes?: boolean
  readonly validationMode?: 'full' | 'proposal-only'
  readonly deferProposals?: boolean
  readonly skipInvalidation?: boolean
  /** 记录规则提议调用次数；用于评估成本，不影响决策。 */
  readonly onPropose?: () => void
  /** R5：持久唤醒的等待间隔（毫秒）；演示用短值，评估用默认值。 */
  readonly wakeAfterMs?: number
  /** R5 对照用：直接注入策略（例如 NeedRule），不再按 policy id 构造。 */
  readonly decision?: DecisionPort
}

export interface BuiltRuntime {
  readonly runtime: FollowupRuntime
  readonly db: FollowupDb
  readonly clock: ClockPort
  readonly tools: LocalTools
  readonly attention: AttentionQueue
  readonly decision: DecisionPort
  readonly quiet: QuietConfig
  /** 运行配置指纹：规则 + quiet（含 timezone），写入 raw 便于重算。 */
  readonly configSha: string
}

export function buildRuntime(options: BuildRuntimeOptions): BuiltRuntime {
  const dbPath = options.dbPath ?? join(options.workspaceRoot, 'state', 'followup.sqlite')
  const db = new FollowupDb(dbPath)
  const clock = options.clock ?? new RealClock()
  // 时区必须显式给出：非法值直接失败，不静默回退到宿主 TZ。
  const baseQuiet = options.quiet ?? DEFAULT_QUIET
  const quiet: QuietConfig = { ...baseQuiet, timezone: normalizeTimeZone(baseQuiet.timezone) }
  const memory = new R31MemoryBridge({
    store: db,
    listEventRows: () => db.listEventRowEntries(),
    deriveNotes: options.deriveNotes ?? true,
  })
  const attention = new AttentionQueue(db)
  const tools = new LocalTools({ root: options.workspaceRoot })
  // 同一份 quiet（含 timezone）必须传给每条策略路径，P2 不再用内部默认。
  const baseDecision = options.decision ?? createPolicy(options.policy, { quiet })
  const decision: DecisionPort = {
    ...baseDecision,
    propose: (context) => {
      options.onPropose?.()
      return baseDecision.propose(context)
    },
  }
  const runtime = new FollowupRuntime({
    db,
    clock,
    memory,
    decision,
    attention,
    tools,
    quiet,
    workspace: { root: options.workspaceRoot, artifacts: tools.artifactsDir() },
    ...(options.validationMode ? { validationMode: options.validationMode } : {}),
    ...(options.deferProposals ? { deferProposals: options.deferProposals } : {}),
    ...(options.skipInvalidation ? { skipInvalidation: options.skipInvalidation } : {}),
    ...(options.wakeAfterMs === undefined ? {} : { wakeAfterMs: options.wakeAfterMs }),
  })
  return { runtime, db, clock, tools, attention, decision, quiet, configSha: decision.configSha }
}
