/**
 * 公共轨迹贯通驱动（RealClock，无手动 tick）。
 *   node driver.ts --trajectory <abs .trajectory.json> --producer <abs producer.mjs> --out <新目录>
 * 驱动读取轨迹 timeline/userModel 只用于：按真实时间释放原话、启停服务子进程、扮演脚本用户。
 * 服务子进程只收到已释放的原话（mailbox）与 tasks.json（别名→实验号映射），永不接触 timeline/排程/userModel/expectations。
 * 脚本用户只读 state/cards/ 里真实呈现的卡片；窗口内没有满足条件的卡片则记为 missed，不伪造。
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv
const argOf = (k: string) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : undefined)
if (!argOf('--trajectory') || !argOf('--producer') || !argOf('--out')) { console.error('usage: --trajectory <file> --producer <producer.mjs> --out <new dir>'); process.exit(2) }
const TRAJ = resolve(argOf('--trajectory')!)
const PRODUCER = resolve(argOf('--producer')!)
const OUT = resolve(argOf('--out')!)
if (existsSync(join(OUT, 'driver'))) { console.error('refusing to reuse out dir'); process.exit(2) }
const HERE = dirname(fileURLToPath(import.meta.url))
const SERVICE = join(HERE, 'service.ts')
const STATE = join(OUT, 'state'), WS = join(OUT, 'workspace'), LOGS = join(OUT, 'logs'), DRV = join(OUT, 'driver')
for (const d of [STATE, WS, LOGS, DRV, join(STATE, 'mailbox'), join(STATE, 'cards'), join(STATE, 'receipts'), join(STATE, 'events')]) mkdirSync(d, { recursive: true })
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const iso = (ms = Date.now()) => new Date(ms).toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const trajBytes = readFileSync(TRAJ)
const traj = JSON.parse(trajBytes.toString('utf8'))
let origin = 0
function log(kind: string, x: Record<string, unknown> = {}) {
  const line = { at: iso(), tMs: origin ? Date.now() - origin : null, kind, ...x }
  appendFileSync(join(DRV, 'timeline.jsonl'), JSON.stringify(line) + '\n')
  console.log(JSON.stringify(line))
}
log('driver.start', { trajectory: TRAJ, trajectorySha: sha(trajBytes), id: traj.id, producer: PRODUCER, producerSha: sha(readFileSync(PRODUCER)), node: process.version, pid: process.pid,
  model: { baseUrl: process.env.PET_MODEL_BASE_URL, name: process.env.PET_MODEL_NAME, temperature: process.env.PET_MODEL_TEMPERATURE, maxTokens: process.env.PET_MODEL_MAX_TOKENS, assessMax: process.env.PET_ASSESS_MAX_TOKENS, extractMax: process.env.PET_EXTRACT_MAX_TOKENS, disableThinking: process.env.PET_MODEL_DISABLE_THINKING, timeoutMs: process.env.PET_MODEL_TIMEOUT_MS } })
writeFileSync(join(STATE, 'tasks.json'), JSON.stringify(traj.tasks.map((t: any) => ({ alias: t.alias, title: t.title, experimentId: t.experimentId, goalTurnId: t.goalTurnId })), null, 2))
const turnById = new Map<string, any>(traj.turns.map((t: any) => [t.id, t]))
let mailSeq = 0
const expand = (s: string) => s.replace(/\{\{origin([+-]\d+)\}\}/g, (_, x) => iso(origin + Number(x)))
function release(turnId: string, extra: Record<string, unknown> = {}, sourceAt?: string) {
  const t = turnById.get(turnId)
  const msg = { turnId: t.id, sessionId: t.sessionId, role: t.role, taskAliases: t.taskAliases, text: expand(t.text), releasedAt: iso(), ...(sourceAt ? { sourceAt } : {}), ...extra }
  mailSeq++
  writeFileSync(join(STATE, 'mailbox', `${String(mailSeq).padStart(4, '0')}-${t.id}.json`), JSON.stringify(msg, null, 2))
  log('turn.released', { turnId: t.id, role: t.role, taskAliases: t.taskAliases, text: msg.text, ...extra })
}

let service: ChildProcess | null = null
let serviceName = ''
function startService(instance: string, prelude = false): ChildProcess {
  const out = createWriteStream(join(LOGS, `${instance}.log`))
  const c = spawn(process.execPath, [SERVICE, '--state', STATE, '--workspace', WS, '--instance', instance, ...(prelude ? ['--prelude'] : [])], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: process.env })
  c.stdout!.pipe(out); c.stderr!.pipe(out)
  log('service.start', { instance, pid: c.pid, prelude })
  return c
}
async function stopService(reason: string) {
  if (!service || service.exitCode !== null) { log('service.stop.skip', { reason, note: 'not running', exitCode: service?.exitCode ?? null }); service = null; return }
  const c = service, t0 = Date.now()
  const exited = new Promise<number | null>((r) => c.once('exit', (code) => r(code)))
  c.send({ type: 'stop' })
  const code = await Promise.race([exited, sleep(20_000).then(() => 'timeout' as const)])
  if (code === 'timeout') { c.kill(); log('service.killed', { instance: serviceName, pid: c.pid, reason: 'no exit within 20s of stop' }); await exited }
  log('service.stopped', { instance: serviceName, pid: c.pid, reason, exitCode: c.exitCode, stopMs: Date.now() - t0 })
  service = null
}

// ---------- 历史前奏：起点前顺序注入并抽取，不执行任何动作 ----------
const preludeAt = Date.now()
for (const id of traj.prelude.turnIds) release(id, {}, iso(preludeAt + turnById.get(id).sourceOffsetMs))
serviceName = 'service-0-prelude'
service = startService(serviceName, true)
await new Promise((r) => service!.once('exit', r))
log('prelude.service.exit', { exitCode: service.exitCode, wallMs: Date.now() - preludeAt })
service = null

// ---------- 实时段 ----------
origin = Date.now()
log('origin', { origin: iso(origin) })
let producer: ChildProcess | null = null
const missed: any[] = []
const userTasks: Promise<void>[] = []
function cards(): any[] {
  return readdirSync(join(STATE, 'cards')).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(readFileSync(join(STATE, 'cards', f), 'utf8')) } catch { return null } }).filter(Boolean)
}
async function responseWindow(spec: any) {
  const from = origin + spec.availableFromMs, until = origin + spec.expiresAtMs
  const req = spec.requires
  log('user.window.open', { responseId: spec.id, from: iso(from), until: iso(until) })
  const seenCards = new Set<string>()
  while (Date.now() < until) {
    for (const c of cards()) {
      if (seenCards.has(c.cardId)) continue
      seenCards.add(c.cardId)
      const m = (c.members ?? []).find((x: any) => x.alias === spec.taskAlias)
      const okResult = m?.result && m.result.runId === req.renderedCurrentResult.runId && m.result.revision === req.renderedCurrentResult.revision
      const okChoice = m?.options?.some((o: any) => o.optionId === req.choiceOffered)
      log('user.saw_card', { cardId: c.cardId, presentedAt: c.presentedAt, member: m ? { alias: m.alias, kind: m.kind, question: m.question, result: m.result && `${m.result.runId}-r${m.result.revision}`, options: m.options?.map((o: any) => o.optionId) } : null, satisfies: { presented: !!c.presentedAt, renderedCurrentResult: !!okResult, choiceOffered: !!okChoice } })
      if (m && c.presentedAt && okResult && okChoice) {
        const replyAt = Math.max(Date.parse(c.presentedAt), from) + spec.reply.delayAfterPresentationMs
        await sleep(Math.max(0, replyAt - Date.now()))
        if (Date.now() >= until) break
        release(spec.reply.turnId, { reply: { cardId: c.cardId, decisionId: m.decisionId, optionId: spec.reply.optionId } })
        log('user.replied', { responseId: spec.id, cardId: c.cardId, decisionId: m.decisionId, optionId: spec.reply.optionId, presentedAt: c.presentedAt })
        return
      }
    }
    await sleep(Date.now() < from ? Math.min(500, from - Date.now()) : 250)
  }
  missed.push({ responseId: spec.id, cardsSeen: [...seenCards] })
  log('user.response.missed', { responseId: spec.id, cardsSeen: [...seenCards], note: spec.ifMissing })
}

for (const e of [...traj.timeline].sort((a: any, b: any) => a.atMs - b.atMs)) {
  await sleep(Math.max(0, origin + e.atMs - Date.now()))
  log('timeline', { event: e.kind, atMs: e.atMs, latenessMs: Date.now() - origin - e.atMs })
  if (e.kind === 'service.start') { serviceName = e.instance; service = startService(e.instance) }
  else if (e.kind === 'producer.start') {
    producer = spawn(process.execPath, [PRODUCER, '--trajectory', TRAJ, '--workspace', WS, '--start-at', iso(origin)], { stdio: ['ignore', 'pipe', 'pipe'] })
    const out = createWriteStream(join(LOGS, 'producer.log')); producer.stdout!.pipe(out); producer.stderr!.pipe(out)
    log('producer.start', { pid: producer.pid })
  } else if (e.kind === 'user.message') release(e.turnId)
  else if (e.kind === 'service.stop') await stopService(e.reason)
  else if (e.kind === 'user.response_window') userTasks.push(responseWindow(traj.userModel.responses.find((r: any) => r.id === e.responseId)))
  else if (e.kind === 'collect_and_stop') break
  else log('timeline.unknown', { event: e })
}
await stopService('collect_and_stop')
await Promise.all(userTasks)
if (producer && producer.exitCode === null) { producer.kill(); log('producer.killed', { pid: producer.pid }) } else log('producer.exit', { pid: producer?.pid, exitCode: producer?.exitCode })

// ---------- 汇总 ----------
const hostState = JSON.parse(readFileSync(join(STATE, 'host.json'), 'utf8'))
const receipts = readdirSync(join(STATE, 'receipts')).map((f) => JSON.parse(readFileSync(join(STATE, 'receipts', f), 'utf8')))
const artifacts = receipts.map((r) => { const p = join(WS, r.output.path); const ok = existsSync(p); return { path: p, exists: ok, sha256: ok ? sha(readFileSync(p)) : null, matchesReceipt: ok && sha(readFileSync(p)) === r.output.sha256 } })
const exports = readdirSync(join(STATE, 'events')).filter((f) => f.startsWith('export-')).sort()
const lastExport = exports.length ? JSON.parse(readFileSync(join(STATE, 'events', exports.at(-1)!), 'utf8')) : null
const end = { trajectory: traj.id, origin: iso(origin), finishedAt: iso(), wallMs: Date.now() - origin, tasks: hostState.tasks, instances: hostState.instances, cards: cards(), receipts, artifacts, missed, waits: lastExport?.waits, notices: lastExport?.notices,
  counters: Object.fromEntries(exports.map((f) => [f, JSON.parse(readFileSync(join(STATE, 'events', f), 'utf8')).counters])), producerEvidence: existsSync(join(WS, 'producer-evidence')) ? readdirSync(join(WS, 'producer-evidence')) : [] }
writeFileSync(join(OUT, 'END-STATE.json'), JSON.stringify(end, null, 2))
log('driver.done', { artifacts, missed: missed.length })
process.exit(0)
