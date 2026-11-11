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
import { DEFAULT_QUIET } from '../contracts.ts'
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
}

export interface BuiltRuntime {
  readonly runtime: FollowupRuntime
  readonly db: FollowupDb
  readonly clock: ClockPort
  readonly tools: LocalTools
  readonly attention: AttentionQueue
  readonly decision: DecisionPort
  readonly quiet: QuietConfig
}

export function buildRuntime(options: BuildRuntimeOptions): BuiltRuntime {
  const dbPath = options.dbPath ?? join(options.workspaceRoot, 'state', 'followup.sqlite')
  const db = new FollowupDb(dbPath)
  const clock = options.clock ?? new RealClock()
  const quiet = options.quiet ?? DEFAULT_QUIET
  const memory = new R31MemoryBridge({
    store: db,
    listEventRows: () => db.listEventRowEntries(),
    deriveNotes: options.deriveNotes ?? true,
  })
  const attention = new AttentionQueue(db)
  const tools = new LocalTools({ root: options.workspaceRoot })
  const baseDecision = createPolicy(options.policy)
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
  })
  return { runtime, db, clock, tools, attention, decision, quiet }
}
