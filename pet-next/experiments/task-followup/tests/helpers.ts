/**
 * 单测共用：临时工作区 + 内存/文件 SQLite + 假时钟。
 *
 * @module pet-next/experiments/task-followup/tests/helpers
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_QUIET, sha256Bytes } from '../contracts.ts'
import type { GoalCondition, PolicyId, QuietConfig } from '../contracts.ts'
import { buildRuntime } from '../runtime/build.ts'
import type { BuiltRuntime } from '../runtime/build.ts'
import { FakeClock } from '../runtime/clock.ts'
import { seedResult } from '../tools/seed.ts'
import type { SeedInput } from '../tools/seed.ts'
import { readResultFile } from '../tools/watch.ts'

export const ANALYSIS_GOAL: GoalCondition = {
  requireResultArtifact: true,
  requireAnalysisArtifact: true,
  requireReceipt: true,
  insufficientStatuses: ['failed', 'partial'],
}

export interface Harness {
  readonly root: string
  readonly clock: FakeClock
  readonly built: BuiltRuntime
  readonly dbPath: string
  readonly quiet: QuietConfig
  readonly policy: PolicyId
  reopen(): BuiltRuntime
  seed(input?: Partial<SeedInput>): SeedInput & { resultPath: string }
  observe(ticketId: string, path: string): ReturnType<BuiltRuntime['runtime']['observe']>
  dispose(): void
}

export function harness(options: {
  policy?: PolicyId
  quiet?: QuietConfig
  fileDb?: boolean
  start?: string
  deferProposals?: boolean
} = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), 'pet-followup-test-'))
  const dbPath = options.fileDb ? join(root, 'state', 'db.sqlite') : ':memory:'
  const clock = new FakeClock(options.start ?? '2026-11-11T08:00:00.000Z')
  const quiet = options.quiet ?? DEFAULT_QUIET
  const policy = options.policy ?? 'P3'
  let built = buildRuntime({ workspaceRoot: root, policy, dbPath, clock, quiet, ...(options.deferProposals ? { deferProposals: true } : {}) })
  let lastSeed: SeedInput | null = null
  return {
    root,
    clock,
    get built() {
      return built
    },
    dbPath,
    quiet,
    policy,
    reopen() {
      built.db.close()
      built = buildRuntime({ workspaceRoot: root, policy, dbPath, clock, quiet, ...(options.deferProposals ? { deferProposals: true } : {}) })
      built.runtime.recover()
      return built
    },
    seed(input = {}) {
      const seed: SeedInput = {
        workspace: root,
        experimentId: 'E17',
        runId: 'run-01',
        revision: 1,
        status: 'partial',
        total: 40,
        passed: 29,
        failed: 11,
        ...input,
      }
      lastSeed = seed
      const out = seedResult(seed)
      return { ...seed, resultPath: out.resultPath }
    },
    observe(ticketId, path) {
      const finding = readResultFile({ root, path, observedAt: clock.now() })
      if (!finding.observed) throw new Error(`not observed: ${finding.detail}`)
      return built.runtime.observe({ ticketId, observed: finding.observed })
    },
    dispose() {
      try {
        built.db.close()
      } catch {
        // 已关闭
      }
      rmSync(root, { recursive: true, force: true })
      void lastSeed
    },
  }
}

export function openAttention(h: Harness, ticketId: string) {
  return h.built.attention.listOpen(ticketId)[0]
}

export function answerOpen(h: Harness, ticketId: string, optionId?: string): boolean {
  const open = openAttention(h, ticketId)
  if (!open) return false
  const option = optionId ?? open.options[0]!.id
  const result = h.built.runtime.answer({ attentionId: open.attentionId, taskRevision: open.taskRevision, optionId: option })
  return result.ok
}

export function fileSha(path: string): string {
  return sha256Bytes(readFileSync(path))
}
