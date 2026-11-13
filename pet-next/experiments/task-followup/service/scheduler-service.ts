/**
 * R5 本地持续服务：真实时钟 + 持久唤醒。
 *
 * 特征：
 * - 只允许一个服务进程写工作区（本轮不做多写者/分布式租约）。
 * - 循环只在“有到期 job”或“固定重判间隔”时工作；重判不写 tick 事件，只写 wake 日志。
 * - 关掉面板/浏览器不影响：服务进程自己按 dueAt 唤醒。
 * - 到期后只重判当前状态，不执行 job 里保存的旧工具调用。
 * - R5.1 合作停止：父进程经本地 IPC 发 {type:'pet-followup:stop'} → 退出循环 → 写 state=stopped 与
 *   service.stop → 关闭 DB → 经 IPC 回 {type:'pet-followup:service-stopped'} 回执 → 断开 IPC 正常 exit0。
 *   不新增网络接口；没有 IPC 通道（直接命令行运行）时行为与 R5 相同。
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

/** 本地合作停止协议（仅子进程 IPC；不开端口）。 */
export const SERVICE_STOP_REQUEST = 'pet-followup:stop'
export const SERVICE_STOP_RECEIPT = 'pet-followup:service-stopped'

function isStopRequest(message: unknown): message is { type: string; requestId?: unknown } {
  return typeof message === 'object' && message !== null && (message as { type?: unknown }).type === SERVICE_STOP_REQUEST
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
  let wakeSleep: (() => void) | null = null
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(20, ms))
      function done(): void {
        clearTimeout(timer)
        wakeSleep = null
        resolve()
      }
      wakeSleep = done
    })
  const stop = (reason: string): void => {
    if (stopping) return
    stopping = true
    reasonText = reason
    wakeSleep?.()
  }
  const onSignal = (signal: NodeJS.Signals): void => stop(`signal:${signal}`)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const ipc = typeof process.send === 'function' && process.connected
  let stopRequest: { readonly requestId: string | null; readonly receivedAt: string } | null = null
  const onMessage = (message: unknown): void => {
    if (!isStopRequest(message) || stopRequest) return
    stopRequest = { requestId: typeof message.requestId === 'string' ? message.requestId : null, receivedAt: clock.now() }
    record({ event: 'service.stop_request', via: 'ipc', requestId: stopRequest.requestId, pid: process.pid })
    if (process.env.PET_FOLLOWUP_CRASH_AT === 'service_stop') {
      // 负控注入：模拟收到停止请求后异常退出（无 stopped 状态、无回执）。
      process.stderr.write('[crash-injected] service_stop\n')
      process.exit(43)
    }
    stop('ipc:stop')
  }
  if (ipc) process.on('message', onMessage)
  try {
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
      if (!stopping && options.maxIterations !== undefined && iterations >= options.maxIterations) {
        reasonText = 'max_iterations'
        break
      }
      if (!stopping && deadline !== null && Date.now() >= deadline) {
        reasonText = 'max_run'
        break
      }
      const next = built.runtime.nextWakeAt()
      const untilDue = next === null ? intervalMs : Math.max(20, Date.parse(next) - Date.now())
      await sleep(Math.min(intervalMs, untilDue))
      if (!stopping && deadline !== null && Date.now() >= deadline) {
        reasonText = 'max_run'
        break
      }
    }

    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    const stoppedAt = clock.now()
    const requestId = (stopRequest as { readonly requestId: string | null } | null)?.requestId ?? null
    writeStatus({ state: 'stopped', iterations, wakes, reason: reasonText, stoppedAt, stopRequestId: requestId })
    record({ event: 'service.stop', reason: reasonText, iterations, wakes, requestId })
    built.db.close()
    if (ipc && process.connected) {
      const receipt = {
        type: SERVICE_STOP_RECEIPT,
        pid: process.pid,
        requestId,
        reason: reasonText,
        state: 'stopped',
        dbClosed: true,
        startedAt,
        stoppedAt,
        iterations,
        wakes,
      }
      await new Promise<void>((resolve) => {
        process.send!(receipt, undefined, {}, () => resolve())
      })
    }
    return { startedAt, stoppedAt, iterations, wakes, cancelled, stale, reason: reasonText }
  } finally {
    // IPC 通道会让进程一直存活：无论正常还是异常，结束时都断开，退出码由调用方决定。
    if (ipc) {
      process.removeListener('message', onMessage)
      if (process.connected) process.disconnect()
    }
  }
}
