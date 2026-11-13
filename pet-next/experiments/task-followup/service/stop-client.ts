/**
 * R5.1 B：本地合作停止的父进程侧（演示与进程测试共用）。
 *
 * 停止门只认“同一 PID 经 IPC 回执 + state=stopped + service.stop 日志 + exit code 0 且无 signal”。
 * 超时后的强杀只用于清理，结果一律判失败；null/SIGTERM 不算正常停止。
 *
 * @module pet-next/experiments/task-followup/service/stop-client
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const STOP_REQUEST_TYPE = 'pet-followup:stop'
export const STOP_RECEIPT_TYPE = 'pet-followup:service-stopped'

export interface ServiceExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface StopReceipt {
  readonly type: string
  readonly pid: number
  readonly requestId: string | null
  readonly reason: string
  readonly state: string
  readonly dbClosed: boolean
  readonly stoppedAt: string
  readonly [key: string]: unknown
}

export interface StopResult {
  readonly pid: number | undefined
  readonly argv: readonly string[]
  readonly requestId: string
  readonly requestedAt: string
  readonly requestSent: boolean
  readonly exit: ServiceExit | null
  readonly exitObservedAt: string | null
  readonly forcedKill: boolean
  readonly receipt: StopReceipt | null
  readonly serviceJson: Record<string, unknown> | null
  readonly logTail: readonly Record<string, unknown>[]
}

export interface ServiceProcess {
  readonly child: ChildProcess
  readonly argv: readonly string[]
  readonly messages: unknown[]
  output(): string
  exited(): ServiceExit | null
  waitForRunning(timeoutMs?: number): Promise<boolean>
  waitForExit(timeoutMs?: number): Promise<ServiceExit | null>
  stop(timeoutMs?: number): Promise<StopResult>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

export function readServiceLog(workspace: string): Record<string, unknown>[] {
  const path = join(workspace, 'state', 'service.log')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 本 PID 最近一次 service.start 之后的日志（同一进程的完整生命周期）。 */
function sinceStart(lines: Record<string, unknown>[], pid: number | undefined): Record<string, unknown>[] {
  let start = -1
  lines.forEach((line, index) => {
    if (line.event === 'service.start' && line.pid === pid) start = index
  })
  return start < 0 ? [] : lines.slice(start)
}

