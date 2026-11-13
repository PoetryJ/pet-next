/**
 * 实验 CLI：创建委托、注入结果、观察、回答、恢复、面板服务。
 *
 * 每个命令都是独立进程；状态只在 SQLite 里，所以“重启”不是 new 对象，
 * 而是真的换一个进程读同一个库。
 *
 * @module pet-next/experiments/task-followup/cli
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { sha256Bytes, sha256Hex } from '../contracts.ts'
import type { GoalCondition, PolicyId, QuietConfig } from '../contracts.ts'
import { DEFAULT_QUIET, normalizeTimeZone } from '../contracts.ts'
import { buildRuntime } from '../runtime/build.ts'
import type { BuiltRuntime } from '../runtime/build.ts'
import { FakeClock } from '../runtime/clock.ts'
import { readResultFile } from '../tools/watch.ts'
import { seedResult } from '../tools/seed.ts'
import { InboxWatcher } from '../tools/watch.ts'
import type { WatchFinding } from '../tools/watch.ts'

import { DEFAULT_WORKSPACE, EXPERIMENT_ROOT } from '../paths.ts'

export interface CliOptions {
  readonly workspace: string
  readonly policy: PolicyId
  readonly quiet: QuietConfig
  readonly fakeClock?: FakeClock
}

export function parseOptions(argv: readonly string[]): { command: string; args: Map<string, string>; flags: Set<string> } {
  const command = argv[0] ?? 'help'
  const args = new Map<string, string>()
  const flags = new Set<string>()
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!
    if (!token.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      args.set(body.slice(0, eq), body.slice(eq + 1))
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      args.set(body, next)
      index += 1
    } else {
      flags.add(body)
      args.set(body, 'true')
    }
  }
  return { command, args, flags }
}

export function optionsFrom(args: Map<string, string>, flags: Set<string>): CliOptions {
  const workspace = resolve(args.get('workspace') ?? DEFAULT_WORKSPACE)
  const policy = (args.get('policy') ?? 'P3') as PolicyId
  // 时区必须显式给出（UTC / Asia/Shanghai ...），不看宿主 TZ。
  const quiet: QuietConfig = {
    ...DEFAULT_QUIET,
    timezone: normalizeTimeZone(args.get('timezone') ?? DEFAULT_QUIET.timezone),
    ...(args.has('quiet-from') ? { fromHour: Number(args.get('quiet-from')) } : {}),
    ...(args.has('quiet-to') ? { toHour: Number(args.get('quiet-to')) } : {}),
    ...(flags.has('allow-urgent') ? { allowUrgent: true } : {}),
    ...(args.has('min-gap-ms') ? { minGapMs: Number(args.get('min-gap-ms')) } : {}),
    ...(args.has('reminder-quota') ? { reminderQuotaPerHour: Number(args.get('reminder-quota')) } : {}),
  }
  const start = args.get('clock')
  return { workspace, policy, quiet, ...(start ? { fakeClock: new FakeClock(start) } : {}) }
}

export function openRuntime(options: CliOptions): BuiltRuntime {
  return buildRuntime({
    workspaceRoot: options.workspace,
    policy: options.policy,
    quiet: options.quiet,
    ...(options.fakeClock ? { clock: options.fakeClock } : {}),
  })
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function requireArg(args: Map<string, string>, key: string): string {
  const value = args.get(key)
  if (!value) throw new Error(`missing --${key}`)
  return value
}

function taskSummary(runtime: BuiltRuntime, ticketId: string): Record<string, unknown> {
  const task = runtime.runtime.getTask(ticketId)
  return {
    ticketId: task.ticketId,
    title: task.title,
    stage: task.stage,
    status: task.status,
    taskRevision: task.taskRevision,
    assignmentId: task.assignmentId,
    attempt: task.attempt,
    continuation: task.continuation ?? null,
    lastAnswer: task.lastAnswer ?? null,
    openAttention: task.openAttention
      ? {
          attentionId: task.openAttention.attentionId,
          decisionId: task.openAttention.decisionId,
          decisionKey: task.openAttention.decisionKey,
          question: task.openAttention.question,
          options: task.openAttention.options,
          notifiedAt: task.openAttention.notifiedAt ?? null,
          deliveredAt: task.openAttention.deliveredAt ?? null,
          presentedAt: task.openAttention.presentedAt ?? null,
        }
      : null,
    result: task.result ?? null,
    analysis: task.analysis ?? null,
    completion: task.completion ?? null,
    completionCheckOk: runtime.runtime.completionCheck(task).ok,
    lastProposal: task.lastProposal ?? null,
    evidenceCount: task.evidence.length,
    diagnostics: task.diagnostics.slice(-5),
  }
}

// ---------------------------------------------------------------------------
// seed / observe / watch
// ---------------------------------------------------------------------------

function scanInbox(runtime: BuiltRuntime, ticketId: string, dir: string, now: string): WatchFinding[] {
  const findings: WatchFinding[] = []
  if (!existsSync(dir)) return findings
  const watcher = new InboxWatcher({
    root: runtime.tools.workspaceRoot,
    dir,
    ticketId,
    now: () => now,
    ingest: (ticket, observed) => runtime.runtime.observe({ ticketId: ticket, observed }),
    log: (finding) => findings.push(finding),
  })
  watcher.scanOnce()
  return findings
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export async function runCommand(argv: readonly string[]): Promise<number> {
  const { command, args, flags } = parseOptions(argv)
  const options = optionsFrom(args, flags)
  if (command === 'help' || flags.has('help')) {
    process.stdout.write(helpText())
    return 0
  }
  if (command === 'serve') return serve(options, args)
  if (command === 'host') return hostCommand(args, flags)
  if (command === 'watch') return watchCommand(options, args)
  if (command === 'demo') {
    // @ts-expect-error demo 是纯 ESM 脚本，不参与 TS 检查
    const { runDemo } = await import('../demo/three-minute.mjs')
    return runDemo(options.workspace)
  }
  if (command === 'r5-demo') {
    // @ts-expect-error R5 demo 是纯 ESM 脚本，不参与 TS 检查
    const { runR5Demo } = await import('../demo/r5-demo.mjs')
    return runR5Demo(options.workspace)
  }
  if (command === 'r5-eval') {
    const { runR5All } = await import('../eval/r5/runner.ts')
    const { scoreR5 } = await import('../eval/r5/score.ts')
    const { runs, rawDir } = runR5All()
    const summary = scoreR5(rawDir, join(EXPERIMENT_ROOT, 'gold', 'r5'))
    const { renderR5Report, r5ReportPath } = await import('../eval/r5/report.ts')
    mkdirSync(join(EXPERIMENT_ROOT, 'out', 'r5', 'scores'), { recursive: true })
    renderR5Report(summary, r5ReportPath(EXPERIMENT_ROOT))
    writeFileSync(join(EXPERIMENT_ROOT, 'out', 'r5', 'scores', 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    process.stdout.write(`r5 runs=${runs}\n${JSON.stringify(summary.table, null, 2)}\n`)
    return 0
  }
  if (command === 'eval') {
    const { runEvaluation } = await import('../eval/runner.ts')
    return runEvaluation(options.workspace)
  }
  if (command === 'test') {
    const dir = join(EXPERIMENT_ROOT, 'tests')
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.test.ts'))
      .sort()
      .map((name) => join(dir, name))
    const child = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--test', '--test-reporter=spec', ...files], {
      stdio: 'inherit',
      env: process.env,
    })
    return child.status ?? 1
  }
  if (command === 'typecheck') {
    const tsc = join(EXPERIMENT_ROOT, 'tooling', 'node_modules', 'typescript', 'bin', 'tsc')
    if (!existsSync(tsc)) {
      process.stderr.write('tooling/typescript 未安装：在 tooling/ 下运行 npm install\n')
      return 2
    }
    const child = spawnSync(process.execPath, [tsc, '-p', join(EXPERIMENT_ROOT, 'tsconfig.json')], { stdio: 'inherit', env: process.env })
    return child.status ?? 1
  }
  if (command === 'negative') {
    const child = spawnSync(process.execPath, [join(EXPERIMENT_ROOT, 'eval', 'negative', 'all.mjs')], { stdio: 'inherit', env: process.env })
    return child.status ?? 1
  }
  if (command === 'reveal') {
    const { reveal } = await import('../eval/reveal.ts')
    const path = requireArg(args, 'raw')
    const raw = JSON.parse(readFileSync(resolve(path), 'utf8'))
    print(reveal(raw))
    return 0
  }
  if (command === 'crosscheck') {
    const child = spawnSync(
      process.execPath,
      [
        join(EXPERIMENT_ROOT, 'tools', 'score-crosscheck.mjs'),
        resolve(args.get('raw-dir') ?? join(EXPERIMENT_ROOT, 'out', 'eval', 'raw')),
        join(EXPERIMENT_ROOT, 'gold'),
        resolve(args.get('summary') ?? join(EXPERIMENT_ROOT, 'out', 'eval', 'scores', 'summary.json')),
        resolve(args.get('out') ?? join(EXPERIMENT_ROOT, 'out', 'eval', 'scores', 'crosscheck.json')),
        ...(args.get('external') ? ['--external', resolve(String(args.get('external')))] : []),
      ],
      { stdio: 'inherit', env: process.env },
    )
    return child.status ?? 1
  }
  if (command === 'verify-eval') {
    const { verifyRawDir } = await import('../eval/reveal.ts')
    const report = verifyRawDir(resolve(args.get('raw-dir') ?? join(EXPERIMENT_ROOT, 'out', 'eval', 'raw')))
    print(report)
    return report.ok ? 0 : 5
  }

  const built = openRuntime(options)
  try {
    switch (command) {
      case 'delegate': {
        const title = requireArg(args, 'title')
        const goal = args.get('goal') ?? title
        const goalCondition: GoalCondition = {
          requireResultArtifact: true,
          requireAnalysisArtifact: !flags.has('no-analysis'),
          requireReceipt: true,
          insufficientStatuses: ['failed', 'partial'],
        }
        const result = built.runtime.delegate({
          title,
          goal,
          goalCondition,
          ...(args.has('id') ? { sourceId: args.get('id')! } : {}),
          ...(args.has('at') ? { at: args.get('at')! } : {}),
        })
        print({ ok: true, ...result, ...taskSummary(built, result.ticketId) })
        return 0
      }
      case 'status': {
        const ticket = args.get('ticket')
        if (ticket) {
          if (args.has('export') || flags.has('export')) {
            print(built.runtime.exportTask(ticket))
          } else {
            print({ ok: true, ...taskSummary(built, ticket), notifications: built.runtime.notifications(ticket) })
          }
          return 0
        }
        print({ ok: true, tasks: built.runtime.listTasks().map((task) => taskSummary(built, task.ticketId)) })
        return 0
      }
      case 'seed': {
        const result = seedResult({
          workspace: options.workspace,
          experimentId: args.get('experiment') ?? 'E17',
          runId: args.get('run') ?? 'run-17',
          revision: Number(args.get('revision') ?? 1),
          status: (args.get('status') ?? 'partial') as 'succeeded' | 'failed' | 'partial',
          total: Number(args.get('total') ?? 40),
          passed: Number(args.get('passed') ?? 29),
          failed: Number(args.get('failed') ?? 11),
          corrupt: flags.has('corrupt'),
        })
        print({ ok: true, ...result })
        return 0
      }
      case 'observe': {
        const ticket = requireArg(args, 'ticket')
        const dir = join(options.workspace, 'inbox', args.get('experiment') ?? 'E17')
        const findings = scanInbox(built, ticket, dir, built.clock.now())
        print({ ok: true, findings: findings.map((finding) => ({ status: finding.status, path: finding.path, detail: finding.detail })), task: taskSummary(built, ticket) })
        return 0
      }
      case 'answer': {
        const ticket = args.get('ticket') ?? built.runtime.listTasks()[0]?.ticketId
        if (!ticket) throw new Error('no task; pass --ticket')
        const task = built.runtime.getTask(ticket)
        const open = built.attention.listOpen(ticket)[0]
        const attentionId = args.get('attention') ?? open?.attentionId
        if (!attentionId) throw new Error('no open attention')
        // --panel / --presented 明确表示“用户打开了面板并看到该问题”，产生呈现回执。
        if (flags.has('panel') || flags.has('presented')) built.runtime.present(ticket)
        const result = built.runtime.answer({
          attentionId,
          taskRevision: Number(args.get('revision') ?? task.taskRevision),
          optionId: requireArg(args, 'option'),
          ...(args.has('id') ? { sourceId: args.get('id')! } : {}),
        })
        print({
          ok: result.ok,
          result,
          visibility: built.runtime.attentionVisibility(attentionId),
          task: taskSummary(built, ticket),
        })
        return result.ok ? 0 : 3
      }
      case 'present': {
        const ticket = requireArg(args, 'ticket')
        print({ ok: true, ...built.runtime.present(ticket) })
        return 0
      }
      case 'deliver': {
        print({ ok: true, ...built.runtime.deliverPending() })
        return 0
      }
      case 'reconcile': {
        const ticket = requireArg(args, 'ticket')
        const option = requireArg(args, 'option')
        if (option !== 'accept_receipt' && option !== 'abandon_attempt') {
          throw new Error(`unknown reconcile option: ${option} (accept_receipt|abandon_attempt)`)
        }
        const result = built.runtime.reconcile({
          ticketId: ticket,
          option,
          ...(args.has('note') ? { note: args.get('note')! } : {}),
        })
        print({ ...result, task: taskSummary(built, ticket) })
        return result.ok ? 0 : 4
      }
      case 'change': {
        const ticket = requireArg(args, 'ticket')
        const goal = requireArg(args, 'goal')
        const result = built.runtime.change({ ticketId: ticket, goal })
        print({ ...result, task: taskSummary(built, ticket) })
        return 0
      }
      case 'cancel': {
        const ticket = requireArg(args, 'ticket')
        const result = built.runtime.cancel({ ticketId: ticket, reason: args.get('reason') })
        print({ ...result, task: taskSummary(built, ticket) })
        return 0
      }
      case 'tick': {
        if (!options.fakeClock) {
          process.stderr.write('tick 需要显式 --clock：真实时钟不能逻辑前进（不读宿主 TZ/不假装未来）\n')
          return 6
        }
        const minutes = Number(args.get('minutes') ?? 10)
        const result = built.runtime.tick(minutes * 60_000)
        print({
          ok: true,
          ...result,
          clock: built.clock.kind,
          timezone: built.quiet.timezone,
          tasks: built.runtime.listTasks().map((task) => taskSummary(built, task.ticketId)),
        })
        return 0
      }
      case 'recover': {
        const report = built.runtime.recover()
        print({ ok: true, ...report, tasks: built.runtime.listTasks().map((task) => taskSummary(built, task.ticketId)) })
        return report.needsReconciliation.length ? 4 : 0
      }
      case 'repair-memory': {
        print({ ok: true, ...built.runtime.repairMemory() })
        return 0
      }
      case 'jobs': {
        print({ ok: true, nextWakeAt: built.runtime.nextWakeAt(), jobs: built.runtime.listWakeJobs() })
        return 0
      }
      case 'notifications': {
        print({
          ok: true,
          timezone: built.quiet.timezone,
          notifications: built.runtime.notifications(requireArg(args, 'ticket')),
        })
        return 0
      }
      default:
        process.stderr.write(`unknown command: ${command}\n`)
        return 2
    }
  } finally {
    built.db.close()
  }
}

/**
 * final-demo 宿主：一个进程统一 runtime/DB、目录 watcher、RealClock 调度、恢复与 HTTP API。
 * --demo-short-wait 是有标识的演示短等待（RealClock，只缩短 minGap 与 defer 等待）。
 */
