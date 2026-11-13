/**
 * 长期委托贯通实跑（真实模型 + RealClock + 独立生产者进程 + 中途重启）。
 *   node capability/intervention/dev-story/through-run.ts --out <新目录> [--budget-s 480]
 * 模型配置走 PET_MODEL_* 环境变量（见 model/README.md）；PET_MODEL_RECORD_DIR 未设时记录到 <out>/model-io。
 *
 * 这里的“宿主”是最小模拟：任务版本/assignment/选项/结果观察/执行都在本脚本里，
 * 用于证明能力模块在长期委托中的行为；真实接线由集成负责人在 service/host 完成。
 * 用户发言与用户点选是脚本化的（标注 scripted-user）；模型输出全部来自真实调用。
 * 短演示配置：生产者 delay 和“接下来 N 分钟开会”都是真实时间（秒级/分钟级），无假时钟、无手动 tick。
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CapabilityMemoryStore } from '../../memory/store.ts'
import { extractPending } from '../../memory/extract.ts'
import { readForDecision } from '../../memory/read.ts'
import { assess, submitAssessment } from '../assess.ts'
import type { AssessSnapshot } from '../assess.ts'
import { InterventionStore } from '../planner.ts'
import type { NoticeRow } from '../planner.ts'
import { OpenAICompatibleClient } from '../../model/openai-compatible.ts'

const argv = process.argv
const argOf = (k: string, d?: string) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d)
const OUT = resolve(argOf('--out') ?? '')
if (!argOf('--out')) { console.error('usage: --out <new-dir>'); process.exit(2) }
if (existsSync(join(OUT, 'timeline.jsonl'))) { console.error('refusing to overwrite; use a new --out'); process.exit(2) }
const BUDGET_S = Number(argOf('--budget-s', '480'))
/** 仅用于本地冒烟：缩放生产者真实延迟；正式贯通保持 1 */
const SCALE = Number(argOf('--time-scale', '1'))
const HERE = dirname(fileURLToPath(import.meta.url))
const WORK = join(OUT, 'work')
const STEPS = join(OUT, 'steps')
mkdirSync(WORK, { recursive: true })
mkdirSync(STEPS, { recursive: true })
process.env.PET_MODEL_RECORD_DIR ??= join(OUT, 'model-io')
const client = new OpenAICompatibleClient()
const T0 = Date.now()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
function iso(ms = Date.now()): string {
  const d = new Date(ms + 8 * 3600_000)
  return d.toISOString().replace('Z', '+08:00')
}
const elapsed = () => Math.round((Date.now() - T0) / 1000)

// ---------------- 最小宿主状态（落盘，重启时重新加载） ----------------
interface TaskState { id: string; title: string; goal: string; revision: number; assignmentId: string | null; config: string | null; status: string; cancelled: boolean; latestResultFile: string | null }
interface HostState { tasks: Record<string, TaskState>; seenFiles: Record<string, string>; seq: number; stepNo: number; flags: Record<string, boolean>; modelCalls: number }
const HOST = join(OUT, 'host-state.json')
let host: HostState = {
  tasks: {
    'task:A': { id: 'task:A', title: '任务A 分类评测', goal: '跟进评测结果，失败时让用户选择是否分析', revision: 1, assignmentId: null, config: null, status: 'created', cancelled: false, latestResultFile: null },
    'task:B': { id: 'task:B', title: '任务B 分类评测', goal: '跟进评测结果，失败时让用户选择是否分析', revision: 1, assignmentId: null, config: null, status: 'created', cancelled: false, latestResultFile: null },
  },
  seenFiles: {}, seq: 0, stepNo: 0, flags: {}, modelCalls: 0,
}
const saveHost = () => writeFileSync(HOST, JSON.stringify(host, null, 2))
const DB = join(OUT, 'capability.sqlite')
let store = new CapabilityMemoryStore(DB)
let plan = new InterventionStore(store.db)
const entities = [
  { id: 'task:A', type: 'task', label: '任务A 分类评测' },
  { id: 'task:B', type: 'task', label: '任务B 分类评测' },
]
const KEYS = ['config', 'notificationPolicy', 'availability', 'deadline']
const counters = { preGuardErrors: [] as any[], guardCaught: [] as any[], modelFailures: [] as any[] }