/** 以 IPC 通道启动服务（直接带 transform 参数，避免 run.mjs 包装层让 IPC/PID 落到另一个进程）。 */
export function startServiceProcess(options: {
  readonly runPath: string
  readonly workspace: string
  readonly args: readonly string[]
  readonly env?: NodeJS.ProcessEnv
}): ServiceProcess {
  const argv = ['--experimental-transform-types', '--no-warnings', options.runPath, 'serve', '--scheduler', '--workspace', options.workspace, ...options.args]
  const child = spawn(process.execPath, argv, { env: options.env ?? { ...process.env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const out: string[] = []
  const messages: unknown[] = []
  let exited: ServiceExit | null = null
  let exitObservedAt: string | null = null
  child.stdout?.on('data', (chunk) => out.push(String(chunk)))
  child.stderr?.on('data', (chunk) => out.push(String(chunk)))
  child.on('message', (message) => messages.push(message))
  child.on('exit', (code, signal) => {
    exited = { code, signal }
    exitObservedAt = new Date().toISOString()
  })
  // 子进程断开 IPC 后父进程端可能报 EPIPE；不吞退出码，只避免未处理异常打断演示。
  child.on('error', (error) => out.push(`[child error] ${String(error)}\n`))
  const waitForExit = async (timeoutMs = 15_000): Promise<ServiceExit | null> => {
    const until = Date.now() + timeoutMs
    while (Date.now() < until && !exited) await sleep(50)
    return exited
  }
  return {
    child,
    argv,
    messages,
    output: () => out.join(''),
    exited: () => exited,
    waitForRunning: async (timeoutMs = 15_000) => {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        const meta = readJson(join(options.workspace, 'state', 'service.json'))
        if (meta && meta.pid === child.pid && meta.state === 'running') return true
        if (exited) return false
        await sleep(50)
      }
      return false
    },
    waitForExit,
    stop: async (timeoutMs = 10_000) => {
      const requestId = `stop-${child.pid}-${Date.now()}`
      const requestedAt = new Date().toISOString()
      let requestSent = false
      if (!exited && child.connected) {
        try {
          requestSent = child.send({ type: STOP_REQUEST_TYPE, requestId })
        } catch {
          requestSent = false
        }
      }
      await waitForExit(timeoutMs)
      let forcedKill = false
      if (!exited) {
        // 只做清理：强杀后的结果在 evaluateStop 中一律判失败。
        forcedKill = true
        child.kill()
        await waitForExit(5_000)
      }
      const receipt =
        (messages.find(
          (message) =>
            typeof message === 'object' &&
            message !== null &&
            (message as { type?: unknown }).type === STOP_RECEIPT_TYPE &&
            (message as { requestId?: unknown }).requestId === requestId,
        ) as StopReceipt | undefined) ?? null
      return {
        pid: child.pid,
        argv,
        requestId,
        requestedAt,
        requestSent,
        exit: exited,
        exitObservedAt,
        forcedKill,
        receipt,
        serviceJson: readJson(join(options.workspace, 'state', 'service.json')),
        logTail: sinceStart(readServiceLog(options.workspace), child.pid),
      }
    },
  }
}

/** 停止门：逐项给出问题；problems 为空才算有证据的正常停止。 */
export function evaluateStop(result: StopResult): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = []
  if (!result.requestSent) problems.push('stop request not sent over IPC')
  if (result.forcedKill) problems.push('forced kill after timeout (cleanup only, counts as failure)')
  if (!result.exit) problems.push('process did not exit')
  else {
    if (result.exit.signal !== null) problems.push(`terminated by signal ${result.exit.signal}`)
    if (result.exit.code !== 0) problems.push(`exit code ${String(result.exit.code)} (expected 0)`)
  }
  const receipt = result.receipt
  if (!receipt) problems.push('missing stop receipt')
  else {
    if (receipt.pid !== result.pid) problems.push(`receipt pid ${receipt.pid} != child pid ${String(result.pid)}`)
    if (receipt.state !== 'stopped') problems.push(`receipt state ${receipt.state}`)
    if (receipt.reason !== 'ipc:stop') problems.push(`receipt reason ${receipt.reason}`)
    if (receipt.dbClosed !== true) problems.push('receipt does not confirm DB closed')
  }
  const meta = result.serviceJson
  if (!meta) problems.push('service.json unreadable')
  else {
    if (meta.pid !== result.pid) problems.push('service.json pid differs from child pid')
    if (meta.state !== 'stopped') problems.push(`service.json state ${String(meta.state)}`)
    if (meta.reason !== 'ipc:stop') problems.push(`service.json reason ${String(meta.reason)}`)
    if (meta.stopRequestId !== result.requestId) problems.push('service.json stopRequestId mismatch')
  }
  const requestLog = result.logTail.find((line) => line.event === 'service.stop_request' && line.requestId === result.requestId && line.pid === result.pid)
  const stopLog = result.logTail.find((line) => line.event === 'service.stop' && line.reason === 'ipc:stop' && line.requestId === result.requestId)
  if (!requestLog) problems.push('service.log missing stop_request for this PID/request')
  if (!stopLog) problems.push('service.log missing service.stop ipc:stop')
  return { ok: problems.length === 0, problems }
}

/** 有界完成（max-iterations/max-minutes）的回执检查：如实标为有界完成，不能代替显式停止门。 */
export function evaluateBoundedExit(service: ServiceProcess, expectedReason: string): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = []
  const exit = service.exited()
  if (!exit) problems.push('process did not exit')
  else if (exit.code !== 0 || exit.signal !== null) problems.push(`exit ${String(exit.code)}/${String(exit.signal)}`)
  const receipt = service.messages.find(
    (message) => typeof message === 'object' && message !== null && (message as { type?: unknown }).type === STOP_RECEIPT_TYPE,
  ) as StopReceipt | undefined
  if (!receipt) problems.push('missing bounded-completion receipt')
  else {
    if (receipt.pid !== service.child.pid) problems.push('receipt pid differs')
    if (receipt.reason !== expectedReason) problems.push(`receipt reason ${receipt.reason} (expected ${expectedReason})`)
    if (receipt.state !== 'stopped' || receipt.dbClosed !== true) problems.push('receipt not stopped/dbClosed')
  }
  return { ok: problems.length === 0, problems }
}
