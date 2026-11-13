/**
 * final-demo：跟进任务宿主（Node 24 单进程，唯一写者）。
 *
 * 一个进程同时拥有：runtime/SQLite、按任务绑定目录的结果 watcher（fs.watch + 定期补扫）、
 * RealClock 持久唤醒循环、启动恢复，以及只绑 127.0.0.1 的 HTTP API（随机 token）。
 * 桌宠（Electron 主进程）与任务面板都只是客户端。
 *
 * - 同一工作区只允许一个宿主：state/host.lock 独占创建；已有存活宿主时 exit 9（调用方复用它）。
 * - 停止：IPC {type:'pet-followup:stop'} / SIGINT / SIGTERM / 父进程 IPC 断开 / POST /api/shutdown
 *   全部走同一条合作停止：退出循环 → 停 watcher → 关 HTTP → 写 stopped → 关 DB → IPC 回执 → exit 0。
 * - 不宣称应用退出期间仍在执行：重启后由启动补扫与 recover() 补处理。
 * - 判断是本地规则原型（scripted-rule P3），不调用模型、不访问网络（除本机回环）。
 *
 * @module pet-next/experiments/task-followup/service/host
 */
import { randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { sha256Bytes } from '../contracts.ts'
import type { PolicyId, QuietConfig, TaskSnapshot } from '../contracts.ts'
import { DEFAULT_QUIET, normalizeTimeZone } from '../contracts.ts'
import { buildRuntime } from '../runtime/build.ts'
import type { BuiltRuntime } from '../runtime/build.ts'
import { RealClock } from '../runtime/clock.ts'
import { loadAssessor } from '../runtime/assessors.ts'
import { InboxWatcher } from '../tools/watch.ts'
import { EXPERIMENT_ROOT } from '../paths.ts'
import { SERVICE_STOP_RECEIPT, SERVICE_STOP_REQUEST } from './scheduler-service.ts'

export const HOST_READY_MESSAGE = 'pet-followup:host-ready'
export const HOST_DUPLICATE_EXIT = 9
export const HOST_TOKEN_HEADER = 'x-followup-token'
export const FOLLOWUP_TEMPLATE = 'local-test-results'
export const JUDGMENT_LABEL = '本地规则原型（scripted-rule P3，不调用模型）'
const BINDING_PREFIX = 'host.binding:'

export interface HostOptions {
  readonly workspaceRoot: string
  readonly policy?: PolicyId
  readonly timezone?: string
  /** 演示短等待（RealClock）：只缩短 minGap 与 defer 等待，不改静默/阈值/冷却。 */
  readonly minGapMs?: number
  readonly wakeAfterMs?: number
  readonly demoLabel?: string | null
  readonly intervalMs?: number
  readonly rescanMs?: number
  readonly port?: number
  readonly onLog?: (line: string) => void
  /** 事务外异步 assessment 来源：none（默认，P3 规则基线）| baseline-menu-first | file-queue[:dir] | module:<path>。 */
  readonly assessor?: string
  readonly assessorTimeoutMs?: number
}

interface Binding {
  readonly dir: string
  readonly template: string
  readonly createdAt: string
}

interface WatchState {
  readonly dirAbs: string
  readonly watcher: InboxWatcher
  readonly stop: () => void
  lastScanAt: string | null
  lastFinding: string | null
}

export interface HostLockFile {
  pid: number
  port: number
  token: string
  workspace: string
  startedAt: string
  state: 'starting' | 'ready' | 'stopping' | 'stopped'
  updatedAt: string
  demoConfig: string | null
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readHostLock(workspaceRoot: string): HostLockFile | null {
  const path = join(resolve(workspaceRoot), 'state', 'host.json')
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HostLockFile
  } catch {
    return null
  }
}

async function healthOk(lock: HostLockFile): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${lock.port}/api/health`, {
      headers: { [HOST_TOKEN_HEADER]: lock.token },
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { pid?: number }
    return body.pid === lock.pid
  } catch {
    return false
  }
}

function insideDir(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function atomicJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

/** 运行宿主直到合作停止；返回退出码（0 正常，9 重复宿主）。 */
export async function runHost(options: HostOptions): Promise<number> {
  const root = resolve(options.workspaceRoot)
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  const log = (line: string): void => options.onLog?.(line)
  const hostLogPath = join(stateDir, 'host.log')
  const record = (event: Record<string, unknown>): void => {
    appendFileSync(hostLogPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event })}\n`)
  }

  // ---------------- 单宿主锁 ----------------
  const lockPath = join(stateDir, 'host.lock')
  const acquire = async (): Promise<boolean> => {
    for (let round = 0; round < 3; round += 1) {
      try {
        const fd = openSync(lockPath, 'wx')
        writeSync(fd, String(process.pid))
        closeSync(fd)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      let owner = 0
      try {
        owner = Number(readFileSync(lockPath, 'utf8').trim())
      } catch {
        owner = 0
      }
      if (owner === process.pid) return true
      if (pidAlive(owner)) {
        const lock = readHostLock(root)
        if (lock && lock.pid === owner && (await healthOk(lock))) {
          record({ event: 'host.duplicate_refused', owner, port: lock.port })
          process.stdout.write(`HOST_DUPLICATE ${JSON.stringify({ pid: owner, port: lock.port, workspace: root })}\n`)
          return false
        }
        // 存活但尚未就绪：短暂等待再判断，避免两个宿主同时写库。
        await new Promise((r) => setTimeout(r, 1500))
        if (pidAlive(owner) && round < 2) continue
        if (pidAlive(owner)) {
          record({ event: 'host.duplicate_refused', owner, port: null })
          process.stdout.write(`HOST_DUPLICATE ${JSON.stringify({ pid: owner, port: null, workspace: root })}\n`)
          return false
        }
      }
      record({ event: 'host.stale_lock_removed', owner })
      try {
        unlinkSync(lockPath)
      } catch {
        // 另一进程刚删掉，下一轮重试独占创建。
      }
    }
    return false
  }
  if (!(await acquire())) return HOST_DUPLICATE_EXIT

  const timezone = normalizeTimeZone(options.timezone ?? 'Asia/Shanghai')
  const quiet: QuietConfig = {
    ...DEFAULT_QUIET,
    timezone,
    ...(options.minGapMs === undefined ? {} : { minGapMs: options.minGapMs }),
  }
  const clock = new RealClock()
  // 能力接入点：assessor 失败加载直接报错退出（不静默回退到规则）。
  let loaded: Awaited<ReturnType<typeof loadAssessor>>
  // capability：宿主内置的记忆+介入+模型适配；模型未配置时显式回退到规则路径并在面板标注，不假装成功。
  let capability: import('./capability-assessor.ts').CapabilityHandle | null = null
  let capabilityUnavailable: string | null = null
  try {
    if (options.assessor === 'capability') {
      const mod = await import('./capability-assessor.ts')
      try {
        const recheckEnv = Number(process.env.PET_FOLLOWUP_RECHECK_MS ?? '')
        const hostRecheckMs = Number.isFinite(recheckEnv) && recheckEnv > 0 ? recheckEnv : options.demoLabel ? 90_000 : 30 * 60_000
        capability = mod.createCapabilityHandle(process.env, fetch, undefined, { hostRecheckMs })
        loaded = { assessor: capability.assessor, spec: 'capability' }
      } catch (error) {
        if (!(error instanceof mod.CapabilityNotConfigured)) throw error
        capabilityUnavailable = error.message
        loaded = null
        record({ event: 'host.assessor_unavailable', spec: 'capability', error: error.message, fallback: 'scripted-rule P3' })
        process.stderr.write(`capability 未启用：${error.message}；回退到本地规则原型\n`)
      }
    } else {
      loaded = await loadAssessor(options.assessor, { workspaceRoot: root, stateDir })
    }
  } catch (error) {
    record({ event: 'host.assessor_error', spec: options.assessor ?? null, error: (error as Error).message })
    process.stderr.write(`assessor 加载失败：${(error as Error).message}\n`)
    try {
      unlinkSync(lockPath)
    } catch {
      // 锁文件不在不影响失败退出。
    }
    return 1
  }
  let wakeLoop: (() => void) | null = null
  const built: BuiltRuntime = buildRuntime({
    workspaceRoot: root,
    policy: options.policy ?? 'P3',
    clock,
    quiet,
    ...(options.wakeAfterMs === undefined ? {} : { wakeAfterMs: options.wakeAfterMs }),
    ...(loaded
      ? {
          assessment: {
            assessor: loaded.assessor,
            ...(loaded.packets ? { packets: loaded.packets } : {}),
            ...(options.assessorTimeoutMs ? { timeoutMs: options.assessorTimeoutMs } : {}),
            onSettled: (requestId: string, status: string) => {
              record({ event: 'host.assessment_settled', requestId, status })
              wakeLoop?.()
            },
          },
        }
      : {}),
  })
  if (capability) capability.attach(built.db.handle)
  const judgment = capability
    ? `模型判断（${capability.model.name} @ ${capability.model.baseUrl}，记忆抽取+有效记忆读取+介入评估，事务外异步；未知ETA由宿主每${Math.round(capability.hostRecheckMs / 1000)}秒有界复查）；执行仍经版本/证据/通知校验，工具执行须用户授权`
    : capabilityUnavailable
      ? `${JUDGMENT_LABEL}；模型判断未启用：${capabilityUnavailable}`
      : loaded
    ? `异步 assessment：${loaded.assessor.id}（${loaded.assessor.capability ? '外部判断' : '基线包装，非模型'}；记忆包 ${loaded.packets?.id ?? 'legacy-readRelevant'}）；执行仍经既有版本/证据/通知校验`
    : JUDGMENT_LABEL
  const token = randomBytes(18).toString('hex')
  const startedAt = clock.now()
  const demoConfig = options.demoLabel ?? null
  const lockFile: HostLockFile = {
    pid: process.pid,
    port: 0,
    token,
    workspace: root,
    startedAt,
    state: 'starting',
    updatedAt: startedAt,
    demoConfig,
  }
  const hostJson = join(stateDir, 'host.json')
  const writeLock = (patch: Partial<HostLockFile>): void => {
    Object.assign(lockFile, patch, { updatedAt: clock.now() })
    atomicJson(hostJson, lockFile)
  }
  writeLock({})
  record({ event: 'host.start', workspace: root, timezone, quiet, wakeAfterMs: options.wakeAfterMs ?? null, demoConfig, configSha: built.configSha, assessor: loaded ? loaded.spec : 'none' })

  // ---------------- 绑定与 watcher ----------------
  const bindingOf = (ticketId: string): Binding | null => {
    const raw = built.db.metaGet(`${BINDING_PREFIX}${ticketId}`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as Binding
    } catch {
      return null
    }
  }
  const watchers = new Map<string, WatchState>()
  const startWatcher = (task: TaskSnapshot, binding: Binding): void => {
    const dirAbs = resolve(root, binding.dir)
    mkdirSync(dirAbs, { recursive: true })
    let state: WatchState | null = null
    const watcher = new InboxWatcher({
      root,
      dir: dirAbs,
      ticketId: task.ticketId,
      now: () => clock.now(),
      ingest: (ticketId, observed) => {
        const outcome = built.runtime.observe({ ticketId, observed })
        const entry = {
          event: 'host.observe',
          ticketId,
          path: observed.path,
          sha256: observed.sha256,
          sourceId: observed.sourceId,
          sourceRevision: observed.sourceRevision,
          disposition: outcome.disposition,
          detail: outcome.detail,
        }
        record(entry)
        built.db.driverLog(clock.now(), ticketId, 'host.observe', entry)
        if (capability && outcome.disposition === 'appended') {
          const r = built.runtime.getTask(ticketId)?.result
          if (r) {
            capability.ingestResult({
              turnId: `result-${ticketId}-${r.runId}-${r.revision}`,
              sessionId: 'tools',
              at: clock.now(),
              role: 'tool',
              text: `结果 ${r.runId} 第${r.revision}版：${r.status}，通过 ${r.metrics.passed}/${r.metrics.total}，失败 ${r.metrics.failed}${r.metrics.score === null ? '' : `，得分 ${r.metrics.score}`}${r.note ? `；说明：${r.note}` : ''}`,
              taskIds: [ticketId],
            }, ticketId, { runId: r.runId, revision: r.revision, status: r.status, metrics: { ...r.metrics }, resultFileSha: observed.sha256 })
          }
        }
        log(`observe ${ticketId} ${observed.sourceRevision} ${outcome.disposition} ${outcome.detail}`)
        return outcome
      },
      log: (finding) => {
        if (!state) return
        state.lastScanAt = clock.now()
        const text = `${finding.status}: ${finding.detail}`
        if (finding.status !== 'observed' && text !== state.lastFinding) {
          record({ event: 'host.scan_finding', ticketId: task.ticketId, path: finding.path, status: finding.status, detail: finding.detail })
        }
        state.lastFinding = text
      },
    })
    state = { dirAbs, watcher, stop: () => undefined, lastScanAt: null, lastFinding: null }
    watchers.set(task.ticketId, state)
    record({ event: 'host.watch_start', ticketId: task.ticketId, dir: binding.dir })
    // start() 先做一次全量补扫（启动补读），再挂 fs.watch。
    const stop = watcher.start()
    state = { ...state, stop }
    watchers.set(task.ticketId, state)
  }
  const syncWatchers = (): void => {
    const tasks = built.runtime.listTasks()
    for (const task of tasks) {
      const binding = bindingOf(task.ticketId)
      const current = watchers.get(task.ticketId)
      if (task.status === 'active' && binding && !current) {
        try {
          startWatcher(task, binding)
        } catch (error) {
          record({ event: 'host.watch_error', ticketId: task.ticketId, error: (error as Error).message })
        }
      } else if (task.status !== 'active' && current) {
        current.stop()
        watchers.delete(task.ticketId)
        record({ event: 'host.watch_stop', ticketId: task.ticketId, reason: `task ${task.status}` })
      }
    }
  }
  const rescanAll = (): void => {
    for (const [ticketId, state] of watchers) {
      try {
        state.watcher.scanOnce()
      } catch (error) {
        record({ event: 'host.scan_error', ticketId, error: (error as Error).message })
      }
    }
  }

  // ---------------- 视图 ----------------
  const reportOf = (task: TaskSnapshot): { path: string; abs: string; sha256: string; receiptId: string | null; verified: boolean; detail: string } | null => {
    if (!task.analysis) return null
    const abs = resolve(root, task.analysis.artifactPath)
    const allowed = join(root, 'artifacts', task.ticketId)
    let verified = false
    let detail = 'ok'
    if (!insideDir(allowed, abs)) detail = 'outside task artifacts dir'
    else if (!existsSync(abs)) detail = 'file missing'
    else {
      const sha = sha256Bytes(readFileSync(abs))
      verified = sha === task.analysis.artifactSha
      if (!verified) detail = `sha ${sha.slice(0, 12)} != ${task.analysis.artifactSha.slice(0, 12)}`
    }
    return { path: task.analysis.artifactPath.split(sep).join('/'), abs, sha256: task.analysis.artifactSha, receiptId: task.analysis.receiptId, verified, detail }
  }
  const jobsFor = (ticketId: string) => built.runtime.listWakeJobs().filter((job) => job.ticketId === ticketId)
  const taskView = (task: TaskSnapshot): Record<string, unknown> => {
    const binding = bindingOf(task.ticketId)
    const open = task.openAttention
    const visible = Boolean(open && (open.deliveredAt || open.presentedAt))
    let bucket = 'waiting'
    if (task.status === 'cancelled') bucket = 'cancelled'
    else if (task.status === 'completed') bucket = 'done'
    else if (task.status === 'failed' || task.stage === 'needs_reconciliation') bucket = 'blocked'
    else if (open && visible) bucket = 'needs_decision'
    const scheduled = jobsFor(task.ticketId)
      .filter((job) => job.status === 'scheduled')
      .map((job) => job.dueAt)
      .sort()
    const report = reportOf(task)
    const watch = watchers.get(task.ticketId)
    return {
      ticketId: task.ticketId,
      title: task.title,
      goal: task.goal,
      template: binding?.template ?? null,
      dir: binding?.dir ?? null,
      dirAbs: binding ? resolve(root, binding.dir) : null,
      status: task.status,
      stage: task.stage,
      bucket,
      taskRevision: task.taskRevision,
      result: task.result
        ? {
            runId: task.result.runId,
            revision: task.result.revision,
            status: task.result.status,
            metrics: task.result.metrics,
            resultPath: task.result.resultPath,
            resultFileSha: task.result.resultFileSha,
          }
        : null,
      decision: open
        ? {
            attentionId: open.attentionId,
            decisionId: open.decisionId,
            taskRevision: open.taskRevision,
            question: open.question,
            options: open.options.map((option) => ({ id: option.id, label: option.label })),
            queuedAt: open.notifiedAt ?? null,
            deliveredAt: open.deliveredAt ?? null,
            presentedAt: open.presentedAt ?? null,
          }
        : null,
      nextWakeAt: scheduled[0] ?? null,
      report: report ? { path: report.path, sha256: report.sha256, receiptId: report.receiptId, verified: report.verified } : null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      lastNote: task.diagnostics.at(-1) ?? null,
      closeReason: task.closeReason ?? null,
      watching: watch ? { lastScanAt: watch.lastScanAt, lastFinding: watch.lastFinding } : null,
    }
  }
  const overview = (): Record<string, unknown> => {
    const tasks = built.runtime
      .listTasks()
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(taskView)
    const pending = tasks
      .filter((task) => task.bucket === 'needs_decision' && task.decision)
      .map((task) => ({ ticketId: task.ticketId, title: task.title, decision: task.decision }))
    return {
      ok: true,
      now: clock.now(),
      pid: process.pid,
      workspace: root,
      judgment,
      assessor: loaded ? { id: loaded.assessor.id, capability: loaded.assessor.capability, spec: loaded.spec } : null,
      modelUnavailable: capabilityUnavailable,
      canSay: Boolean(capability),
      demoConfig,
      timezone,
      quietHours: `${quiet.fromHour}:00-${quiet.toHour}:00 ${timezone}`,
      tasks,
      pending,
    }
  }

  // ---------------- 停止 ----------------
  let stopping = false
  let stopReason = 'unknown'
  let stopRequestId: string | null = null
  let wakeSleep: (() => void) | null = null
  wakeLoop = () => wakeSleep?.()
  const stop = (reason: string): void => {
    if (stopping) return
    stopping = true
    stopReason = reason
    record({ event: 'host.stop_request', reason })
    wakeSleep?.()
  }
  const onSignal = (signal: NodeJS.Signals): void => stop(`signal:${signal}`)
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const ipc = typeof process.send === 'function' && process.connected
  const onMessage = (message: unknown): void => {
    if (typeof message !== 'object' || message === null) return
    const typed = message as { type?: unknown; requestId?: unknown }
    if (typed.type !== SERVICE_STOP_REQUEST) return
    stopRequestId = typeof typed.requestId === 'string' ? typed.requestId : null
    stop('ipc:stop')
  }
  const onDisconnect = (): void => stop('parent_ipc_disconnected')
  if (ipc) {
    process.on('message', onMessage)
    process.on('disconnect', onDisconnect)
  }

  // ---------------- HTTP ----------------
  const panelPath = join(EXPERIMENT_ROOT, 'demo', 'panel.html')
  const reportViewPath = join(EXPERIMENT_ROOT, 'demo', 'report-view.html')
  const send = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value, null, 2))
  }
  const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      size += (chunk as Buffer).length
      if (size > 64 * 1024) throw new Error('body too large')
      chunks.push(Buffer.from(chunk as Buffer))
    }
    if (!chunks.length) return {}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  }
  const findTask = (ticketId: string): TaskSnapshot | null => built.runtime.listTasks().find((task) => task.ticketId === ticketId) ?? null
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const supplied = String(request.headers[HOST_TOKEN_HEADER] ?? url.searchParams.get('token') ?? '')
    if (supplied !== token) {
      send(response, 403, { ok: false, code: 'bad_token', error: '缺少或错误的宿主 token' })
      return
    }
    if (request.method === 'GET' && (url.pathname === '/panel' || url.pathname === '/report-view')) {
      const html = readFileSync(url.pathname === '/panel' ? panelPath : reportViewPath)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      send(response, 200, { ok: true, pid: process.pid, workspace: root, startedAt, clock: clock.kind, timezone, demoConfig, judgment, quiet, wakeAfterMs: options.wakeAfterMs ?? null, configSha: built.configSha })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/overview') {
      send(response, 200, overview())
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/task') {
      const task = findTask(url.searchParams.get('ticket') ?? '')
      if (!task) {
        send(response, 404, { ok: false, code: 'unknown_task', error: '任务不存在' })
        return
      }
      send(response, 200, {
        ok: true,
        task: taskView(task),
        diagnostics: task.diagnostics.slice(-20),
        notifications: built.runtime.notifications(task.ticketId),
        wakeJobs: jobsFor(task.ticketId),
        receipts: built.runtime.exportTask(task.ticketId).receipts,
        attempt: task.attempt,
        completionCheck: built.runtime.completionCheck(task),
        assessments: built.runtime.listAssessments(task.ticketId).map((row) => ({
          requestId: row.request_id,
          status: row.status,
          assessor: row.assessor,
          capability: row.capability === 1,
          taskRevision: row.task_revision,
          memoryCursor: row.memory_cursor,
          round: row.round,
          errorCode: row.error_code,
          errorDetail: row.error_detail,
          preGuard: row.pre_guard_json ? JSON.parse(row.pre_guard_json) : null,
          postGuard: row.post_guard_json ? JSON.parse(row.post_guard_json) : null,
          raw: row.raw_json ? JSON.parse(row.raw_json) : null,
          waitUntil: row.wait_until,
          createdAt: row.created_at,
          completedAt: row.completed_at,
        })),
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/report') {
      const task = findTask(url.searchParams.get('ticket') ?? '')
      if (!task) {
        send(response, 404, { ok: false, code: 'unknown_task', error: '任务不存在' })
        return
      }
      const report = reportOf(task)
      if (!report) {
        send(response, 404, { ok: false, code: 'no_report', error: '该任务当前没有分析产物' })
        return
      }
      if (!report.verified) {
        send(response, 409, { ok: false, code: 'report_unverified', error: `产物核验失败：${report.detail}`, report })
        return
      }
      const content = readFileSync(report.abs, 'utf8')
      built.db.driverLog(clock.now(), task.ticketId, 'host.report_read', { path: report.path, sha256: report.sha256 })
      send(response, 200, { ok: true, ticketId: task.ticketId, title: task.title, ...report, content })
      return
    }
    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      send(response, 404, { ok: false, code: 'not_found' })
      return
    }
    const body = await readBody(request)
    const action = url.pathname.slice('/api/'.length)
    if (action === 'say') {
      const text = String(body.text ?? '').trim()
      const sayTicket = String(body.ticketId ?? '').trim()
      if (!text) {
        send(response, 400, { ok: false, code: 'empty', error: '内容为空' })
        return
      }
      if (!capability) {
        send(response, 409, { ok: false, code: 'not_configured', error: capabilityUnavailable ?? '未启用模型判断（PET_FOLLOWUP_ASSESSOR=capability）；规则原型不理解自然语言' })
        return
      }
      const targets = sayTicket ? [sayTicket] : built.runtime.listTasks().filter((t) => t.status === 'active').map((t) => t.ticketId)
      const turnId = `say-${Date.now()}-${randomBytes(3).toString('hex')}`
      capability.appendTurn({ turnId, sessionId: 'panel', at: clock.now(), role: 'user', text, taskIds: targets })
      for (const id of targets) built.runtime.requestReassessment(id)
      record({ event: 'host.say', turnId, ticketIds: targets, chars: text.length })
      wakeLoop?.()
      send(response, 200, { ok: true, turnId, ticketIds: targets })
      return
    }
    if (action === 'tasks') {
      const title = String(body.title ?? '').trim()
      const rawDir = String(body.dir ?? '').trim()
      const template = String(body.template ?? FOLLOWUP_TEMPLATE)
      if (template !== FOLLOWUP_TEMPLATE) {
        send(response, 400, { ok: false, code: 'unsupported_template', error: `只支持模板 ${FOLLOWUP_TEMPLATE}` })
        return
      }
      if (!title) {
        send(response, 400, { ok: false, code: 'title_required', error: '请填写任务名称' })
        return
      }
      if (!rawDir) {
        send(response, 400, { ok: false, code: 'dir_required', error: '请选择结果目录' })
        return
      }
      const dirAbs = isAbsolute(rawDir) ? resolve(rawDir) : resolve(root, rawDir)
      if (!insideDir(root, dirAbs) || dirAbs === root) {
        send(response, 400, { ok: false, code: 'dir_outside_workspace', error: `结果目录必须在工作区内的子目录：${root}` })
        return
      }
      const rel = relative(root, dirAbs)
      const top = rel.split(sep)[0]
      if (top === 'state' || top === 'artifacts') {
        send(response, 400, { ok: false, code: 'dir_reserved', error: '不能选择宿主内部目录（state/artifacts）' })
        return
      }
      if (existsSync(dirAbs) && !statSync(dirAbs).isDirectory()) {
        send(response, 400, { ok: false, code: 'dir_not_directory', error: '所选路径不是目录' })
        return
      }
      const relNorm = rel.split(sep).join('/')
      const clash = built.runtime
        .listTasks()
        .find((task) => task.status === 'active' && bindingOf(task.ticketId)?.dir === relNorm)
      if (clash) {
        send(response, 409, { ok: false, code: 'dir_in_use', error: `该目录已被进行中的任务「${clash.title}」跟进` })
        return
      }
      const goal = String(body.goal ?? '').trim() || '跟进本地测试/实验结果；失败时让我选择是否分析失败样本'
      const created = built.runtime.delegate({
        title,
        goal,
        goalCondition: { requireResultArtifact: true, requireAnalysisArtifact: true, requireReceipt: true, insufficientStatuses: ['failed', 'partial'] },
      })
      const binding: Binding = { dir: relNorm, template, createdAt: clock.now() }
      built.db.metaSet(`${BINDING_PREFIX}${created.ticketId}`, JSON.stringify(binding))
      record({ event: 'host.task_created', ticketId: created.ticketId, title, dir: relNorm })
      if (capability) {
        capability.appendTurn({ turnId: `delegate-${created.ticketId}`, sessionId: 'panel', at: clock.now(), role: 'user', text: `新委托「${title}」：${goal}（结果文件放在 ${relNorm}/result.json）`, taskIds: [created.ticketId] })
      }
      syncWatchers()
      send(response, 200, { ok: true, task: taskView(built.runtime.getTask(created.ticketId)) })
      return
    }
    const ticketId = String(body.ticketId ?? '')
    const task = action === 'shutdown' ? null : findTask(ticketId)
    if (action !== 'shutdown' && !task) {
      send(response, 404, { ok: false, code: 'unknown_task', error: '任务不存在' })
      return
    }
    if (action === 'answer') {
      const open = task!.openAttention
      const attentionId = String(body.attentionId ?? '')
      const decisionId = String(body.decisionId ?? '')
      const taskRevision = Number(body.taskRevision)
      if (!open || open.attentionId !== attentionId || open.decisionId !== decisionId || task!.taskRevision !== taskRevision) {
        record({ event: 'host.answer_rejected', ticketId, attentionId, decisionId, taskRevision, current: open ? { attentionId: open.attentionId, decisionId: open.decisionId } : null, status: task!.status })
        send(response, 409, { ok: false, code: 'stale_decision', error: '这个问题已失效（任务已取消/更新或已回答），请看当前状态', task: taskView(task!) })
        return
      }
      const result = built.runtime.answer({ attentionId, taskRevision, optionId: String(body.optionId ?? '') })
      record({ event: 'host.answer', ticketId, attentionId, decisionId, optionId: body.optionId ?? null, ok: result.ok, code: result.ok ? null : (result as { code?: string }).code ?? null })
      syncWatchers()
      send(response, result.ok ? 200 : 409, { ok: result.ok, result, task: taskView(built.runtime.getTask(ticketId)) })
      return
    }
    if (action === 'cancel') {
      const result = built.runtime.cancel({ ticketId, reason: '用户在面板取消' })
      record({ event: 'host.cancel', ticketId, ok: result.ok, detail: result.detail })
      syncWatchers()
      send(response, result.ok ? 200 : 409, { ok: result.ok, detail: result.detail, task: taskView(built.runtime.getTask(ticketId)) })
      return
    }
    if (action === 'present') {
      const open = task!.openAttention
      if (!open || open.attentionId !== String(body.attentionId ?? '')) {
        send(response, 409, { ok: false, code: 'stale_decision', error: '问题已不是当前问题' })
        return
      }
      const result = built.runtime.present(ticketId)
      record({ event: 'host.present', ticketId, attentionId: open.attentionId, presented: result.presented })
      send(response, 200, { ok: true, ...result })
      return
    }
    if (action === 'pet-shown') {
      const open = task!.openAttention
      const decisionId = String(body.decisionId ?? '')
      const current = Boolean(open && open.decisionId === decisionId)
      built.db.driverLog(clock.now(), ticketId, 'pet.reminder.shown', { decisionId, current })
      record({ event: 'pet.reminder.shown', ticketId, decisionId, current })
      send(response, current ? 200 : 409, { ok: current })
      return
    }
    if (action === 'shutdown') {
      send(response, 200, { ok: true, stopping: true })
      stop('http:shutdown')
      return
    }
    send(response, 404, { ok: false, code: 'unknown_action', error: action })
  }

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      record({ event: 'host.http_error', error: (error as Error).message })
      if (!response.headersSent) send(response, 500, { ok: false, code: 'internal', error: (error as Error).message })
    })
  })
  const port = await new Promise<number>((resolvePort, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      resolvePort(typeof address === 'object' && address ? address.port : 0)
    })
  })

  let exitCode = 0
  try {
    const recovered = built.runtime.recover()
    record({ event: 'host.recover', restored: recovered.restored.length, needsReconciliation: recovered.needsReconciliation.length })
    syncWatchers()
    writeLock({ port, state: 'ready' })
    const ready = { type: HOST_READY_MESSAGE, pid: process.pid, port, token, workspace: root }
    record({ event: 'host.ready', port, tasks: built.runtime.listTasks().length, watching: watchers.size })
    process.stdout.write(`HOST_READY ${JSON.stringify({ pid: process.pid, port, workspace: root })}\n`)
    if (ipc && process.connected) process.send!(ready)

    const intervalMs = Math.max(100, options.intervalMs ?? 1_000)
    const rescanMs = Math.max(500, options.rescanMs ?? 3_000)
    let lastRescan = Date.now()
    const sleep = (ms: number): Promise<void> =>
      new Promise((done) => {
        const timer = setTimeout(finish, Math.max(20, ms))
        function finish(): void {
          clearTimeout(timer)
          wakeSleep = null
          done()
        }
        wakeSleep = finish
      })
    while (!stopping) {
      try {
        built.runtime.reevaluate()
        for (const result of built.runtime.wakeDue()) {
          record({ event: 'host.wake', ...result })
          log(`wake ${result.action} ${result.jobId} ${result.detail}`)
        }
        if (Date.now() - lastRescan >= rescanMs) {
          lastRescan = Date.now()
          rescanAll()
        }
        syncWatchers()
      } catch (error) {
        record({ event: 'host.loop_error', error: (error as Error).message })
      }
      if (stopping) break
      const next = built.runtime.nextWakeAt()
      const untilDue = next === null ? intervalMs : Math.max(20, Date.parse(next) - Date.now())
      await sleep(Math.min(intervalMs, untilDue))
    }
  } catch (error) {
    exitCode = 1
    record({ event: 'host.fatal', error: (error as Error).message })
    process.stderr.write(`host fatal: ${(error as Error).message}\n`)
  } finally {
    writeLock({ state: 'stopping' })
    // 在途 assessment 先中止（回交会被拒绝），重启后按同身份下一轮重新请求；不在关机期间“继续判断”。
    built.runtime.abortAllAssessments('host stopping')
    await Promise.race([built.runtime.settleAssessments(), new Promise((done) => setTimeout(done, 2000))])
    for (const state of watchers.values()) state.stop()
    watchers.clear()
    await new Promise<void>((done) => server.close(() => done()))
    server.closeAllConnections?.()
    const stoppedAt = clock.now()
    writeLock({ state: 'stopped' })
    record({ event: 'host.stop', reason: stopReason, requestId: stopRequestId, stoppedAt })
    built.db.close()
    try {
      unlinkSync(lockPath)
    } catch {
      // 锁文件已不在：不影响停止。
    }
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    if (ipc) {
      process.removeListener('message', onMessage)
      process.removeListener('disconnect', onDisconnect)
      if (process.connected) {
        await new Promise<void>((done) => {
          process.send!({ type: SERVICE_STOP_RECEIPT, pid: process.pid, requestId: stopRequestId, reason: stopReason, state: 'stopped', dbClosed: true, startedAt, stoppedAt }, undefined, {}, () => done())
        })
        if (process.connected) process.disconnect()
      }
    }
  }
  return exitCode
}