function log(name: string, summary: Record<string, unknown>, detail?: unknown) {
  host.stepNo++
  const file = `${String(host.stepNo).padStart(2, '0')}-${name}.json`
  if (detail !== undefined) writeFileSync(join(STEPS, file), JSON.stringify(detail, null, 2))
  const line = { at: iso(), elapsedS: elapsed(), step: host.stepNo, name, ...summary, ...(detail !== undefined ? { detailFile: `steps/${file}` } : {}) }
  appendFileSync(join(OUT, 'timeline.jsonl'), JSON.stringify(line) + '\n')
  console.log(`[${line.elapsedS}s] #${host.stepNo} ${name} ${JSON.stringify(summary)}`)
  saveHost()
}

function addTurn(sessionId: string, role: 'user' | 'tool', text: string, taskIds: string[], label: string) {
  host.seq++
  const turn = { turnId: `turn-${String(host.seq).padStart(3, '0')}`, sessionId, seq: host.seq, at: iso(), role, text, taskIds }
  store.appendTurn(turn)
  log('turn', { label, turnId: turn.turnId, role, taskIds, text })
  return turn
}

async function extract(label: string) {
  const r = await extractPending(store, client, { entities, now: iso(), keyVocabulary: KEYS })
  if (r.request) host.modelCalls++
  const detail = { requestId: r.request?.requestId, status: r.status, detail: r.detail ?? null, parseError: r.report?.parseError ?? null, accepted: r.report?.accepted ?? [], rejected: r.report?.rejected ?? [] }
  if (r.status === 'failed') counters.modelFailures.push({ stage: 'extract', label, detail: r.detail ?? r.report?.parseError })
  for (const rej of r.report?.rejected ?? []) counters.guardCaught.push({ stage: 'extract', label, reason: rej.reason })
  for (const it of r.report?.accepted ?? []) for (const c of it.checks) if (c.startsWith('authority_downgraded') || c.startsWith('scope_not_in') || c.startsWith('supersede_')) counters.guardCaught.push({ stage: 'extract', label, itemId: it.itemId, check: c })
  log('extract', { label, status: r.status, accepted: detail.accepted.map((i: any) => `${i.kind}:${i.key}=${JSON.stringify(i.value)}@${i.scope.level}${i.scope.id ? ':' + i.scope.id : ''}/${i.status}`), rejected: detail.rejected }, detail)
}

function optionsFor(t: TaskState): AssessSnapshot['options'] {
  if (t.cancelled || !t.latestResultFile) return []
  const r = JSON.parse(readFileSync(join(WORK, t.latestResultFile), 'utf8'))
  if (r.kind !== 'result' || r.assignment !== t.assignmentId) return []
  if (r.status === 'failed' && !existsSync(join(WORK, `analysis-${r.assignment}.md`))) {
    return [
      { optionId: 'analyze-failures', label: '分析失败样本并生成报告' },
      { optionId: 'rerun', label: '用当前配置重跑' },
      { optionId: 'accept-and-close', label: '接受当前结果并结束' },
    ]
  }
  return []
}