async function hostCommand(args: Map<string, string>, flags: Set<string>): Promise<number> {
  const { runHost } = await import('../service/host.ts')
  const short = flags.has('demo-short-wait')
  const minGapMs = args.has('min-gap-ms') ? Number(args.get('min-gap-ms')) : short ? 20_000 : undefined
  const wakeAfterMs = args.has('wake-after-ms') ? Number(args.get('wake-after-ms')) : short ? 30_000 : undefined
  const label = short || minGapMs !== undefined || wakeAfterMs !== undefined
    ? `演示短等待配置（RealClock）：minGap=${minGapMs ?? 'default'}ms，defer 等待=${wakeAfterMs ?? 'default'}ms；静默/阈值/冷却不变`
    : null
  return runHost({
    workspaceRoot: resolve(args.get('workspace') ?? join(DEFAULT_WORKSPACE, '..', 'host-workspace')),
    timezone: args.get('timezone') ?? 'Asia/Shanghai',
    ...(minGapMs === undefined ? {} : { minGapMs }),
    ...(wakeAfterMs === undefined ? {} : { wakeAfterMs }),
    demoLabel: label,
    ...(args.has('port') ? { port: Number(args.get('port')) } : {}),
    ...(args.has('assessor') ? { assessor: args.get('assessor')! } : {}),
    ...(args.has('assessor-timeout-ms') ? { assessorTimeoutMs: Number(args.get('assessor-timeout-ms')) } : {}),
    onLog: (line) => process.stdout.write(`${line}\n`),
  })
}

