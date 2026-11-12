/**
 * R5 本地持续服务：真实时钟 + 持久唤醒。
 *
 * 特征：
 * - 只允许一个服务进程写工作区（本轮不做多写者/分布式租约）。
 * - 循环只在“有到期 job”或“固定重判间隔”时工作；重判不写 tick 事件，只写 wake 日志。
 * - 关掉面板/浏览器不影响：服务进程自己按 dueAt 唤醒。
 * - 到期后只重判当前状态，不执行 job 里保存的旧工具调用。
 *
 * @module pet-next/experiments/task-followup/service/scheduler-service
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildRuntime } from '../runtime/build.ts'
import type { BuiltRuntime } from '../runtime/build.ts'
import type { PolicyId, QuietConfig } from '../contracts.ts'
import { DEFAULT_QUIET, normalizeTimeZone } from '../contracts.ts'
import { RealClock } from '../runtime/clock.ts'

export interface SchedulerServiceOptions {
  readonly workspaceRoot: string
  readonly policy?: PolicyId
  readonly quiet?: QuietConfig
  /** 最长睡眠/重判间隔（毫秒）；到期 job 会提前打断睡眠。 */
  readonly intervalMs?: number
  /** defer 等待的压缩间隔（毫秒）；演示用，写入 service.json。 */
  readonly wakeAfterMs?: number
  /** 有界运行时长（毫秒）；不设置则一直运行到信号退出。 */
  readonly maxRunMs?: number
  /** 最大迭代次数（测试用）；设置后到次数即退出。 */
  readonly maxIterations?: number
  readonly onLog?: (line: string) => void
}

export interface SchedulerServiceReport {
  readonly startedAt: string
  readonly stoppedAt: string
  readonly iterations: number
  readonly wakes: number
  readonly cancelled: number
  readonly stale: number
  readonly reason: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(20, ms)))
}

export async function runSchedulerService(options: SchedulerServiceOptions): Promise<SchedulerServiceReport> {
  const root = options.workspaceRoot
  const intervalMs = Math.max(50, options.intervalMs ?? 1_000)
  const wakeAfterMs = options.wakeAfterMs ?? 10 * 60_000
  const baseQuiet = options.quiet ?? DEFAULT_QUIET
  const quiet: QuietConfig = { ...baseQuiet, timezone: normalizeTimeZone(baseQuiet.timezone) }
  const log = (line: string): void => options.onLog?.(line)
  mkdirSync(join(root, 'state'), { recursive: true })
  const servicePath = join(root, 'state', 'service.json')
  const logPath = join(root, 'state', 'service.log')
  const clock = new RealClock()
  const built: BuiltRuntime = buildRuntime({
    workspaceRoot: root,
    policy: options.policy ?? 'P3',
    clock,
    quiet,
    wakeAfterMs,
  })
  const startedAt = clock.now()
  const writeStatus = (patch: Record<string, unknown>): void => {
    writeFileSync(
      servicePath,
      `${JSON.stringify(
        {
          pid: process.pid,
          clock: clock.kind,
          timezone: quiet.timezone,
          configSha: built.configSha,
          intervalMs,
          wakeAfterMs,
          startedAt,
          updatedAt: clock.now(),
          ...patch,
        },
        null,
        2,
      )}\n`,
    )
  }
  const record = (event: Record<string, unknown>): void => {
    appendFileSync(logPath, `${JSON.stringify({ at: clock.now(), ...event })}\n`)
  }

  let stopping = false
  let reasonText = 'max_run'
  const stop = (reason: string): void => {
    if (stopping) return
    stopping = true
    reasonText = reason
  }
  const onSignal = (signal: NodeJS.Signals): void => stop(`signal:${signal}`)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  writeStatus({ state: 'starting' })
  record({ event: 'service.start', pid: process.pid })

  const recovered = built.runtime.recover()
  record({ event: 'service.recover', restored: recovered.restored.length, needsReconciliation: recovered.needsReconciliation.length })

  let wakes = 0
  let cancelled = 0
  let stale = 0
  let iterations = 0
  const handleDue = (): void => {
    for (const result of built.runtime.wakeDue()) {
      if (result.action === 'woken') wakes += 1
      if (result.action === 'cancelled') cancelled += 1
      if (result.action === 'stale') stale += 1
      record({ event: 'wake', ...result })
      log(`wake ${result.action} ${result.jobId} ${result.detail}`)
    }
  }

  const deadline = options.maxRunMs === undefined ? null : Date.now() + options.maxRunMs
  handleDue()
  while (!stopping) {
    iterations += 1
    built.runtime.reevaluate()
    handleDue()
    writeStatus({ state: 'running', iterations, wakes, nextWakeAt: built.runtime.nextWakeAt() })
    if (options.maxIterations !== undefined && iterations >= options.maxIterations) {
      reasonText = 'max_iterations'
      break
    }
    if (deadline !== null && Date.now() >= deadline) {
      reasonText = 'max_run'
      break
    }
    const next = built.runtime.nextWakeAt()
    const untilDue = next === null ? intervalMs : Math.max(20, Date.parse(next) - Date.now())
    await sleep(Math.min(intervalMs, untilDue))
    if (deadline !== null && Date.now() >= deadline) {
      reasonText = 'max_run'
      break
    }
  }

  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  const stoppedAt = clock.now()
  writeStatus({ state: 'stopped', iterations, wakes, reason: reasonText, stoppedAt })
  record({ event: 'service.stop', reason: reasonText, iterations, wakes })
  built.db.close()
  return { startedAt, stoppedAt, iterations, wakes, cancelled, stale, reason: reasonText }
}