function snapshotOf(t: TaskState): AssessSnapshot {
  let latestResult: AssessSnapshot['latestResult'] = null
  if (t.latestResultFile) {
    const r = JSON.parse(readFileSync(join(WORK, t.latestResultFile), 'utf8'))
    // 入口隔离：旧派工（assignment 不等于当前）的结果不能作为当前 latestResult，也不能盖上当前任务修订号
    if (r.assignment !== t.assignmentId) return { taskId: t.id, title: t.title, goal: t.goal, taskRevision: t.revision, assignmentId: t.assignmentId, status: t.cancelled ? 'cancelled' : t.status, stage: t.status, now: iso(), latestResult: null, options: [] }
    latestResult = { sourceId: t.latestResultFile, revision: t.revision, status: r.kind === 'progress' ? 'in_progress' : r.status, summary: r.kind === 'progress' ? `已处理${r.processed}/${r.total}，错误${r.errorsSoFar}` : `正确${r.correct}/${r.total}，准确率${r.accuracy}，失败样本${r.failures.join(',') || '无'}`, assignment: r.assignment, artifact: r.reportFile ?? null }
  }
  return { taskId: t.id, title: t.title, goal: t.goal, taskRevision: t.revision, assignmentId: t.assignmentId, status: t.cancelled ? 'cancelled' : t.status, stage: t.status, now: iso(), latestResult, options: optionsFor(t) }
}

async function assessTask(taskId: string, label: string) {
  const t = host.tasks[taskId]!
  const snapshot = snapshotOf(t)
  const packet = readForDecision(store, { taskId, asOf: snapshot.now, intent: 'current', question: `${t.title}：现在按什么配置？此刻需要找我吗？`, requiredSlots: ['config'], budget: { maxItems: 30, maxChars: 6000 } })
  const record = await assess(snapshot, packet, undefined, client, { text: '现在该做什么：等待、马上问我、合并到摘要、直接执行某个选项，还是什么都不做？', requestedFactKeys: ['config'] })
  host.modelCalls++
  // 回交时读取“当前”任务状态（评估期间可能已变化）
  const cur = host.tasks[taskId]!
  const submit = submitAssessment(record, packet, { taskRevision: cur.revision, assignmentId: cur.assignmentId, now: iso() }, store, snapshot)
  const outcome = plan.apply(record, submit, iso())
  if (record.failure) counters.modelFailures.push({ stage: 'assess', label, failure: record.failure })
  else if (!submit.accepted) counters.guardCaught.push({ stage: 'assess', label, code: submit.code, detail: submit.detail })
  if (outcome.type === 'rejected' && outcome.code === 'task_cancelled') counters.guardCaught.push({ stage: 'plan', label, code: 'task_cancelled' })
  const p = record.proposal
  log('assess', {
    label, taskId, revision: snapshot.taskRevision, assignment: snapshot.assignmentId, memoryCursor: packet.memoryCursor,
    packetCurrent: [...packet.commitments, ...packet.currentFacts, ...packet.preferences].map((i) => `${i.key}=${JSON.stringify(i.value)}`),
    nonActionable: packet.context.nonActionable.map((i) => `${i.key}=${JSON.stringify(i.value)}/${i.status}`),
    missing: packet.missing, conflicts: packet.conflicts.length,
    preGuard: p ? `${p.kind}/${p.reasonCode}${p.wakeAt ? ' wake=' + p.wakeAt : ''}${p.deliverAt ? ' deliver=' + p.deliverAt : ''}${p.optionIds.length ? ' opt=' + p.optionIds.join(',') : ''}` : `FAIL ${record.failure?.code}`,
    question: p?.question ?? null, guard: submit.code, outcome: outcome.type, ...(outcome.type === 'waiting' ? { recheckAt: outcome.wait.recheckAt } : {}), ...(outcome.type === 'notified' ? { notice: outcome.notice.noticeId, mode: outcome.notice.mode, deliverAt: outcome.notice.deliverAt } : {}),
  }, { snapshot, packet, requestId: record.request.requestId, model: record.model, sessionId: record.sessionId, rawText: record.rawText, preGuardProposal: p, guardAfter: submit, outcome })
  if (outcome.type === 'execute') await execute(taskId, outcome.optionId, 'model-act', outcome.decisionId)
}

function startProducer(task: string, config: string, assignment: string, delayMs: number, progressAt = 0) {
  const samples = join(HERE, task === 'task:A' ? 'samples-A.json' : 'samples-B.json')
  const args = [join(HERE, 'producer.mjs'), 'run', '--samples', samples, '--config', config, '--assignment', assignment, '--out', WORK, '--delay-ms', String(Math.round(delayMs * SCALE)), '--progress-at', String(progressAt)]
  const child = spawn(process.execPath, args, { stdio: 'ignore', detached: false })
  log('producer-start', { task, config, assignment, pid: child.pid, delayMs })
}