function watchCommand(options: CliOptions, args: Map<string, string>): Promise<number> {
  const ticket = args.get('ticket')
  if (!ticket) throw new Error('missing --ticket')
  const built = openRuntime(options)
  const dir = join(options.workspace, 'inbox', args.get('experiment') ?? 'E17')
  const watcher = new InboxWatcher({
    root: options.workspace,
    dir,
    ticketId: ticket,
    now: () => built.clock.now(),
    ingest: (taskId, observed) => {
      const outcome = built.runtime.observe({ ticketId: taskId, observed })
      process.stdout.write(`${JSON.stringify({ at: built.clock.now(), observed: observed.sourceRevision, ...outcome })}\n`)
      return outcome
    },
    log: (finding) => process.stdout.write(`${JSON.stringify({ at: built.clock.now(), scan: finding.status, path: finding.path, detail: finding.detail })}\n`),
  })
  const stop = watcher.start()
  process.stdout.write(`watching ${dir} for ticket ${ticket} (127.0.0.1 only, no network)\n`)
  const shutdown = (): void => {
    stop()
    built.db.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return new Promise(() => undefined)
}

// ---------------------------------------------------------------------------
// HTTP 面板
// ---------------------------------------------------------------------------

async function serve(options: CliOptions, args: Map<string, string>): Promise<number> {
  if (args.has('scheduler') || args.has('scheduler-once')) {
    // 显式实验入口：真实时钟 + 持久唤醒；默认 serve 不启用。
    const { runSchedulerService } = await import('../service/scheduler-service.ts')
    const report = await runSchedulerService({
      workspaceRoot: options.workspace,
      policy: options.policy,
      quiet: options.quiet,
      intervalMs: Number(args.get('interval-ms') ?? 1_000),
      ...(args.has('wake-after-ms') ? { wakeAfterMs: Number(args.get('wake-after-ms')) } : {}),
      ...(args.has('max-minutes') ? { maxRunMs: Number(args.get('max-minutes')) * 60_000 } : {}),
      ...(args.has('max-iterations') ? { maxIterations: Number(args.get('max-iterations')) } : {}),
      onLog: (line) => process.stdout.write(`${line}\n`),
    })
    print({ ok: true, ...report })
    return 0
  }
  const built = openRuntime(options)
  const port = Number(args.get('port') ?? 0)
  const panelPath = join(EXPERIMENT_ROOT, 'demo', 'panel-legacy.html')
  const server = createServer((request, response) => {
    handleRequest(built, options, panelPath, request, response).catch((error: unknown) => {
      sendJson(response, 500, { ok: false, error: (error as Error).message })
    })
  })
  server.listen(port, '127.0.0.1', () => {
    const address = server.address()
    const actual = typeof address === 'object' && address ? address.port : port
    process.stdout.write(`panel: http://127.0.0.1:${actual}/\n`)
    process.stdout.write(`workspace: ${options.workspace}\n`)
  })
  return new Promise(() => undefined)
}

async function handleRequest(
  built: BuiltRuntime,
  options: CliOptions,
  panelPath: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const html = readFileSync(panelPath)
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(html)
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/state') {
    const ticket = url.searchParams.get('ticket')
    const tasks = built.runtime.listTasks()
    const selected = ticket ?? tasks[0]?.ticketId
    sendJson(response, 200, {
      ok: true,
      now: built.clock.now(),
      policy: built.decision.id,
      implementation: built.decision.implementation,
      policyConfigSha: built.decision.configSha,
      taskCount: tasks.length,
      tasks: tasks.map((task) => {
        const summary: Record<string, unknown> = {
          ticketId: task.ticketId,
          title: task.title,
          stage: task.stage,
          status: task.status,
          taskRevision: task.taskRevision,
          openAttention: task.openAttention ?? null,
          result: task.result ?? null,
          analysis: task.analysis ?? null,
          completion: task.completion ?? null,
          diagnostics: task.diagnostics.slice(-4),
        }
        return summary
      }),
      selected: selected ? built.runtime.exportTask(selected) : null,
      notifications: selected ? built.runtime.notifications(selected) : [],
    })
    return
  }
  if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
    const body = await readJson(request)
    const action = url.pathname.slice('/api/'.length)
    if (action === 'delegate') {
      const goal = String(body.goal ?? body.title ?? '跟进实验')
      const result = built.runtime.delegate({
        title: String(body.title ?? '跟进实验'),
        goal,
        goalCondition: {
          requireResultArtifact: true,
          requireAnalysisArtifact: body.requireAnalysis !== false,
          requireReceipt: true,
          insufficientStatuses: ['failed', 'partial'],
        },
      })
      sendJson(response, 200, { ok: true, ...result })
      return
    }
    if (action === 'answer') {
      const taskId = String(body.ticketId ?? '')
      const task = built.runtime.getTask(taskId)
      const result = built.runtime.answer({
        attentionId: String(body.attentionId ?? ''),
        taskRevision: Number(body.taskRevision ?? task.taskRevision),
        optionId: String(body.optionId ?? ''),
      })
      sendJson(response, result.ok ? 200 : 409, { ok: result.ok, result })
      return
    }
    if (action === 'change') {
      const result = built.runtime.change({ ticketId: String(body.ticketId ?? ''), goal: String(body.goal ?? '') })
      sendJson(response, 200, result)
      return
    }
    if (action === 'cancel') {
      const result = built.runtime.cancel({ ticketId: String(body.ticketId ?? ''), reason: body.reason ? String(body.reason) : undefined })
      sendJson(response, 200, result)
      return
    }
    if (action === 'seed') {
      const result = seedResult({
        workspace: options.workspace,
        experimentId: String(body.experimentId ?? 'E17'),
        runId: String(body.runId ?? 'run-17'),
        revision: Number(body.revision ?? 1),
        status: (body.status ?? 'partial') as 'succeeded' | 'failed' | 'partial',
        total: Number(body.total ?? 40),
        passed: Number(body.passed ?? 29),
        failed: Number(body.failed ?? 11),
        corrupt: body.corrupt === true,
      })
      sendJson(response, 200, { ok: true, ...result })
      return
    }
    if (action === 'scan') {
      const ticket = String(body.ticketId ?? '')
      const findings = scanInbox(built, ticket, join(options.workspace, 'inbox', String(body.experimentId ?? 'E17')), built.clock.now())
      sendJson(response, 200, { ok: true, findings: findings.map((finding) => ({ status: finding.status, detail: finding.detail, path: finding.path })) })
      return
    }
    if (action === 'recover') {
      sendJson(response, 200, { ok: true, ...built.runtime.recover() })
      return
    }
    if (action === 'present') {
      const ticket = String(body.ticketId ?? '')
      if (!ticket) {
        sendJson(response, 400, { ok: false, error: 'ticketId required' })
        return
      }
      sendJson(response, 200, { ok: true, ...built.runtime.present(ticket) })
      return
    }
    if (action === 'deliver') {
      sendJson(response, 200, { ok: true, ...built.runtime.deliverPending() })
      return
    }
    if (action === 'reconcile') {
      const option = String(body.option ?? '')
      if (option !== 'accept_receipt' && option !== 'abandon_attempt') {
        sendJson(response, 400, { ok: false, error: 'option must be accept_receipt|abandon_attempt' })
        return
      }
      const result = built.runtime.reconcile({
        ticketId: String(body.ticketId ?? ''),
        option,
        ...(body.note ? { note: String(body.note) } : {}),
      })
      sendJson(response, result.ok ? 200 : 409, { ok: result.ok, result })
      return
    }
    sendJson(response, 404, { ok: false, error: `unknown action ${action}` })
    return
  }
  sendJson(response, 404, { ok: false, error: 'not found' })
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value, null, 2))
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer))
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function helpText(): string {
  return `R4 task-followup CLI（离线规则原型，不调用模型）

  node run.mjs delegate --title <t> --goal <g> [--no-analysis]
  node run.mjs status [--ticket <id>] [--export]
  node run.mjs seed --experiment E17 --status partial --revision 1
  node run.mjs observe --ticket <id> --experiment E17
  node run.mjs watch --ticket <id> --experiment E17
  node run.mjs present --ticket <id>            # 明确打开面板，产生呈现回执
  node run.mjs deliver                          # 通道把 queued 通知标记为 delivered
  node run.mjs answer --ticket <id> --option analyze_failing [--panel]
  node run.mjs change --ticket <id> --goal <g>
  node run.mjs cancel --ticket <id>
  node run.mjs tick --minutes 30 --clock <iso>  # 真实时钟拒绝逻辑前进
  node run.mjs recover
  node run.mjs reconcile --ticket <id> --option accept_receipt|abandon_attempt
  node run.mjs repair-memory
  node run.mjs serve [--port 0]
  node run.mjs host --workspace <dir> [--timezone Asia/Shanghai] [--demo-short-wait]   # 桌宠预览宿主
  node run.mjs demo
  node run.mjs eval
  node run.mjs test
  node run.mjs typecheck
  node run.mjs negative
  node run.mjs reveal --raw <raw.json>
  node run.mjs verify-eval
  node run.mjs crosscheck           # 独立重算 required/produced/visible/answered，与 summary 逐项比对
  node run.mjs crosscheck --external /path/independent-score-result.json   # 再与外部独立脚本对照
  node run.mjs test

  --workspace <dir>  默认 ${DEFAULT_WORKSPACE}
  --policy P0|P1|P2|P3  默认 P3
  --timezone UTC|Asia/Shanghai  显式应用时区，默认 UTC（不读宿主 TZ）
  --clock <iso>  受控时钟起点；tick 必须用它
  崩溃注入：PET_FOLLOWUP_CRASH_AT=ingest_persisted|pre_dispatch|effect_running|receipt_persisted
`
}

export async function main(argv: readonly string[]): Promise<void> {
  try {
    const code = await runCommand(argv)
    if (code !== 0) process.exitCode = code
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exitCode = 1
  }
}
