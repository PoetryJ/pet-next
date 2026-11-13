/**
 * capability adapter：pet-benefit-eval/v1 case 输入 → SCHEMA response（候选臂）。
 *
 * 用法（Node 24，直接运行 .ts）：
 *   node capability/model/schema-adapter.ts --cases <cases.jsonl> --out <dir> [--max-items 40] [--max-chars 6000]
 * 模型：OpenAI-compatible，由 PET_MODEL_BASE_URL / PET_MODEL_NAME（/ PET_MODEL_API_KEY，可省略仅限 loopback）配置。
 *
 * 只读取 case.input；caseId 仅作运行方连接键写在输出行外层，从不进入模型请求；不读取 split/gold。
 * 每个 case 用独立的内存 SQLite，固定两次模型调用：1 次抽取 + 1 次 assessment。
 * 输出：
 *   <out>/responses.jsonl  每行 {caseId, response:{answerFacts, action}}  ← guard 前原始模型提案（主评分）
 *   <out>/trace.jsonl      每行含两次请求的 requestId、原始输出、模型元信息、抽取校验、packet、guard 后结论
 *   <out>/requests/        实际发给模型的请求（可复核没有 caseId/gold）
 * 任何模型失败（未配置/超时/HTTP/解析）→ 该 case 记 failure，进程最终 exit 1；不写占位答案。
 */
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CapabilityMemoryStore } from '../memory/store.ts'
import { extractPending } from '../memory/extract.ts'
import { readForDecision } from '../memory/read.ts'
import { assess, submitAssessment } from '../intervention/assess.ts'
import type { AssessSnapshot } from '../intervention/assess.ts'
import { OpenAICompatibleClient } from './openai-compatible.ts'
import type { ModelCallResult, ModelClient, ModelRequest } from './protocol.ts'

export interface SchemaCaseInput {
  readonly turns: readonly { id: string; sessionId: string; seq: number; at: string; role: 'user' | 'assistant' | 'tool'; text: string; taskIds?: readonly string[] }[]
  readonly query: { text: string; taskId: string; asOfSeq: number; asOfAt: string; intent: 'current' | 'historical'; historicalAt?: string; requestedFactKeys: readonly string[] }
  readonly runtimeState: { now: string; entities: readonly { id: string; type: string; label: string }[]; taskStatuses: readonly { taskId: string; status: string }[] }
}

/** 记录每次真实调用的请求与结果（不改变内容）。 */
class RecordingClient implements ModelClient {
  readonly kind: string
  readonly calls: { request: ModelRequest; result: ModelCallResult }[] = []
  private readonly inner: ModelClient
  constructor(inner: ModelClient) {
    this.inner = inner
    this.kind = `recording(${inner.kind})`
  }
  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelCallResult> {
    const result = await this.inner.complete(request, signal)
    this.calls.push({ request, result })
    return result
  }
}

export async function runCase(input: SchemaCaseInput, client: ModelClient, budget = { maxItems: 40, maxChars: 6000 }) {
  const rec = new RecordingClient(client)
  const store = new CapabilityMemoryStore(':memory:')
  try {
    const q = input.query
    const cutoff = Date.parse(q.asOfAt)
    for (const t of input.turns) {
      if (t.seq > q.asOfSeq || Date.parse(t.at) > cutoff) continue // 未来原话不可见
      store.appendTurn({ turnId: t.id, sessionId: t.sessionId, seq: t.seq, at: t.at, role: t.role, text: t.text, taskIds: t.taskIds ?? [] })
    }
    const ex = await extractPending(store, rec, { entities: input.runtimeState.entities, now: input.runtimeState.now })
    if (ex.status === 'failed' || ex.status === 'pending') {
      return { ok: false as const, stage: 'extract', detail: ex.detail ?? ex.report?.parseError ?? 'failed', calls: rec.calls, extraction: ex.report ?? null }
    }
    const packet = readForDecision(store, {
      taskId: q.taskId, asOf: q.asOfAt, asOfSeq: q.asOfSeq, intent: q.intent, historicalAt: q.historicalAt,
      question: q.text, requiredSlots: q.requestedFactKeys, budget,
    })
    const label = input.runtimeState.entities.find((e) => e.id === q.taskId)?.label ?? q.taskId
    const status = input.runtimeState.taskStatuses.find((s) => s.taskId === q.taskId)?.status ?? 'unknown'
    const snapshot: AssessSnapshot = { taskId: q.taskId, title: label, goal: '', taskRevision: 1, assignmentId: null, status, stage: 'unknown', now: input.runtimeState.now, latestResult: null, options: [] }
    const record = await assess(snapshot, packet, undefined, rec, { text: q.text, requestedFactKeys: q.requestedFactKeys })
    const guard = submitAssessment(record, packet, { taskRevision: 1, assignmentId: null, now: input.runtimeState.now }, store, snapshot)
    if (!record.proposal) return { ok: false as const, stage: 'assess', detail: record.failure ? `${record.failure.code}: ${record.failure.detail}` : 'no proposal', calls: rec.calls, extraction: ex.report ?? null, packet }
    const p = record.proposal
    const response = {
      answerFacts: p.answerFacts.map((f) => ({ key: f.key, value: f.value as any, sourceTurnIds: f.sourceTurnIds })),
      action: {
        kind: p.kind, taskId: q.taskId, reasonCode: p.reasonCode,
        ...(p.question ? { question: p.question } : {}),
        ...(p.wakeAt ? { wakeAt: p.wakeAt } : p.kind === 'digest' && p.deliverAt ? { wakeAt: p.deliverAt } : {}),
        evidenceTurnIds: p.evidenceTurnIds,
      },
    }
    return { ok: true as const, response, guard, packet, extraction: ex.report ?? null, calls: rec.calls, record }
  } finally {
    store.close()
  }
}

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : dflt
}