async function execute(taskId: string, optionId: string, by: string, decisionId: string) {
  const t = host.tasks[taskId]!
  const offered = optionsFor(t)!.map((o) => o.optionId)
  if (t.cancelled || !offered.includes(optionId)) {
    counters.guardCaught.push({ stage: 'execute', taskId, optionId, code: 'option_not_current' })
    log('execute-refused', { taskId, optionId, by, offered })
    return
  }
  if (optionId === 'analyze-failures') {
    const resultFile = join(WORK, t.latestResultFile!)
    await new Promise<void>((ok, bad) => {
      const c = spawn(process.execPath, [join(HERE, 'producer.mjs'), 'analyze', '--result', resultFile, '--samples', join(HERE, taskId === 'task:A' ? 'samples-A.json' : 'samples-B.json'), '--out', WORK], { stdio: 'ignore' })
      c.on('exit', (code) => (code === 0 ? ok() : bad(new Error(`analyze exit ${code}`))))
    })
    const artifact = `analysis-${t.assignmentId}.md`
    const text = readFileSync(join(WORK, artifact))
    t.status = 'analysis_delivered'
    log('execute', { taskId, optionId, by, decisionId, artifact: join(WORK, artifact), sha256: sha(text) })
    addTurn('host', 'tool', `${t.title} 运行${t.assignmentId} 失败样本分析报告已生成：${artifact}（sha256=${sha(text).slice(0, 16)}）。`, [taskId], 'artifact')
    host.seenFiles[artifact] = sha(text)
  } else {
    t.status = optionId === 'accept-and-close' ? 'done' : t.status
    log('execute', { taskId, optionId, by, decisionId, note: 'non-analysis option recorded only' })
  }
}

// 结果观察：轮询工作目录（真实文件、按 SHA 去重）
async function observe() {
  for (const f of readdirSync(WORK).filter((x) => /^(result|progress)-.*\.json$/.test(x)).sort()) {
    const buf = readFileSync(join(WORK, f))
    const h = sha(buf)
    if (host.seenFiles[f] === h) continue
    host.seenFiles[f] = h
    const r = JSON.parse(buf.toString('utf8'))
    const taskId = `task:${r.task}`
    const t = host.tasks[taskId]!
    t.latestResultFile = f
    if (r.kind === 'result' && r.assignment === t.assignmentId && !t.cancelled) t.status = r.status === 'passed' ? 'result_passed' : 'result_failed'
    const text = r.kind === 'progress'
      ? `${t.title} 运行${r.assignment}（配置${r.config}）进度：已处理${r.processed}/${r.total}，目前错误${r.errorsSoFar}个。文件${f} sha256=${h.slice(0, 16)}`
      : `${t.title} 运行${r.assignment}（配置${r.config}）完成：正确${r.correct}/${r.total}，准确率${r.accuracy}，${r.failures.length ? '失败样本' + r.failures.join('、') : '没有失败样本'}。结果${f} sha256=${h.slice(0, 16)}，报告${r.reportFile}`
    addTurn('host', 'tool', text, [taskId], `observed:${f}`)
    plan.evidenceArrived(taskId, iso(), f)
    await extract(`after ${f}`)
    await assessTask(taskId, `observed ${f}`)
    if (r.kind === 'progress' && r.task === 'B' && !host.flags.restarted1) await restart('mid-run restart #1')
  }
}

