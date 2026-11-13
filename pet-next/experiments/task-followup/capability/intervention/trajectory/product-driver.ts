/**
 * Public trajectory -> the actual product host, InboxWatcher and persistent scheduler.
 * Historical preload uses the product database ONLY while its host is stopped.
 * Live inputs, presentation and answers use the same authenticated HTTP API as the panel.
 * Presentation is an explicitly labelled HTTP TEST CLIENT, not an Electron UI claim.
 *
 * node --experimental-transform-types --no-warnings product-driver.ts
 *   --trajectory <public trajectory.json> --producer <producer.mjs> --out <new directory>
 * Optional --dry-run checks actual host startup/tasks/HTTP/stop without a model call.
 */
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CapabilityMemoryStore } from '../../memory/store.ts'
import { extractPending } from '../../memory/extract.ts'
import { OpenAICompatibleClient, configFromEnv } from '../../model/openai-compatible.ts'
import { AnswerOutbox } from '../../../service/answer-outbox.ts'

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const iso = (ms = Date.now()) => new Date(ms).toISOString()
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, Math.max(0, ms)))
function must(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
const jsonFile = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = resolve(HERE, '../../../run.mjs')
const PRESENTER = 'http-test-client (not Electron UI)'

interface HostProcess {
  child: ChildProcess
  name: string
  exit: { code: number | null; signal: NodeJS.Signals | null } | null
  messages: any[]
}

async function main(): Promise<number> {
  if (!arg('--trajectory') || !arg('--producer') || !arg('--out')) {
    console.error('usage: --trajectory <file> --producer <file> --out <new dir> [--dry-run]')
    return 2
  }
  const TRAJECTORY = resolve(arg('--trajectory')!), PRODUCER = resolve(arg('--producer')!), OUT = resolve(arg('--out')!)
  const DRY = process.argv.includes('--dry-run')
  const ASSESSOR = arg('--assessor') ?? 'capability'
  must(['capability', 'capability-need-rule'].includes(ASSESSOR), 'unknown paired intervention arm')
  must(existsSync(TRAJECTORY) && existsSync(PRODUCER) && existsSync(RUN), 'trajectory, producer or product run.mjs missing')
  must(!existsSync(OUT), `refusing existing output directory: ${OUT}`)
  const source = readFileSync(TRAJECTORY)
  const trajectory = JSON.parse(source.toString('utf8'))
  must(trajectory.schema === 'pet-followup-public-trajectory/v1', 'unsupported trajectory schema')
  must(Array.isArray(trajectory.tasks) && Array.isArray(trajectory.turns) && Array.isArray(trajectory.timeline), 'incomplete trajectory')
  const turns = new Map<string, any>(trajectory.turns.map((t: any) => [t.id, t]))
  const definitions: any[] = trajectory.tasks
  for (const task of definitions) must(turns.has(task.goalTurnId) && /^[A-Za-z0-9_-]+$/.test(task.experimentId), `invalid task ${task.alias}`)
  if (!DRY) {
    const cfg = configFromEnv()
    must(cfg.ok, `live model not configured: ${cfg.ok ? '' : cfg.missing.join(', ')}`)
  }
  const WS = join(OUT, 'workspace'), LOGS = join(OUT, 'logs'), HTTP = join(OUT, 'http'), DRV = join(OUT, 'driver')
  for (const path of [WS, LOGS, HTTP, DRV]) mkdirSync(path, { recursive: true })
  const recordDir = join(OUT, 'model-io')
  const env: NodeJS.ProcessEnv = { ...process.env, PET_MODEL_RECORD_DIR: recordDir, PET_MODEL_DISABLE_THINKING: process.env.PET_MODEL_DISABLE_THINKING ?? '1' }
  const timezone = arg('--timezone') ?? trajectory.clock?.timezone ?? 'UTC'
  let origin = 0, httpSeq = 0, host: HostProcess | null = null, producer: ChildProcess | null = null
  let liveEnded = false, fatal: string | null = null
  const taskMap: Record<string, string> = {}
  const missed: any[] = [], responses: any[] = [], stopRecords: any[] = [], snapshots: any[] = [], failures: string[] = []
  const pendingResponses: Promise<void>[] = []
  const answers = new AnswerOutbox(join(DRV, 'answer-outbox.json'))
  let producerExit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
  const log = (kind: string, body: Record<string, unknown> = {}) => {
    const row = { at: iso(), elapsedMs: origin ? Date.now() - origin : null, kind, ...body }
    appendFileSync(join(DRV, 'timeline.jsonl'), JSON.stringify(row) + '\n', 'utf8')
    console.log(JSON.stringify(row))
  }
  const expand = (text: string) => text.replace(/\{\{origin([+-]\d+)\}\}/g, (_, offset) => iso(origin + Number(offset)))
  const lock = () => {
    const path = join(WS, 'state', 'host.json')
    if (!existsSync(path)) return null
    try { return jsonFile(path) } catch { return null }
  }
  const api = async (method: 'GET' | 'POST', route: string, body?: unknown) => {
    const current = lock()
    must(host && !host.exit && current?.state === 'ready' && current.pid === host.child.pid, 'product host is not ready')
    const id = ++httpSeq, startedAt = iso()
    const request = { method, route, body: body ?? null, hostPid: current.pid, port: current.port, client: PRESENTER, startedAt }
    try {
      const res = await fetch(`http://127.0.0.1:${current.port}${route}`, {
        method, headers: { 'x-followup-token': current.token, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
      })
      const text = await res.text()
      let json: any
      try { json = JSON.parse(text) } catch { json = { unparsedBody: text } }
      const result = { status: res.status, json }
      save(join(HTTP, `${String(id).padStart(6, '0')}.json`), { request, finishedAt: iso(), ...result })
      return result
    } catch (error) {
      save(join(HTTP, `${String(id).padStart(6, '0')}.json`), { request, finishedAt: iso(), error: String(error) })
      throw error
    }
  }
  async function startHost(name: string, seed = false) {
    must(!host || host.exit, 'cannot start another database writer')
    const argv = ['--experimental-transform-types', '--no-warnings', RUN, 'host', '--workspace', WS, '--timezone', timezone,
      '--demo-short-wait', '--assessor', seed ? 'none' : ASSESSOR, '--assessor-timeout-ms', process.env.PET_FOLLOWUP_ASSESSOR_TIMEOUT_MS ?? '500000']
    const child = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    const proc: HostProcess = { child, name, exit: null, messages: [] }
    host = proc
    const stream = createWriteStream(join(LOGS, `${name}.log`), { flags: 'wx' })
    child.stdout!.pipe(stream, { end: false }); child.stderr!.pipe(stream, { end: false })
    child.on('message', (m) => { proc.messages.push(m) })
    child.on('error', (error) => { log('host.process_error', { name, error: String(error) }) })
    child.on('exit', (code, signal) => { proc.exit = { code, signal }; stream.end(); log('host.exit', { name, pid: child.pid, code, signal }) })
    log('host.start', { name, pid: child.pid, argv, seed, clock: 'RealClock' })
    const until = Date.now() + 30000
    while (Date.now() < until) {
      must(!proc.exit, `host ${name} exited before ready: ${JSON.stringify(proc.exit)}`)
      const state = lock()
      if (state?.pid === child.pid && state.state === 'ready') {
        const health = await api('GET', '/api/health')
        must(health.status === 200 && health.json.pid === child.pid && health.json.clock === 'real', 'host health identity/clock mismatch')
        const overview = await api('GET', '/api/overview')
        if (!seed) must(overview.json.assessor?.spec === ASSESSOR && overview.json.canSay === true && !overview.json.modelUnavailable, 'product host did not enable the requested assessor')
        log('host.ready', { name, pid: child.pid, port: state.port, assessor: overview.json.assessor, judgment: overview.json.judgment })
        return
      }
      await sleep(100)
    }
    throw new Error(`host ${name} ready timeout`)
  }
  async function stopHost(reason: string) {
    const proc = host
    if (!proc) return
    const requestId = `product-driver-${proc.child.pid}-${Date.now()}`
    let sent = false, forced = false
    if (!proc.exit && proc.child.connected) {
      sent = proc.child.send({ type: 'pet-followup:stop', requestId })
      log('host.stop_request', { name: proc.name, pid: proc.child.pid, requestId, reason })
    }
    const until = Date.now() + 30000
    while (!proc.exit && Date.now() < until) await sleep(50)
    if (!proc.exit) {
      forced = true
      proc.child.kill()
      const cleanup = Date.now() + 5000
      while (!proc.exit && Date.now() < cleanup) await sleep(50)
    }
    const receipt = proc.messages.find((m) => m?.type === 'pet-followup:service-stopped' && m.requestId === requestId)
    const state = lock()
    const ok = Boolean(sent && !forced && proc.exit?.code === 0 && proc.exit.signal === null && receipt?.pid === proc.child.pid && receipt?.dbClosed === true && receipt.state === 'stopped' && state?.pid === proc.child.pid && state.state === 'stopped')
    const record = { name: proc.name, pid: proc.child.pid, reason, requestId, ok, forced, exit: proc.exit, receipt: receipt ?? null, lockState: state?.state }
    stopRecords.push(record); log('host.stopped', record)
    host = null
    if (!ok) failures.push(`host_stop_failed:${proc.name}`)
    must(proc.exit, 'host still alive: offline database access refused')
  }
  async function snapshot(label: string) {
    if (!host || host.exit) return
    const data: Record<string, unknown> = {}
    for (const [alias, ticket] of Object.entries(taskMap)) {
      const res = await api('GET', `/api/task?ticket=${encodeURIComponent(ticket)}`)
      must(res.status === 200 && res.json.ok, `cannot inspect task ${alias}`)
      data[alias] = res.json
    }
    const result = { at: iso(), label, data }
    snapshots.push(result); save(join(DRV, `snapshot-${String(snapshots.length).padStart(2, '0')}-${label}.json`), result)
    return data as Record<string, any>
  }
  async function release(turnId: string, context: Record<string, unknown> = {}) {
    const t = turns.get(turnId)
    must(t && t.role === 'user', `live product /say only supports user turns: ${turnId}`)
    const aliases: string[] = t.taskAliases ?? []
    const body = { text: expand(t.text), ...(aliases.length === 1 ? { ticketId: taskMap[aliases[0]!] } : {}) }
    const res = await api('POST', '/api/say', body)
    log('turn.released', { sourceTurnId: turnId, sourceSessionId: t.sessionId, taskAliases: aliases, body, status: res.status, response: res.json, metadataAdaptation: 'live product API assigns actual ingestion time/session/turnId; original ids retained here', ...context })
    must(res.status === 200 && res.json.ok, `say rejected: ${turnId}`)
    return res
  }
  async function responseWindow(spec: any) {
    const until = origin + spec.expiresAtMs, from = origin + spec.availableFromMs
    const seen = new Set<string>()
    log('user.window.open', { responseId: spec.id, from: iso(from), until: iso(until), presenter: PRESENTER })
    while (!liveEnded && Date.now() < until) {
      if (!host || host.exit) { await sleep(200); continue }
      const view = await api('GET', '/api/overview')
      const task = view.json.tasks?.find((x: any) => x.ticketId === taskMap[spec.taskAlias])
      const d = task?.decision
      const target = spec.requires?.renderedCurrentResult
      const resultMatches = task?.result?.runId === target?.runId && task?.result?.revision === target?.revision
      const eligible = d && d.deliveredAt && resultMatches && d.options?.some((o: any) => o.id === spec.requires.choiceOffered)
      if (eligible && !seen.has(d.attentionId) && Date.now() >= from) {
        seen.add(d.attentionId)
        // This client actually consumes the visible question/options/version, then
        // acknowledges presentation through the same endpoint as the real panel.
        log('test_client.rendered', { responseId: spec.id, client: PRESENTER, task, source: 'GET /api/overview' })
        const shown = await api('POST', '/api/present', { ticketId: task.ticketId, attentionId: d.attentionId })
        if (shown.status !== 200 || !shown.json.ok) { log('test_client.presentation_rejected', { responseId: spec.id, result: shown }); continue }
        const detail = await api('GET', `/api/task?ticket=${encodeURIComponent(task.ticketId)}`)
        const visible = detail.json.task?.decision
        if (!visible?.presentedAt || visible.attentionId !== d.attentionId || visible.decisionId !== d.decisionId) continue
        const captured = { ticketId: task.ticketId, attentionId: d.attentionId, decisionId: d.decisionId, taskRevision: task.taskRevision, optionId: spec.reply.optionId }
        const replyAt = Math.max(Date.parse(visible.presentedAt), from) + spec.reply.delayAfterPresentationMs
        while (!liveEnded && Date.now() < replyAt) await sleep(Math.min(200, replyAt - Date.now()))
        if (liveEnded || (Date.now() >= until && !spec.reply.sendEvenIfSuperseded)) break
        // The choice request is the actual authorization. Its source utterance is
        // retained in the driver log; /say follows only after the identity-bound
        // answer, so this explanatory message cannot invalidate its own question.
        const replyTurn = turns.get(spec.reply.turnId)
        log('user.choice_request', { responseId: spec.id, sourceTurnId: spec.reply.turnId, sourceText: replyTurn?.text, presentedAt: visible.presentedAt, client: PRESENTER, body: captured })
        const queued = answers.enqueue(captured, iso())
        log('answer.outbox.queued', { responseId: spec.id, outboxId: queued.id, payload: queued.payload })
        let delivered = queued
        let reportedOffline = false
        while (!liveEnded && delivered.state === 'pending') {
          await answers.flush(async (payload) => {
            try { return await api('POST', '/api/answer', payload) }
            catch (error) {
              if (!reportedOffline) {
                log('answer.outbox.transport_pending', { responseId: spec.id, outboxId: queued.id, error: String(error) })
                reportedOffline = true
              }
              throw error
            }
          })
          delivered = answers.list().find((r) => r.id === queued.id)!
          if (delivered.state === 'pending') await sleep(250)
        }
        if (delivered.state !== 'resolved' || !delivered.response) {
          missed.push({ responseId: spec.id, reason: 'answer_transport_pending_at_collection', outboxId: queued.id })
          log('answer.outbox.pending_at_collection', missed.at(-1))
          return
        }
        const result = { status: delivered.response.status, json: delivered.response.json as any }
        log('answer.outbox.resolved', { responseId: spec.id, outboxId: queued.id, status: result.status, payload: delivered.payload })
        const expectedReject = spec.reply.sendEvenIfSuperseded === true
        const accepted = result.status === 200 && result.json.ok === true
        const staleRejected = result.status === 409 && ['stale_decision', 'stale_answer'].includes(result.json.code ?? result.json.result?.code)
        const ok = expectedReject ? staleRejected : accepted
        const record = { responseId: spec.id, taskAlias: spec.taskAlias, captured, presentedAt: visible.presentedAt, repliedAt: iso(), accepted, expectedReject, ok, status: result.status, result: result.json }
        responses.push(record); log('user.response', record)
        if (!ok) missed.push({ responseId: spec.id, reason: 'answer_not_accepted_as_required', result })
        if (accepted && replyTurn) await release(spec.reply.turnId, { followsIdentityBoundAnswer: true })
        return
      }
      await sleep(300)
    }
    missed.push({ responseId: spec.id, reason: 'no_current_delivered_question_answered_in_window', seen: [...seen] })
    log('user.window.missed', missed.at(-1))
  }

  log('driver.start', { mode: DRY ? 'dry-interface-only' : 'real-model-product-host', trajectory: TRAJECTORY, trajectorySha: sha(source), producer: PRODUCER, producerSha: sha(readFileSync(PRODUCER)), productRun: RUN, productDriverSha: sha(readFileSync(fileURLToPath(import.meta.url))), node: process.version, pid: process.pid, presenter: PRESENTER, timezone,
    model: { baseUrl: env.PET_MODEL_BASE_URL ?? null, name: env.PET_MODEL_NAME ?? null, maxTokens: env.PET_MODEL_MAX_TOKENS ?? null, recordDir },
    scope: 'Controlled authored result producer and scripted HTTP user; actual product host/tools/model when not dry; not Electron UI or real-user outcome evidence' })
  let finalTasks: Record<string, any> = {}
  try {
    // Seed real product task identities and directory bindings without starting
    // any model assessment before the historical context has been preloaded.
    await startHost('host-0-seed', true)
    for (const def of definitions) {
      const goal = turns.get(def.goalTurnId)!.text
      const res = await api('POST', '/api/tasks', { title: def.title, dir: `inbox/${def.experimentId}`, goal })
      must(res.status === 200 && res.json.task?.ticketId, `task creation failed: ${def.alias}`)
      taskMap[def.alias] = res.json.task.ticketId
      log('task.created', { alias: def.alias, ticketId: taskMap[def.alias], dir: res.json.task.dir })
    }
    save(join(DRV, 'task-map.json'), taskMap)
    await snapshot('seed')
    await stopHost('historical-prelude-exclusive-writer')
    must(failures.length === 0, 'seed host did not stop cleanly')
    if (DRY) {
      save(join(OUT, 'DRY-RESULT.json'), { ok: true, mode: 'dry-interface-only', modelCalls: 0, producerStarted: false, actualProductHost: true, taskMap, stopRecords, notRun: ['memory extraction', 'model decisions', 'producer timeline', 'presentation/answer', 'artifact completion', 'Electron UI'] })
      log('driver.dry_done', { ok: true, modelCalls: 0 })
      return 0
    }
    const dbPath = join(WS, 'state', 'followup.sqlite')
    must(lock()?.state === 'stopped', 'prelude requires stopped product host')
    const memory = new CapabilityMemoryStore(dbPath)
    try {
      let seq = memory.turns().reduce((n, t) => Math.max(n, t.seq), 0)
      const historicalBase = Date.now()
      for (const id of trajectory.prelude.turnIds) {
        const t = turns.get(id)
        must(t && Number.isFinite(t.sourceOffsetMs), `invalid historical turn ${id}`)
        const raw = { turnId: t.id, sessionId: t.sessionId, seq: ++seq, at: iso(historicalBase + t.sourceOffsetMs), role: t.role, text: t.text, taskIds: (t.taskAliases ?? []).map((a: string) => taskMap[a]) }
        memory.appendTurn(raw)
        log('prelude.turn_persisted', { turn: raw, ingestedAt: iso() })
      }
      const cfg = configFromEnv(env)
      must(cfg.ok, 'model configuration missing for prelude')
      const client = new OpenAICompatibleClient(cfg.config)
      const maxCalls = Math.max(12, trajectory.prelude.turnIds.length * 2)
      let done = false, consecutiveFailures = 0
      for (let call = 1; call <= maxCalls; call++) {
        const result = await extractPending(memory, client, { entities: definitions.map((d) => ({ id: taskMap[d.alias]!, type: 'task', label: d.title })), now: iso(), maxTurns: 2, roles: ['user', 'assistant'], maxTokens: 1536 })
        save(join(DRV, `prelude-extraction-${String(call).padStart(2, '0')}.json`), result)
        log('prelude.extraction', { call, status: result.status, requestId: result.request?.requestId, detail: result.detail ?? null, accepted: result.report?.accepted.length ?? 0 })
        if (result.status === 'nothing') { done = true; break }
        consecutiveFailures = result.status === 'failed' ? consecutiveFailures + 1 : 0
        must(consecutiveFailures < 3, 'three consecutive prelude extraction failures')
      }
      const extracted = memory.extractedTurnIds()
      save(join(DRV, 'prelude-state.json'), { turns: memory.turns(), items: memory.items(), extractions: memory.extractions(), cursor: memory.cursor(), uncovered: memory.turns().filter((t) => !extracted.has(t.turnId)).map((t) => t.turnId), exhausted: !done })
      must(done, 'prelude extraction call limit exhausted')
    } finally { memory.close() }

    origin = Date.now()
    log('origin', { origin: iso(origin) })
    for (const event of [...trajectory.timeline].sort((a: any, b: any) => a.atMs - b.atMs)) {
      await sleep(Math.max(0, origin + event.atMs - Date.now()))
      log('timeline.event', { ...event, latenessMs: Date.now() - origin - event.atMs })
      if (event.kind === 'service.start') await startHost(event.instance)
      else if (event.kind === 'producer.start') {
        must(!producer, 'producer already started')
        const argv = [PRODUCER, '--trajectory', TRAJECTORY, '--workspace', WS, '--start-at', iso(origin)]
        producer = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        const stream = createWriteStream(join(LOGS, 'producer.log'), { flags: 'wx' })
        producer.stdout!.pipe(stream, { end: false }); producer.stderr!.pipe(stream, { end: false })
        producer.on('error', (error) => { failures.push(`producer_error:${String(error)}`); log('producer.error', { error: String(error) }) })
        producer.on('exit', (code, signal) => { producerExit = { code, signal }; stream.end(); log('producer.exit', { code, signal }) })
        log('producer.start', { pid: producer.pid, argv })
      } else if (event.kind === 'user.message') await release(event.turnId)
      else if (event.kind === 'service.stop') { await snapshot(`before-stop-${snapshots.length}`); await stopHost(event.reason) }
      else if (event.kind === 'user.response_window') {
        const spec = trajectory.userModel.responses.find((x: any) => x.id === event.responseId)
        must(spec, `response specification missing: ${event.responseId}`)
        pendingResponses.push(responseWindow(spec).catch((error) => { missed.push({ responseId: spec.id, reason: String(error) }); log('user.window.error', { responseId: spec.id, error: String(error) }) }))
      } else if (event.kind === 'collect_and_stop') break
      else throw new Error(`unsupported timeline event: ${event.kind}`)
    }
    liveEnded = true
    await Promise.all(pendingResponses)
    finalTasks = await snapshot('final') ?? {}
  } catch (error) {
    fatal = String(error); failures.push(fatal); log('driver.error', { error: fatal })
  } finally {
    liveEnded = true
    await Promise.all(pendingResponses)
    if (host) { try { await stopHost('driver-finish') } catch (error) { failures.push(String(error)) } }
    if (producer && producer.exitCode === null) {
      failures.push('producer_not_finished_at_end')
      producer.kill(); log('producer.forced_cleanup', { pid: producer.pid })
      await sleep(200)
    }
  }
  if (DRY) return failures.length ? 1 : 0
  // Child event callbacks update this asynchronously; do not let control-flow
  // narrowing assume the initial null still holds after the awaited live run.
  const observedProducerExit = producerExit as { code: number | null; signal: NodeJS.Signals | null } | null
  if (!observedProducerExit || observedProducerExit.code !== 0 || observedProducerExit.signal !== null) failures.push('producer_exit_not_successful')
  for (const spec of trajectory.userModel.responses) {
    if (!responses.some((r) => r.responseId === spec.id && r.ok) && !missed.some((r) => r.responseId === spec.id)) missed.push({ responseId: spec.id, reason: 'response_window_not_run' })
  }
  const artifacts: any[] = []
  for (const def of definitions) {
    const taskData = finalTasks[def.alias], task = taskData?.task
    const required = Boolean(def.requireAnalysis && task?.status !== 'cancelled') || responses.some((r) => r.taskAlias === def.alias && r.accepted)
    if (!required) { artifacts.push({ alias: def.alias, required: false, status: task?.status ?? 'unknown' }); continue }
    const report = task?.report, receipt = taskData?.receipts?.find((r: any) => r.receiptId === report?.receiptId)
    const path = report?.path ? resolve(WS, report.path) : null
    const rel = path ? relative(WS, path) : '..'
    const safe = path && !rel.startsWith('..') && !isAbsolute(rel)
    const outputSha = safe && existsSync(path) ? sha(readFileSync(path)) : null
    const input = receipt?.inputRef
    const resultPath = task?.result?.resultPath ? resolve(WS, task.result.resultPath) : null
    const resultRel = resultPath ? relative(WS, resultPath) : '..'
    const resultSha = resultPath && !resultRel.startsWith('..') && !isAbsolute(resultRel) && existsSync(resultPath) ? sha(readFileSync(resultPath)) : null
    const problems: string[] = []
    if (task?.status !== 'completed') problems.push('task_not_completed')
    if (!taskData?.completionCheck?.ok || taskData.completionCheck.inputConsistent !== true) problems.push('completion_check_failed')
    if (!report?.verified || outputSha !== report.sha256) problems.push('report_sha_unverified')
    if (!receipt?.ok || receipt.inputsVerified !== true || receipt.needsReconciliation) problems.push('receipt_not_verified')
    if (receipt?.outputSha256 !== outputSha) problems.push('receipt_output_sha_mismatch')
    if (!input || input.taskId !== task?.ticketId || input.taskRevision !== task?.taskRevision || input.runId !== task?.result?.runId || input.revision !== task?.result?.revision || input.resultFileSha !== resultSha || input.resultFileSha !== task?.result?.resultFileSha) problems.push('current_result_input_binding_mismatch')
    if (problems.length) failures.push(`artifact:${def.alias}:${problems.join(',')}`)
    artifacts.push({ alias: def.alias, required: true, ok: problems.length === 0, path, outputSha, resultSha, report, receipt, completionCheck: taskData?.completionCheck, problems })
  }
  const dbPath = join(WS, 'state', 'followup.sqlite')
  if (existsSync(dbPath) && lock()?.state === 'stopped') {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((x) => x.name)
      const exported: Record<string, unknown> = {}
      for (const table of tables) if (/^[A-Za-z0-9_]+$/.test(table)) exported[table] = db.prepare(`SELECT * FROM "${table}"`).all()
      save(join(DRV, 'product-db-export.json'), exported)
    } finally { db.close() }
  }
  const ok = failures.length === 0 && missed.length === 0
  const end = { schema: 'pet-product-trajectory-result/v1', ok, trajectory: trajectory.id, origin: origin ? iso(origin) : null, finishedAt: iso(), presenter: PRESENTER, modelRequests: recordDir, taskMap, finalTasks, responses, missed, artifacts, stopRecords, producerExit, failures, fatal,
    notProven: ['Electron UI presentation', 'real user interruption benefit', 'heldout performance', 'real experiment outputs (producer is authored development data)'] }
  save(join(OUT, 'END-STATE.json'), end)
  log('driver.done', { ok, artifacts: artifacts.map((a) => ({ alias: a.alias, required: a.required, ok: a.ok })), missed: missed.length, failures })
  return ok ? 0 : 1
}

try { process.exitCode = await main() }
catch (error) { console.error(String(error)); process.exitCode = 2 }