async function main(): Promise<number> {
  const casesPath = arg('--cases')
  const out = arg('--out')
  if (!casesPath || !out) {
    console.error('usage: node capability/model/schema-adapter.ts --cases <cases.jsonl> --out <new-dir>')
    return 2
  }
  const outDir = resolve(out)
  if (existsSync(join(outDir, 'responses.jsonl'))) {
    console.error(`refusing to overwrite existing ${join(outDir, 'responses.jsonl')}; use a new --out dir`)
    return 2
  }
  mkdirSync(join(outDir, 'requests'), { recursive: true })
  const budget = { maxItems: Number(arg('--max-items', '40')), maxChars: Number(arg('--max-chars', '6000')) }
  const client = new OpenAICompatibleClient()
  const lines = readFileSync(casesPath, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0)
  let failures = 0
  for (const line of lines) {
    const c = JSON.parse(line)
    const caseId: string = c.caseId // 运行方连接键：不进入模型请求
    const r = await runCase(c.input as SchemaCaseInput, client, budget)
    for (const call of r.calls) {
      const text = JSON.stringify(call.request)
      if (caseId && text.includes(caseId)) throw new Error('leak: caseId found in model request')
      writeFileSync(join(outDir, 'requests', `${call.request.requestId}.json`), JSON.stringify(call.request, null, 2))
    }
    const trace = {
      caseId,
      ok: r.ok,
      stage: r.ok ? 'done' : r.stage,
      detail: r.ok ? null : r.detail,
      modelCalls: r.calls.map((x) => ({
        requestId: x.request.requestId, purpose: x.request.purpose, ok: x.result.ok,
        ...(x.result.ok
          ? { sessionId: x.result.response.sessionId, model: x.result.response.model, rawText: x.result.response.rawText, finishReason: x.result.response.finishReason, usage: x.result.response.usage, startedAt: x.result.response.startedAt, finishedAt: x.result.response.finishedAt }
          : { code: x.result.code, failure: x.result.detail }),
      })),
      extraction: r.extraction ? { accepted: r.extraction.accepted.length, rejected: r.extraction.rejected, items: r.extraction.accepted } : null,
      packet: 'packet' in r ? r.packet : null,
      guardAfter: r.ok ? { accepted: r.guard.accepted, code: r.guard.code, detail: r.guard.detail, fallback: r.guard.fallback, checks: r.guard.checks } : null,
      budget,
    }
    appendFileSync(join(outDir, 'trace.jsonl'), JSON.stringify(trace) + '\n')
    if (r.ok) {
      appendFileSync(join(outDir, 'responses.jsonl'), JSON.stringify({ caseId, response: r.response }) + '\n')
      console.log(`${caseId}: ok action=${r.response.action.kind}/${r.response.action.reasonCode} guard=${r.guard.code}`)
    } else {
      failures++
      appendFileSync(join(outDir, 'failures.jsonl'), JSON.stringify({ caseId, stage: r.stage, detail: r.detail }) + '\n')
      console.log(`${caseId}: FAILED at ${r.stage}: ${r.detail}`)
    }
  }
  console.log(`cases=${lines.length} ok=${lines.length - failures} failed=${failures} out=${outDir}`)
  return failures > 0 ? 1 : 0
}

if ((process.argv[1] ?? '').replace(/\\/g, '/').endsWith('capability/model/schema-adapter.ts')) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error)
    process.exit(1)
  })
}
