/**
 * 公共轨迹贯通用的“能力服务”子进程（最小宿主，单一 SQLite 写者）。
 *   node service.ts --state <dir> --workspace <producer workspace> --instance <name> [--prelude]
 * 只看到：mailbox/ 里已释放的原话、workspace/inbox 里真实落盘的 result.json、自身 DB 与 host.json、tasks.json（别名→实验号）。
 * 看不到：轨迹 timeline、生产者排程、userModel、expectations。
 * 停止：父进程 IPC {type:'stop'} → 中止在途模型调用 → 写 export → 关库 → 退出。
 * 这是能力模块的最小宿主模拟，不是 service/host 正式接线。
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { CapabilityMemoryStore } from '../../memory/store.ts'
import { extractPending } from '../../memory/extract.ts'
import { readForDecision } from '../../memory/read.ts'
import { ingestVerifiedOutcome, ingestToolReceipt } from '../../memory/verified.ts'
import { assess, submitAssessment, repairQuestion, REPAIRABLE } from '../assess.ts'
import type { AssessSnapshot } from '../assess.ts'
import { InterventionStore } from '../planner.ts'
import { OpenAICompatibleClient } from '../../model/openai-compatible.ts'

const argv = process.argv
const argOf = (k: string) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : undefined)
const STATE = resolve(argOf('--state')!)
const WS = resolve(argOf('--workspace')!)
const INSTANCE = argOf('--instance')!
const PRELUDE = argv.includes('--prelude')
const ASSESS_MAX = Number(process.env.PET_ASSESS_MAX_TOKENS ?? 768)
const EXTRACT_MAX = Number(process.env.PET_EXTRACT_MAX_TOKENS ?? 1536)
for (const d of ['mailbox', 'cards', 'receipts', 'events']) mkdirSync(join(STATE, d), { recursive: true })
process.env.PET_MODEL_RECORD_DIR ??= join(STATE, 'model-io')
const client = new OpenAICompatibleClient()
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex')
const iso = (ms = Date.now()) => new Date(ms).toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const EVENTS = join(STATE, 'events', 'service-events.jsonl')
function ev(kind: string, x: Record<string, unknown> = {}) {
  const line = { at: iso(), instance: INSTANCE, pid: process.pid, kind, ...x }
  appendFileSync(EVENTS, JSON.stringify(line) + '\n')
  console.log(JSON.stringify(line))
}

// ---------- 宿主状态 ----------
interface TaskDef { alias: string; title: string; experimentId: string; goalTurnId: string }
interface TaskState extends TaskDef { taskId: string; revision: number; assignmentId: string | null; result: any | null; resultFileSha: string | null; status: string; cancelled: boolean; analysis: string | null }
interface Host { tasks: Record<string, TaskState>; seenResultSha: string[]; processedMail: string[]; seq: number; instances: string[] }
const HOSTF = join(STATE, 'host.json')
const defs: TaskDef[] = JSON.parse(readFileSync(join(STATE, 'tasks.json'), 'utf8'))
const host: Host = existsSync(HOSTF) ? JSON.parse(readFileSync(HOSTF, 'utf8')) : {
  tasks: Object.fromEntries(defs.map((d) => [d.alias, { ...d, taskId: `task:${d.alias}`, revision: 1, assignmentId: null, result: null, resultFileSha: null, status: 'awaiting_result', cancelled: false, analysis: null }])),
  seenResultSha: [], processedMail: [], seq: 0, instances: [],
}
host.instances.push(`${INSTANCE}:${process.pid}`)
const save = () => { writeFileSync(HOSTF + '.tmp', JSON.stringify(host, null, 2)); renameSync(HOSTF + '.tmp', HOSTF) }
save()
const store = new CapabilityMemoryStore(join(STATE, 'capability.sqlite'))
const plan = new InterventionStore(store.db)
const entities = Object.values(host.tasks).map((t) => ({ id: t.taskId, type: 'task', label: `${t.title}（${t.experimentId}）` }))
const byAlias = (a: string) => host.tasks[a]
const byExp = (e: string) => Object.values(host.tasks).find((t) => t.experimentId === e)
const byTaskId = (id: string) => Object.values(host.tasks).find((t) => t.taskId === id)
ev('service.start', { prelude: PRELUDE, cursor: store.cursor(), items: store.items().length, turns: store.turns().length, waits: plan.waits(), notices: plan.notices().map((n) => ({ noticeId: n.noticeId, status: n.status, members: n.members.map((m) => `${m.taskId}:${m.status}`) })), tasks: Object.values(host.tasks).map((t) => ({ alias: t.alias, revision: t.revision, assignment: t.assignmentId, status: t.status, cancelled: t.cancelled, analysis: t.analysis })) })

// ---------- 停止 ----------
let stopping = false
let inflight: AbortController | null = null
let inflightTask: string | null = null
process.on('message', (m: any) => { if (m?.type === 'stop') { stopping = true; inflight?.abort(); ev('stop.requested', { inflight: inflightTask }) } })

function addTurn(turnId: string, role: 'user' | 'assistant' | 'tool', text: string, taskIds: string[], at: string, sessionId: string) {
  host.seq++
  const r = store.appendTurn({ turnId, sessionId, seq: host.seq, at, role, text, taskIds })
  save()
  return r
}

// ---------- 真实结果观察（scanOnce，按字节 sha 去重） ----------
const assessQueue: { alias: string; why: string }[] = []
const enqueue = (alias: string, why: string) => {
  if (!assessQueue.some((q) => q.alias === alias)) { assessQueue.push({ alias, why }); ev('assess.queued', { alias, why }) } else ev('assess.coalesced', { alias, why })
  // 不中途中止在途模型调用：模型服务端串行生成（generation_lock），客户端中止不会释放 GPU，只会浪费已花的时间
}
function scanInbox() {
  const inbox = join(WS, 'inbox')
  if (!existsSync(inbox)) return
  for (const exp of readdirSync(inbox)) {
    const f = join(inbox, exp, 'result.json')
    if (!existsSync(f)) continue
    const bytes = readFileSync(f)
    const h = sha(bytes)
    if (host.seenResultSha.includes(h)) continue
    let r: any
    try { r = JSON.parse(bytes.toString('utf8')) } catch { continue }
    host.seenResultSha.push(h)
    const t = byExp(r.experimentId)
    if (!t || r.schema !== 'pet-followup-result/v1') { ev('result.unmatched', { file: f, sha: h, experimentId: r.experimentId }); save(); continue }
    if (t.result && t.result.runId === r.runId && t.result.revision >= r.revision) { ev('result.not_newer', { alias: t.alias, runId: r.runId, revision: r.revision }); save(); continue }
    t.result = r; t.resultFileSha = h; t.revision++; t.assignmentId = `${r.runId}-r${r.revision}`
    if (!t.cancelled) t.status = 'result_observed'
    const failed = (r.samples ?? []).filter((s: any) => !s.pass).map((s: any) => `${s.id}(${s.note})`)
    const text = `[观察到结果文件 inbox/${exp}/result.json sha256=${h.slice(0, 16)}] 实验${r.experimentId} 运行${r.runId} 修订${r.revision} 状态${r.status}：总数${r.metrics.total}，通过${r.metrics.passed}，未通过${r.metrics.failed}。未通过样本：${failed.join('、') || '无'}。说明：${r.note}`
    const obsId = `obs-${h.slice(0, 12)}`
    addTurn(obsId, 'tool', text, [t.taskId], iso(), `observer-${INSTANCE}`)
    const vo = ingestVerifiedOutcome(store, store.turn(obsId)!, t.taskId, { runId: r.runId, revision: r.revision, status: r.status, metrics: r.metrics, resultFileSha: h, artifactPath: r.artifactPath, artifactSha: r.artifactSha }, iso())
    ev('outcome.verified', { alias: t.alias, itemId: vo.itemId, value: vo.value, supersedes: vo.supersedes })
    plan.evidenceArrived(t.taskId, iso(), `${r.runId}-r${r.revision}`)
    ev('result.observed', { alias: t.alias, runId: r.runId, revision: r.revision, status: r.status, metrics: r.metrics, resultFileSha: h, artifactPath: r.artifactPath, artifactSha: r.artifactSha, taskRevision: t.revision, taskCancelled: t.cancelled })
    if (inflightTask === t.taskId) ev('assess.inflight_will_be_stale', { alias: t.alias, why: 'new result for same task' })
    if (!t.cancelled) enqueue(t.alias, `result ${r.runId}-r${r.revision}`)
    else ev('result.ignored', { alias: t.alias, why: 'task cancelled by accepted earlier assessment' })
  }
  save()
}

// ---------- 选项 / 快照 ----------
function optionsFor(t: TaskState): NonNullable<AssessSnapshot['options']> {
  if (t.cancelled || !t.result || t.analysis) return []
  if ((t.result.metrics?.failed ?? 0) === 0) return []
  return [
    { optionId: 'analyze_failing', label: `生成 ${t.result.runId} 修订${t.result.revision} 的本地失败样本分析` },
    { optionId: 'keep_waiting', label: '继续等待更正/补录结果' },
    { optionId: 'rerun', label: '重新运行整个回归' },
  ]
}
function snapshotOf(t: TaskState): AssessSnapshot {
  const r = t.result
  return {
    taskId: t.taskId, title: `${t.title}（${t.experimentId}）`, goal: `委托见原话 ${t.goalTurnId}`, taskRevision: t.revision, assignmentId: t.assignmentId,
    status: t.cancelled ? 'cancelled' : t.status, stage: t.status, now: iso(),
    latestResult: r ? { sourceId: `inbox/${r.experimentId}/result.json@${t.resultFileSha!.slice(0, 16)}`, revision: r.revision, status: r.status, summary: `总数${r.metrics.total} 通过${r.metrics.passed} 未通过${r.metrics.failed}；${r.note}`, assignment: `${r.runId}-r${r.revision}`, artifact: r.artifactPath } : null,
    options: optionsFor(t),
  }
}

// ---------- 卡片渲染（真实呈现记录） ----------
function renderDue() {
  for (const n of plan.dueNotices(iso())) {
    const file = join(STATE, 'cards', `${n.noticeId}.json`)
    if (existsSync(file)) continue
    const members = n.members.filter((m) => m.status === 'pending').map((m) => {
      const t = byTaskId(m.taskId)!
      const a = plan.assessments().find((x: any) => { const o = JSON.parse(x.outcome ?? 'null'); return o?.type === 'notified' && o.decisionId === m.decisionId }) as any
      const optIds: string[] = a ? (JSON.parse(a.proposal ?? 'null')?.optionIds ?? []) : []
      const opts = optionsFor(t).filter((o) => optIds.includes(o.optionId))
      return { decisionId: m.decisionId, taskId: m.taskId, alias: t.alias, kind: m.kind, reasonCode: m.reasonCode, question: m.question, taskRevision: m.taskRevision, assignmentId: m.assignmentId,
        result: t.result ? { runId: t.result.runId, revision: t.result.revision, resultFileSha: t.resultFileSha, artifactPath: t.result.artifactPath, metrics: t.result.metrics } : null,
        options: opts, evidence: m.evidence }
    })
    const card = { cardId: n.noticeId, mode: n.mode, presentedAt: iso(), presentedBy: `${INSTANCE}:${process.pid}`, members }
    writeFileSync(file + '.tmp', JSON.stringify(card, null, 2)); renameSync(file + '.tmp', file)
    plan.markSeen(n.noticeId, iso()) // 记“已呈现”；用户是否回答见 mailbox
    ev('card.presented', { cardId: n.noticeId, mode: n.mode, members: members.map((m) => ({ alias: m.alias, kind: m.kind, question: m.question, options: m.options.map((o) => o.optionId), result: m.result && `${m.result.runId}-r${m.result.revision}` })) })
  }
}

// ---------- 唯一执行工具：本地失败样本分析 ----------
function runAnalysis(t: TaskState, card: any, member: any) {
  const r = t.result
  const safe = (p: string) => { const a = resolve(WS, p); const rel = relative(WS, a); if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('outside workspace'); return a }
  const inputBytes = readFileSync(safe(r.artifactPath))
  const inputSha = sha(inputBytes)
  if (inputSha !== r.artifactSha) { ev('tool.refused', { reason: 'artifact sha mismatch', inputSha, expected: r.artifactSha }); return null }
  const art = JSON.parse(inputBytes.toString('utf8'))
  if (art.runId !== r.runId || art.revision !== r.revision) { ev('tool.refused', { reason: 'artifact run/revision mismatch' }); return null }
  const failed = art.samples.filter((s: any) => !s.pass)
  const clusters = new Map<string, string[]>()
  for (const s of failed) { const k = String(s.note).split(':')[0]!.trim(); clusters.set(k, [...(clusters.get(k) ?? []), s.id]) }
  const total = art.samples.length, passed = total - failed.length
  const md = [
    `# 本地失败样本分析：${r.experimentId} ${r.runId} 修订 ${r.revision}`, '',
    `- 输入结果：inbox/${r.experimentId}/result.json sha256=${t.resultFileSha}`,
    `- 输入样本：${r.artifactPath} sha256=${inputSha}`,
    `- 统计（同一修订、由样本文件逐条计数）：总数 ${total}，通过 ${passed}，失败 ${failed.length}`,
    `- 授权：用户在卡片 ${card.cardId} / 决定 ${member.decisionId} 选择 analyze_failing；未重跑、未改代码、未发送`, '',
    '## 失败聚类', ...[...clusters].map(([k, ids]) => `- ${k}：${ids.length} 个（${ids.join('、')}）`), '',
    '## 失败样本明细', ...failed.map((s: any) => `- ${s.id}：${s.note}`), '',
    '## 建议', ...[...clusters].map(([k, ids]) => `- ${k}：优先检查 ${ids[0]} 等 ${ids.length} 例；是否重跑由用户决定`), '',
  ].join('\n')
  mkdirSync(join(WS, 'analysis'), { recursive: true })
  const outRel = `analysis/analysis-${r.runId}-r${r.revision}.md`
  const out = join(WS, outRel)
  if (existsSync(out)) { ev('tool.refused', { reason: 'output exists' }); return null }
  writeFileSync(out + '.tmp', md); renameSync(out + '.tmp', out)
  const receipt = { receiptId: `rcpt-${sha(outRel + inputSha).slice(0, 12)}`, tool: 'local-failure-analysis', at: iso(), by: `${INSTANCE}:${process.pid}`, taskId: t.taskId, decisionId: member.decisionId, cardId: card.cardId,
    input: { resultFileSha: t.resultFileSha, artifactPath: r.artifactPath, artifactSha: inputSha, runId: r.runId, revision: r.revision }, output: { path: outRel, sha256: sha(md), bytes: Buffer.byteLength(md) }, counts: { total, passed, failed: failed.length, clusters: Object.fromEntries([...clusters].map(([k, v]) => [k, v.length])) } }
  writeFileSync(join(STATE, 'receipts', `${receipt.receiptId}.json`), JSON.stringify(receipt, null, 2))
  t.analysis = receipt.receiptId; t.status = 'analysis_done'; save()
  const rid = `tool-${receipt.receiptId}`
  addTurn(rid, 'tool', `[工具回执 ${receipt.receiptId}] 本地失败分析已写入 ${outRel} sha256=${receipt.output.sha256.slice(0, 16)}，输入 ${r.runId} 修订${r.revision}`, [t.taskId], iso(), `tool-${INSTANCE}`)
  ingestToolReceipt(store, store.turn(rid)!, t.taskId, 'analysisArtifact', outRel, `分析产物 ${outRel} sha256 ${receipt.output.sha256.slice(0, 16)}（输入 ${r.runId} r${r.revision}）`, iso())
  ev('tool.executed', receipt)
  return receipt
}

function verifyReceipts() {
  for (const f of readdirSync(join(STATE, 'receipts'))) {
    const rc = JSON.parse(readFileSync(join(STATE, 'receipts', f), 'utf8'))
    const p = join(WS, rc.output.path)
    const ok = existsSync(p) && sha(readFileSync(p)) === rc.output.sha256
    ev('receipt.verified', { receiptId: rc.receiptId, path: rc.output.path, ok })
  }
}

// ---------- 用户信箱 ----------
const pendingStatusQuery: string[] = []
function readMail() {
  const files = readdirSync(join(STATE, 'mailbox')).filter((f) => f.endsWith('.json')).sort()
  for (const f of files) {
    if (host.processedMail.includes(f)) continue
    const m = JSON.parse(readFileSync(join(STATE, 'mailbox', f), 'utf8'))
    host.processedMail.push(f)
    const taskIds = (m.taskAliases ?? []).map((a: string) => byAlias(a)?.taskId).filter(Boolean)
    addTurn(m.turnId, m.role, m.text, taskIds, m.sourceAt ?? m.releasedAt, m.sessionId)
    ev('turn.ingested', { turnId: m.turnId, role: m.role, taskIds, sourceAt: m.sourceAt ?? null, releasedAt: m.releasedAt, reply: m.reply ?? null })
    if (PRELUDE) continue
    if (m.reply) handleReply(m)
    for (const a of m.taskAliases ?? []) {
      const t = byAlias(a)
      if (!t || t.cancelled) continue
      if (inflightTask === t.taskId) ev('assess.inflight_will_be_stale', { alias: a, why: `new user turn ${m.turnId}` })
      if (m.role === 'user' && !m.reply && t.result) enqueue(a, `user turn ${m.turnId}`)
    }
    if (/产物位置|文件在哪|在哪里/.test(m.text)) pendingStatusQuery.push(m.turnId)
  }
  save()
}
function handleReply(m: any) {
  const { cardId, decisionId, optionId } = m.reply
  const cf = join(STATE, 'cards', `${cardId}.json`)
  const card = existsSync(cf) ? JSON.parse(readFileSync(cf, 'utf8')) : null
  const member = card?.members.find((x: any) => x.decisionId === decisionId)
  const t = member ? byTaskId(member.taskId) : undefined
  const reject = (why: string) => ev('reply.rejected', { cardId, decisionId, optionId, why })
  if (!card || !member || !t) return reject('unknown card/decision')
  if (t.cancelled) return reject('task cancelled')
  if (member.taskRevision !== t.revision || member.assignmentId !== t.assignmentId) return reject(`stale card: r${member.taskRevision}/${member.assignmentId} vs current r${t.revision}/${t.assignmentId}`)
  if (!member.options.some((o: any) => o.optionId === optionId)) return reject('option not on card')
  if (!plan.answer(cardId, decisionId, optionId)) return reject('planner refused (not pending)')
  ev('reply.accepted', { cardId, decisionId, optionId, alias: t.alias, assignment: t.assignmentId })
  if (optionId === 'analyze_failing') runAnalysis(t, card, member)
  else ev('reply.no_tool', { optionId, note: '只有 analyze_failing 有执行工具（授权范围）' })
}
function answerStatusQueries() {
  while (pendingStatusQuery.length) {
    const turnId = pendingStatusQuery.shift()!
    const lines: string[] = []
    for (const t of Object.values(host.tasks)) {
      if (t.cancelled) { lines.push(`${t.title}：已取消，不再跟进`); continue }
      const rc = t.analysis ? JSON.parse(readFileSync(join(STATE, 'receipts', `${t.analysis}.json`), 'utf8')) : null
      if (rc) { const p = join(WS, rc.output.path); const ok = existsSync(p) && sha(readFileSync(p)) === rc.output.sha256; lines.push(`${t.title}：产物 ${p}（sha256 ${rc.output.sha256.slice(0, 16)}，本次重新核验${ok ? '一致' : '不一致'}；回执 ${rc.receiptId}）`) }
      else lines.push(`${t.title}：尚无分析产物（状态 ${t.status}）`)
    }
    const text = lines.join('\n')
    addTurn(`reply-${turnId}`, 'assistant', text, Object.values(host.tasks).map((t) => t.taskId), iso(), `pet-${INSTANCE}`)
    writeFileSync(join(STATE, 'cards', `reply-${turnId}.json`), JSON.stringify({ cardId: `reply-${turnId}`, mode: 'chat_reply', presentedAt: iso(), presentedBy: `${INSTANCE}:${process.pid}`, inReplyTo: turnId, text, source: 'host receipts (not model)' }, null, 2))
    ev('chat.reply', { inReplyTo: turnId, text })
  }
}

// ---------- 评估 ----------
const counters = { preGuard: [] as any[], guardCaught: [] as any[] }
async function runAssess(alias: string, why: string) {
  const t = byAlias(alias)!
  if (t.cancelled) return
  // 共享属性 taskStatus：用户来源的有效“取消”条目直接约束当前任务（可追溯到条目与原话）
  const statusPacket = readForDecision(store, { taskId: t.taskId, asOf: iso(), intent: 'current', question: '任务状态 取消', requiredSlots: ['taskStatus'], budget: { maxItems: 8, maxChars: 1500 } })
  const cancelItem = [...statusPacket.commitments, ...statusPacket.currentFacts].find((i) => i.key === 'taskStatus' && i.status === 'active' && i.authority === 'user' && i.scope.id === t.taskId && /cancel|取消|stop|终止/i.test(String(i.value)))
  if (cancelItem) { t.cancelled = true; t.status = 'cancelled'; plan.cancelTask(t.taskId, iso()); save(); ev('task.cancelled', { alias, by: `memory item ${cancelItem.itemId} taskStatus=${JSON.stringify(cancelItem.value)}`, evidence: cancelItem.evidenceTurnIds }); return }
  const snapshot = snapshotOf(t)
  const packet = readForDecision(store, { taskId: t.taskId, asOf: snapshot.now, intent: 'current', question: `${t.title} 当前结果、样本数口径、授权范围、通知偏好与等待条件`, requiredSlots: ['runTarget', 'allowedActions', 'notificationPolicy', 'waitPolicy', 'decisionDeadline'], budget: { maxItems: 24, maxChars: 4500 } })
  inflight = new AbortController(); inflightTask = t.taskId
  ev('assess.start', { alias, why, taskRevision: t.revision, assignment: t.assignmentId, memoryCursor: packet.memoryCursor, options: (snapshot.options ?? []).map((o) => o.optionId), slotResolution: packet.context.slotResolution.map((s) => `${s.slot}:${s.status}`), items: [...packet.currentFacts, ...packet.commitments, ...packet.preferences].map((i) => `${i.itemId}:${i.key}=${JSON.stringify(i.value)}`), nonActionable: packet.context.nonActionable.map((i) => `${i.key}=${JSON.stringify(i.value)}/${i.status}`), recentTurns: packet.context.recentTurns.map((r) => r.turnId) })
  const baseQ = { text: '此刻该做什么：等待、马上问我、合并到摘要、直接执行某个选项，还是什么都不做？', requestedFactKeys: [] as string[] }
  let record = await assess(snapshot, packet, inflight.signal, client, baseQ, ASSESS_MAX)
  inflight = null; inflightTask = null
  if (record.failure?.code === 'aborted') { ev('assess.aborted', { alias, requestId: record.request.requestId }); if (!stopping) enqueue(alias, 'requeue after abort'); return }
  const cur = byAlias(alias)!
  let submit = submitAssessment(record, packet, { taskRevision: cur.revision, assignmentId: cur.assignmentId, now: iso() }, store, snapshot)
  if (record.failure) counters.preGuard.push({ alias, failure: record.failure })
  else if (!submit.accepted) counters.guardCaught.push({ alias, code: submit.code, detail: submit.detail })
  // 至多一次定向修复重评（同一快照/记忆包；第一次原始输出照常落库计数）
  if (!submit.accepted && REPAIRABLE.includes(submit.code) && !stopping && record.failure?.code !== 'timeout') {
    plan.logAssessment(record, submit, { type: 'rejected', code: submit.code }, iso())
    ev('assess.first_rejected', { alias, requestId: record.request.requestId, code: submit.code, detail: submit.detail, raw: record.rawText?.slice(0, 600) ?? null })
    const snap2 = snapshotOf(byAlias(alias)!)
    inflight = new AbortController(); inflightTask = t.taskId
    record = await assess(snap2, packet, inflight.signal, client, repairQuestion(submit, baseQ), ASSESS_MAX)
    inflight = null; inflightTask = null
    if (record.failure?.code === 'aborted') { ev('assess.aborted', { alias, requestId: record.request.requestId }); if (!stopping) enqueue(alias, 'requeue after abort'); return }
    const cur2 = byAlias(alias)!
    submit = submitAssessment(record, packet, { taskRevision: cur2.revision, assignmentId: cur2.assignmentId, now: iso() }, store, snap2)
    if (record.failure) counters.preGuard.push({ alias, repair: true, failure: record.failure })
    else if (!submit.accepted) counters.guardCaught.push({ alias, repair: true, code: submit.code, detail: submit.detail })
    ev('assess.repair', { alias, requestId: record.request.requestId, accepted: submit.accepted, code: submit.code })
  }
  const outcome = plan.apply(record, submit, iso())
  const p = record.proposal
  if (!submit.accepted && REPAIRABLE.includes(submit.code)) ev('task.blocked', { alias, code: submit.code, resumeOn: 'new result / user turn / restart', note: '修复一次仍被拒：不自动当授权，等待下一次证据变化' })
  ev('assess.done', { alias, requestId: record.request.requestId, preGuard: p ? { kind: p.kind, reasonCode: p.reasonCode, question: p.question, optionIds: p.optionIds, wakeAt: p.wakeAt, deadlineAt: p.deadlineAt, deliverAt: p.deliverAt, batchable: p.batchable, evidence: [...p.evidenceTurnIds, ...p.evidenceItemIds] } : { failure: record.failure }, guard: { accepted: submit.accepted, code: submit.code, detail: submit.detail, checks: submit.checks }, outcome })
  const userGrounded = (refs: readonly string[]) => refs.some((r) => store.turn(r)?.role === 'user' || store.items().some((i) => i.itemId === r && i.authority === 'user'))
  if (submit.accepted && p?.reasonCode === 'cancelled' && !userGrounded([...submit.proposal!.evidenceTurnIds, ...submit.proposal!.evidenceItemIds])) ev('cancel.not_grounded', { alias, evidence: [...submit.proposal!.evidenceTurnIds, ...submit.proposal!.evidenceItemIds], note: '取消必须引用用户原话或用户来源条目' })
  else if (submit.accepted && p?.reasonCode === 'cancelled' && (p.kind === 'none' || p.kind === 'wait')) { cur.cancelled = true; cur.status = 'cancelled'; plan.cancelTask(cur.taskId, iso()); save(); ev('task.cancelled', { alias, by: 'accepted assessment reasonCode=cancelled', evidence: [...p.evidenceTurnIds, ...p.evidenceItemIds] }) }
  if (!submit.accepted && submit.code.startsWith('stale_') && !stopping) enqueue(alias, `retry after ${submit.code}`)
  if (outcome.type === 'execute') ev('act.not_executed', { optionId: outcome.optionId, note: '工具执行需用户在卡片上选择；模型 act 不直接执行' })
}

async function extractOnce(): Promise<'nothing' | 'applied' | 'failed' | 'pending'> {
  inflight = new AbortController(); inflightTask = '(extract)'
  const r = await extractPending(store, client, { entities, now: iso(), signal: inflight.signal, maxTurns: PRELUDE ? 2 : 3, roles: ['user', 'assistant'], maxTokens: EXTRACT_MAX })
  inflight = null; inflightTask = null
  if (r.status === 'nothing') return 'nothing'
  if (r.detail?.startsWith('aborted')) { ev('extract.aborted', { requestId: r.request?.requestId }); return 'pending' }
  ev('extract', { status: r.status, requestId: r.request?.requestId, detail: r.detail ?? r.report?.parseError ?? null, accepted: (r.report?.accepted ?? []).map((i) => ({ itemId: i.itemId, kind: i.kind, key: i.key, value: i.value, scope: i.scope.id ?? i.scope.level, status: i.status, validUntil: i.validUntil, supersedes: i.supersedes, checks: i.checks })), rejected: r.report?.rejected ?? [] })
  for (const rej of r.report?.rejected ?? []) counters.guardCaught.push({ stage: 'extract', reason: rej.reason })
  if (r.status === 'failed') counters.preGuard.push({ stage: 'extract', detail: r.detail ?? r.report?.parseError })
  return r.status
}

// ---------- 主循环（串行：信箱 → 结果 → 到期等待 → 状态问答 → 评估 → 呈现 → 空闲时抽取） ----------
if (!PRELUDE) verifyReceipts()
// 在模型调用 await 期间继续观察信箱/结果并呈现到期卡片（同一进程、同一写者；回调只在 await 间隙执行）
const ticker = PRELUDE ? null : setInterval(() => { if (stopping) return; try { readMail(); scanInbox(); answerStatusQueries(); renderDue() } catch (e) { ev('tick.error', { error: String(e) }) } }, 400)
let extractFails = 0
while (!stopping) {
  readMail()
  if (PRELUDE) {
    const s = await extractOnce()
    if (s === 'failed') extractFails++
    if (s === 'nothing' || stopping || extractFails >= 3) { ev('prelude.done', { items: store.items().length, extractFails }); break }
    continue
  }
  scanInbox()
  for (const w of plan.dueWaits(iso())) { const t = byTaskId(w.taskId); if (t) enqueue(t.alias, `wait due ${w.waitId}`) }
  answerStatusQueries()
  renderDue()
  const job = assessQueue.shift()
  if (job) { await runAssess(job.alias, job.why); renderDue(); continue }
  if (extractFails < 3) {
    const s = await extractOnce()
    if (s === 'failed') extractFails++
    if (s === 'applied' || s === 'failed' || s === 'pending') continue
  }
  await sleep(300)
}
if (ticker) clearInterval(ticker)
const exp = { instance: INSTANCE, pid: process.pid, at: iso(), host, waits: plan.waits(), notices: plan.notices(), nextWakeAt: plan.nextWakeAt(), items: store.items(), counters }
writeFileSync(join(STATE, 'events', `export-${INSTANCE}.json`), JSON.stringify(exp, null, 2))
ev('service.stopped', { items: store.items().length, cursor: store.cursor() })
store.close()
process.exit(0)
