/**
 * 开发故事实跑（需要真实模型；未配置时如实失败 exit 1）：
 *   node capability/intervention/dev-story/run.ts --out <new-dir>
 * 一个持久 SQLite：按会话批次抽取 → A/B 分别 readForDecision → assess → submitAssessment → 介入落库
 * → 关闭并重开数据库 → 再读一次，核对重启后约束仍成立。全部模型原文写入 <out>/trace.json。
 * 结论只来自实际模型输出；本脚本不判定对错，只记录（由 Codex 独立评估）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CapabilityMemoryStore } from '../../memory/store.ts'
import { extractPending } from '../../memory/extract.ts'
import { readForDecision } from '../../memory/read.ts'
import { assess, submitAssessment } from '../assess.ts'
import { InterventionStore } from '../planner.ts'
import { OpenAICompatibleClient } from '../../model/openai-compatible.ts'

const i = process.argv.indexOf('--out')
if (i < 0) {
  console.error('usage: --out <new-dir>')
  process.exit(2)
}
const out = resolve(process.argv[i + 1]!)
if (existsSync(join(out, 'trace.json'))) {
  console.error('refusing to overwrite; use a new --out dir')
  process.exit(2)
}
mkdirSync(out, { recursive: true })
const story = JSON.parse(readFileSync(new URL('./story.json', import.meta.url), 'utf8'))
const client = new OpenAICompatibleClient()
const dbPath = join(out, 'cap.sqlite')
const trace: any = { startedAt: new Date().toISOString(), steps: [] }
let failed = false
let store = new CapabilityMemoryStore(dbPath)
const sessions = [...new Set(story.turns.map((t: any) => t.sessionId))]
for (const s of sessions) {
  for (const t of story.turns.filter((x: any) => x.sessionId === s)) store.appendTurn({ turnId: t.id, sessionId: t.sessionId, seq: t.seq, at: t.at, role: t.role, text: t.text, taskIds: t.taskIds })
  const last = story.turns.filter((x: any) => x.sessionId === s).at(-1)
  const ex = await extractPending(store, client, { entities: story.entities, now: last.at })
  trace.steps.push({ step: 'extract', session: s, status: ex.status, detail: ex.detail ?? null, requestId: ex.request?.requestId ?? null, accepted: ex.report?.accepted ?? [], rejected: ex.report?.rejected ?? [] })
  if (ex.status === 'failed' || ex.status === 'pending') failed = true
}
const plan = new InterventionStore(store.db)
const budget = { maxItems: 30, maxChars: 6000 }
if (!failed) {
  for (const q of story.queries) {
    const packet = readForDecision(store, { taskId: q.taskId, asOf: q.asOfAt, asOfSeq: q.asOfSeq, intent: q.intent, question: q.text, requiredSlots: q.requestedFactKeys, budget })
    const snapshot = { taskId: q.taskId, title: q.taskId, goal: '跟进实验结果', taskRevision: 1, assignmentId: 'asg-1', status: 'running', stage: 'observing', now: q.asOfAt, latestResult: null, options: [] }
    const record = await assess(snapshot, packet, undefined, client, { text: q.text, requestedFactKeys: q.requestedFactKeys })
    const submit = submitAssessment(record, packet, { taskRevision: 1, assignmentId: 'asg-1', now: q.asOfAt }, store, snapshot)
    const outcome = plan.apply(record, submit, q.asOfAt)
    trace.steps.push({ step: 'assess', taskId: q.taskId, packet, requestId: record.request.requestId, model: record.model, sessionId: record.sessionId, rawText: record.rawText, guardBefore: record.proposal, guardAfter: submit, outcome })
    if (record.failure) failed = true
  }
}
store.close()
store = new CapabilityMemoryStore(dbPath)
for (const q of story.queries) {
  const packet = readForDecision(store, { taskId: q.taskId, asOf: q.asOfAt, asOfSeq: q.asOfSeq, intent: q.intent, question: q.text, requiredSlots: q.requestedFactKeys, budget })
  trace.steps.push({ step: 'after-restart-read', taskId: q.taskId, commitments: packet.commitments, preferences: packet.preferences, nonActionable: packet.context.nonActionable, missing: packet.missing, conflicts: packet.conflicts })
}
const plan2 = new InterventionStore(store.db)
trace.afterRestart = { waits: plan2.waits(), notices: plan2.notices(), nextWakeAt: plan2.nextWakeAt() }
store.close()
trace.finishedAt = new Date().toISOString()
trace.failed = failed
writeFileSync(join(out, 'trace.json'), JSON.stringify(trace, null, 2))
console.log(`dev-story ${failed ? 'FAILED (see trace.json)' : 'done'} out=${out}`)
process.exit(failed ? 1 : 0)