async function restart(label: string) {
  store.close()
  // 丢弃内存对象，从磁盘重建
  host = JSON.parse(readFileSync(HOST, 'utf8'))
  store = new CapabilityMemoryStore(DB)
  plan = new InterventionStore(store.db)
  host.flags.restarted1 = true
  const a = readForDecision(store, { taskId: 'task:A', asOf: iso(), intent: 'current', question: '配置', requiredSlots: ['config'], budget: { maxItems: 30, maxChars: 6000 } })
  const b = readForDecision(store, { taskId: 'task:B', asOf: iso(), intent: 'current', question: '配置', requiredSlots: ['config'], budget: { maxItems: 30, maxChars: 6000 } })
  log('restart', { label, turns: store.turns().length, items: store.items().length, A: [...a.commitments, ...a.currentFacts].map((i) => `${i.key}=${JSON.stringify(i.value)}`), B: [...b.commitments, ...b.currentFacts].map((i) => `${i.key}=${JSON.stringify(i.value)}`), waits: plan.waits().filter((w) => w.status === 'waiting').length, openNotices: plan.notices().filter((n) => n.status === 'open').length, nextWakeAt: plan.nextWakeAt() })
}

async function present(n: NoticeRow) {
  plan.markSeen(n.noticeId, iso())
  log('present', { noticeId: n.noticeId, mode: n.mode, members: n.members.map((m) => `${m.taskId} r${m.taskRevision} ${m.assignmentId} ${m.kind}/${m.reasonCode} ${m.status}: ${m.question ?? ''}`) }, n)
  for (const m of n.members) {
    if (m.status !== 'pending') continue
    const t = host.tasks[m.taskId]!
    const offered = optionsFor(t)!.map((o) => o.optionId)
    // scripted-user：对“当前”任务的失败结果选择分析；对其他条目只确认已读
    if (m.kind === 'ask' && offered.includes('analyze-failures')) {
      const ok = plan.answer(n.noticeId, m.decisionId, 'analyze-failures')
      log('scripted-user-answer', { noticeId: n.noticeId, decisionId: m.decisionId, taskId: m.taskId, answer: 'analyze-failures', accepted: ok })
      if (ok) {
        if (m.taskRevision !== t.revision || m.assignmentId !== t.assignmentId) {
          counters.guardCaught.push({ stage: 'answer', code: 'stale_decision', decisionId: m.decisionId })
          log('execute-refused', { reason: 'decision version != current task', member: m })
        } else await execute(m.taskId, 'analyze-failures', 'user', m.decisionId)
      }
    } else {
      const ok = plan.answer(n.noticeId, m.decisionId, 'ack')
      log('scripted-user-answer', { noticeId: n.noticeId, decisionId: m.decisionId, taskId: m.taskId, answer: 'ack', accepted: ok, note: m.kind === 'ask' ? 'ask without a current actionable option' : 'digest acknowledged' })
    }
  }
}

// ---------------- 时间线 ----------------
writeFileSync(join(OUT, 'RUN-CONFIG.json'), JSON.stringify({
  startedAt: iso(T0), budgetS: BUDGET_S, timeScale: SCALE, labels: { scriptedUser: true, shortDemoDelays: true, realClock: true, manualTick: false },
  model: { baseUrl: process.env.PET_MODEL_BASE_URL, name: process.env.PET_MODEL_NAME, maxTokens: process.env.PET_MODEL_MAX_TOKENS, temperature: process.env.PET_MODEL_TEMPERATURE ?? '0', disableThinking: process.env.PET_MODEL_DISABLE_THINKING === '1', timeoutMs: process.env.PET_MODEL_TIMEOUT_MS },
  node: process.version, platform: process.platform,
}, null, 2))

const s1 = 'session-1'
addTurn(s1, 'user', '通常只在需要我决定的时候提醒我，正常进度不用每次告诉我。', [], 'scripted-user')
addTurn(s1, 'user', '任务A：用样本集跑分类评测，先用基线配置v1。', ['task:A'], 'scripted-user')
addTurn(s1, 'user', '任务B也跑同样的评测，用基线配置v1。', ['task:B'], 'scripted-user')
host.tasks['task:A']!.assignmentId = 'asg-A1'; host.tasks['task:A']!.config = 'v1'; host.tasks['task:A']!.status = 'running'
host.tasks['task:B']!.assignmentId = 'asg-B1'; host.tasks['task:B']!.config = 'v1'; host.tasks['task:B']!.status = 'running'
startProducer('task:A', 'v1', 'asg-A1', 60_000)
startProducer('task:B', 'v1', 'asg-B1', 140_000, 6)
await extract('session-1')

while (elapsed() < 20 * SCALE) await sleep(500)
const s2 = 'session-2'
const meetingMin = 4
addTurn(s2, 'user', `A改用v2，旧的v1别再用了。接下来${meetingMin}分钟我在开会，非紧急的事等我开完会一起告诉我；A的结论今天下班前要定。`, ['task:A'], 'scripted-user')
const A = host.tasks['task:A']!
A.revision = 2; A.assignmentId = 'asg-A2'; A.config = 'v2'
log('host-revise', { taskId: 'task:A', revision: 2, assignment: 'asg-A2', note: '用户改口 → 任务版本+1，旧 assignment 失效' })
startProducer('task:A', 'v2', 'asg-A2', 150_000)
await extract('session-2')

let cancelled = false
while (elapsed() < BUDGET_S) {
  await observe()
  for (const w of plan.dueWaits(iso())) {
    log('wake-due', { taskId: w.taskId, recheckAt: w.recheckAt, waitFor: w.waitFor })
    await assessTask(w.taskId, 'wait due')
  }
  for (const n of plan.dueNotices(iso())) await present(n)
  const Ast = host.tasks['task:A']!
  if (!cancelled && Ast.status === 'analysis_delivered' && host.tasks['task:B']!.latestResultFile?.startsWith('result-')) {
    cancelled = true
    addTurn('session-3', 'user', '任务B不用再跟了，取消吧。', ['task:B'], 'scripted-user')
    const B = host.tasks['task:B']!
    B.cancelled = true; B.revision++; B.status = 'cancelled'
    plan.cancelTask('task:B', iso())
    log('host-cancel', { taskId: 'task:B', revision: B.revision })
    await extract('cancel')
    B.assignmentId = 'asg-B1-late'
    startProducer('task:B', 'v2', 'asg-B1-late', 5_000) // 取消后仍到来的迟到结果
  }
  if (cancelled && host.seenFiles['result-asg-B1-late.json'] && plan.dueNotices(iso()).length === 0) {
    const next = plan.nextWakeAt()
    if (!next || Date.parse(next) - Date.now() > (BUDGET_S - elapsed()) * 1000) break
  }
  await sleep(1000)
}

const nextWake = plan.nextWakeAt()
log('loop-end', { reason: elapsed() >= BUDGET_S ? 'budget' : 'all scripted events processed', nextWakeAt: nextWake, beyondBudget: nextWake ? Date.parse(nextWake) > T0 + BUDGET_S * 1000 : false })
await restart('final restart')
const end = {
  tasks: host.tasks,
  waits: plan.waits(),
  notices: plan.notices(),
  nextWakeAt: plan.nextWakeAt(),
  items: store.items(),
  packets: Object.fromEntries(['task:A', 'task:B'].map((id) => [id, readForDecision(store, { taskId: id, asOf: iso(), intent: 'current', question: '配置', requiredSlots: ['config'], budget: { maxItems: 30, maxChars: 6000 } })])),
  artifacts: readdirSync(WORK).filter((f) => !f.endsWith('.tmp')).map((f) => ({ file: join(WORK, f), sha256: sha(readFileSync(join(WORK, f))) })),
  counters, modelCalls: host.modelCalls, finishedAt: iso(), elapsedS: elapsed(),
}
writeFileSync(join(OUT, 'END-STATE.json'), JSON.stringify(end, null, 2))
store.close()
console.log(`done elapsed=${elapsed()}s modelCalls=${host.modelCalls} preGuard/modelFailures=${counters.modelFailures.length} guardCaught=${counters.guardCaught.length} out=${OUT}`)
process.exit(0)
