/**
 * 条件编译器：把用户“何时需要我选择/何时算完成”的承诺编译为有限 JSON 条件 IR。
 *
 * 约束（见 CONTRACT）：
 * - 一次模型调用，输出 when + 逐字来源 span + unsupported；不硬猜不支持的子句。
 * - 结构正确与语义正确分开：这里只保证结构、字段注册、来源逐字可核对；
 *   语义是否正确由独立评分（D 的 evaluator-only 判据）判定，编译通过不等于语义正确。
 * - 无来源、越任务、未知字段、歧义/不支持一律返回明确状态，不产生可行动 plan。
 *
 * @module capability/conditions/compiler
 */
import { createHash } from 'node:crypto'
import { compilationKey, validateExpr } from './kernel.ts'
import type { Expr } from './kernel.ts'
import { makeRequest, parseModelJson } from '../model/protocol.ts'
import type { ModelClient } from '../model/protocol.ts'
import {
  COMPILE_INPUT_CHARS, CONDITION_SCHEMA, MAX_SOURCE_QUOTES,
} from './plan-types.ts'
import type { CompileCall, CompileInput, CompileResult, ConditionCompiler, ConditionPlan, ConditionQuote, FactDeclaration, FollowPlan } from './plan-types.ts'

/** 编译输入里的原话形状（plan-types 已冻结）。 */
type ConditioningTurn = CompileInput['userTurns'][number]

export const COMPILER_SCHEMA_VERSION = 'pet-conditions-compiler/v1'

export const COMPILER_SYSTEM = `你是“承诺编译器”，只做一件事：把用户对某个任务的承诺，编译成有限的 JSON 条件表达式。
只输出一个 JSON 对象，不要解释、不要 Markdown。

输出形状：
{"when": <条件>, "quotes": [{"turnId": "...", "start": 0, "end": 12}], "followMode": "end"|"next_round", "followQuotes": [{"turnId": "...", "start": 0, "end": 12}], "unsupported": ["..."]}

条件语法（只能用这些）：
- {"op":"cmp","fact":"字段ID","rel":"eq|ne|lt|le|gt|ge","value":<字符串/布尔/数字>}
- {"op":"all","args":[<条件>,...]}，{"op":"any","args":[...]}，{"op":"not","arg":<条件>}
- 最多 64 个节点、深度 8；每组 all/any 只能有 1–8 个子节点。
- 数值比较只能用数字字面量；日期由宿主换算成毫秒（clock.nowMs），不要自己算时差。

硬性规则：
1. fact 必须是给定的 allowedFacts 里的字段 ID，不能新增字段，也不能引用未声明任务的字段。
2. quotes 必须逐字指向给定用户原话（start/end 是 UTF-16 半开区间），只引用 role=user 的轮次；
   没有原话支撑的条件必须放进 unsupported，不要凭推测写 IR。
3. 缺失字段不等于 false：不要用 not 包装“还没到的结果”来表达“未完成”。
4. 用户的更正/例外必须体现为条件本身（例如“除非我出差”），不要只写在 unsupported。
5. 若用户的承诺无法用上述语法表达（例如需要跨文件内容判断、需要工具执行结果），
   把该子句原文放进 unsupported，when 只保留可确定的部分。

补充准则（R6-live 开发候选，来自真实失败；只影响结构，不改变语义标准）：
6. 按用户原话的时间顺序维护“当前需要等待的条件”。后来的更正替换相冲突的旧条件。
7. “不用等B / B仅供归档 / B不影响是否来问我”＝删除 B 依赖：when 里不得再读取 B；
   绝不翻译成 B.present=false 或 not B.present。
8. “恢复也等B / A与B都到齐”＝用 all 组合 A 与 B。“报告到达”只比较 result.present=true；
   报告显示成功/失败是另一个事实。
9. when 只保留当前仍有效的依赖；单条件直接用 cmp，多条件才用 all/any。
10. quotes 必须覆盖支持当前条件的完整原话：start=0，end=该用户消息的 UTF-16 长度（宿主给出）。
11. 输出必须是一个完整 JSON 对象，顶层键恰为 when、follow、quotes、unsupported；不要省略引号或注释。
12. “都成功就归档 / 不用问 / 不要打扰”不是 unsupported：它说明 when 只描述“必须来问我”的触发条件
    （例如任一报告失败）。当来源齐备且 when 为 false 时，宿主会静默归档；不要把归档写成 when 的一部分，
    也不要用 not 包装“还没到的报告”。
13. unsupported 只列“直接限制何时需要问我/何时归档、且确实无法用上述语法表达”的子句；
    与任务无关的聊天、日志安排、偏好、重复条目一律不要放进 unsupported。
14. “报告回来/到齐”用 result.present；“报告成功/失败”用 result.status（succeeded/failed）。
    不要把“任何一份失败就问我”编译成“任一份报告到达就问我”。
15. “只有 A 失败才需要来问我”= when: A.result.status == "failed"（正面条件）；
    不要写成 not(A.failed)，也不要用 A.present 代替 A.failed。
16. “只有两份都成功时才来问我”= when: all(A.status=="succeeded", B.status=="succeeded")；
    不是 any(status=="failed")——后者是“失败就归档”的触发条件，方向相反。
17. followMode 说明 when 不成立时是结束还是继续：用户说“本轮/这次成功就归档/结束/不用再跟”=end；
    “成功先安静，继续跟下一轮/下一次重跑/持续观察”=next_round。followQuotes 必须逐字指向支持该选择的用户原话。
18. 用户没有明确说结束时，默认 followMode=next_round（持续观察），不要因为“这一轮成功”就替用户结束委托；
    只有原话明确说归档/结束/不用再跟时才用 end。`

export function quoteSha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** compilerSha256：prompt + 模型身份 + schema/字段表版本，任一变化都必须失效编译缓存。 */
export function compilerSha256(model: { name: string; provider?: string; version?: string } = { name: 'unconfigured' }): string {
  return createHash('sha256').update(JSON.stringify({
    schema: CONDITION_SCHEMA,
    compiler: COMPILER_SCHEMA_VERSION,
    prompt: COMPILER_SYSTEM,
    model: { name: model.name, provider: model.provider ?? null, version: model.version ?? null },
    limits: { nodes: 64, depth: 8, group: 8, quotes: MAX_SOURCE_QUOTES, chars: COMPILE_INPUT_CHARS },
  })).digest('hex')
}

export interface CompileRequestView {
  readonly system: string
  readonly user: string
}

/** 4500 字符预算从最早的轮次开始裁掉，保留最近的更正（最近的更正优先于旧承诺）。 */
export function budgetTurns(turns: readonly ConditioningTurn[], maxChars = COMPILE_INPUT_CHARS): ConditioningTurn[] {
  const kept: ConditioningTurn[] = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!
    const cost = t.text.length + 40
    if (used + cost > maxChars && kept.length > 0) break
    used += cost
    kept.unshift(t)
  }
  return kept
}

export function buildCompileView(input: CompileInput): CompileRequestView {
  const facts = input.allowedFacts.map((f: FactDeclaration) => ({ id: f.id, type: f.type }))
  return {
    system: COMPILER_SYSTEM,
    user: JSON.stringify({
      taskId: input.taskId,
      commitmentRevision: input.commitmentRevision,
      allowedFacts: facts,
      turns: budgetTurns(input.userTurns).map((t) => ({ turnId: t.turnId, role: t.role, at: t.at, text: t.text })),
      ...(input.memorySummary ? { memorySummary: input.memorySummary } : {}),
      ...(input.viewSha ? { viewSha: input.viewSha } : {}),
      // 宿主计算的原话长度：引用整条时 start=0、end=这里的 length，不要自己数。
      turnLengths: budgetTurns(input.userTurns).map((t) => ({ turnId: t.turnId, length: t.text.length })),
      instruction: '把这个任务“何时需要用户选择/确认”的承诺编译为 when；只引用 turns 里的用户原话（memorySummary 只用于定位，不能当引用）；无法表达的放进 unsupported。quotes 最多 3 条，用整条原话：start=0，end=turnLengths 给出的 length。',
    }),
  }
}

interface RawCandidate {
  when?: unknown
  follow?: unknown
  followMode?: unknown
  followQuotes?: unknown
  quotes?: unknown
  unsupported?: unknown
}

/** 首段提问从句的方向；只用于结构负控，不替代语义判断。 */
export function askIntentOf(text: string): 'failure' | 'success' | 'arrival' | 'mixed' | 'unknown' {
  const askPart = text.split(/[；;]/)[0] ?? text
  const asks = /问我|确认|继续|提醒|通知/.test(askPart)
  if (!asks) return 'unknown'
  const arrival = /到齐|都回来|都到|报告都|收齐/.test(askPart)
  const success = /(?:都|全部|两份都|两个都).{0,6}成功|成功.{0,6}(?:才|再).{0,6}(?:问|确认)/u.test(askPart)
  const failure = /失败.{0,10}(?:问|确认|提醒)|(?:任何|任意|只要).{0,8}失败/u.test(askPart)
  if (success && failure) return 'mixed'
  if (arrival && !success && !failure) return 'arrival'
  if (success) return 'success'
  if (failure) return 'failure'
  return 'unknown'
}

/** 结构方向负控：拒绝 not 包装正向条件、把 present 混进失败/成功提问、或缺少对应状态字面量。 */
export function validateDirection(expr: unknown, askPart: string): string[] {
  const intent = askIntentOf(askPart)
  const facts: { fact: string; value?: unknown }[] = []
  const root = expr as { op?: string } | null
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.op === 'cmp') facts.push({ fact: String(node.fact), value: node.value })
    for (const key of ['args', 'arg']) {
      const value = node[key]
      if (Array.isArray(value)) value.forEach(walk)
      else if (value) walk(value)
    }
  }
  walk(expr)
  const hasPresent = facts.some((item) => item.fact.endsWith('.result.present'))
  const hasFailed = facts.some((item) => item.value === 'failed' || (item.fact.endsWith('.failed') && typeof item.value === 'number' && item.value > 0))
  const hasSucceeded = facts.some((item) => item.value === 'succeeded')
  const problems: string[] = []
  if (intent === 'failure' || intent === 'success') {
    if (root?.op === 'not') problems.push('inverted_not')
    if (intent === 'failure') {
      if (hasPresent) problems.push('present_in_failure_ask')
      if (!hasFailed) problems.push('missing_failure_condition')
    } else {
      const arrivalAllowed = /到齐|都回来|都到|报告都|收齐/.test(askPart)
      if (hasPresent && !arrivalAllowed) problems.push('present_in_success_ask')
      if (hasFailed) problems.push('failed_in_success_ask')
      if (!hasSucceeded) problems.push('missing_success_condition')
    }
  }
  if (intent === 'arrival') {
    if (!hasPresent) problems.push('missing_present_condition')
    if (hasFailed || hasSucceeded) problems.push('status_in_arrival_ask')
  }
  return problems
}

/** when 不成立时的默认分支：原话明确结束才 end，否则持续观察。 */
export function inferFollowMode(text: string): 'end' | 'next_round' {
  if (/归档|结束|不用再跟|就这轮|到此为止|本轮.{0,6}(?:结束|完)/u.test(text)) return 'end'
  if (/继续跟|下一次重跑|下一轮|持续观察|一直跟|接着跟/u.test(text)) return 'next_round'
  return 'next_round'
}

/** 逐字来源校验：span 必须落在该 turn 文本内且内容完全一致，且只能来自 user 角色。 */
export function validateQuotes(candidate: RawCandidate, turns: readonly ConditioningTurn[]): { ok: true; quotes: ConditionQuote[] } | { ok: false; reason: string } {
  if (!Array.isArray(candidate.quotes)) return { ok: false, reason: 'quotes_not_array' }
  if (candidate.quotes.length === 0) return { ok: false, reason: 'no_source_quote' }
  if (candidate.quotes.length > MAX_SOURCE_QUOTES) return { ok: false, reason: 'too_many_quotes' }
  const byId = new Map(turns.map((t) => [t.turnId, t]))
  const quotes: ConditionQuote[] = []
  for (const raw of candidate.quotes) {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'quote_not_object' }
    const q = raw as { turnId?: unknown; start?: unknown; end?: unknown; text?: unknown }
    if (typeof q.turnId !== 'string') return { ok: false, reason: 'quote_turn_missing' }
    const turn = byId.get(q.turnId)
    if (!turn) return { ok: false, reason: `quote_unknown_turn:${q.turnId}` }
    if (turn.role !== 'user') return { ok: false, reason: `quote_role_not_user:${q.turnId}` }
    if (!Number.isInteger(q.start) || !Number.isInteger(q.end)) return { ok: false, reason: 'quote_span_not_integer' }
    const start = q.start as number
    const end = q.end as number
    if (start < 0 || end > turn.text.length || start >= end) return { ok: false, reason: `quote_span_out_of_range:${q.turnId}` }
    const text = turn.text.slice(start, end)
    if (!text.trim()) return { ok: false, reason: `quote_span_blank:${q.turnId}` }
    // 模型自报的引用文本必须与原话切片完全一致：这是“伪造来源”的唯一可自动识别形态。
    if (q.text !== undefined && q.text !== text) return { ok: false, reason: `quote_text_mismatch:${q.turnId}` }
    quotes.push({ turnId: q.turnId, role: 'user', start, end, text, sha256: quoteSha(text) })
  }
  return { ok: true, quotes }
}

function factIds(facts: readonly FactDeclaration[]): string[] {
  return facts.map((f) => f.id)
}

/** 字面量/枚举校验：字段类型不匹配、字符串枚举越界都在编译期拒绝（不让它变成永久 false）。 */
export function checkLiterals(expr: unknown, facts: readonly FactDeclaration[]): string[] {
  const byId = new Map(facts.map((f) => [f.id, f]))
  const problems: string[] = []
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.op === 'cmp') {
      const fact = byId.get(String(node.fact))
      const value = node.value
      if (fact) {
        const rel = String(node.rel)
        const kind = typeof value
        const expected = fact.type === 'number' ? 'number' : fact.type === 'boolean' ? 'boolean' : 'string'
        if (kind !== expected) problems.push(`type_mismatch:${fact.id}(${fact.type})!=${kind}`)
        if ((rel === 'lt' || rel === 'le' || rel === 'gt' || rel === 'ge') && fact.type !== 'number') problems.push(`ordered_rel_on_${fact.type}:${fact.id}`)
        if (fact.enum && kind === 'string' && !fact.enum.includes(value) && (rel === 'eq' || rel === 'ne')) {
          problems.push(`enum_violation:${fact.id}=${String(value)};allowed=${fact.enum.join('|')}`)
        }
      }
      return
    }
    for (const key of ['args', 'arg']) {
      const v = node[key]
      if (Array.isArray(v)) v.forEach(walk)
      else if (v) walk(v)
    }
  }
  walk(expr)
  return problems
}

function callRecord(request: { requestId: string }, model: { provider: string; name: string }, rawText: string, usage: unknown, startedAt: string, finishedAt: string, failure: { code: string; detail: string } | null): CompileCall {
  const elapsed = Date.parse(finishedAt) - Date.parse(startedAt)
  return { requestId: request.requestId, provider: model.provider, model: model.name, rawText, usage, latencyMs: Number.isFinite(elapsed) ? elapsed : null, startedAt, finishedAt, failure }
}

export function createConditionCompiler(): ConditionCompiler {
  return {
    async compile(input: CompileInput, client: ModelClient, signal?: AbortSignal): Promise<CompileResult> {
      const checks: string[] = []
      if (!input.userTurns.length) return { status: 'error', reason: 'no_user_turns', rawCall: null, checks: ['no_input'] }
      if (!input.allowedFacts.length) return { status: 'error', reason: 'no_allowed_facts', rawCall: null, checks: ['no_facts'] }
      const view = buildCompileView(input)
      const request = makeRequest('condition-compile', [
        { role: 'system', content: view.system },
        { role: 'user', content: view.user },
      ], input.now)
      const startedAt = new Date().toISOString()
      const result = await client.complete(request, signal)
      const finishedAt = new Date().toISOString()
      const model = result.ok ? result.response.model : { provider: 'unknown', name: 'unknown' }
      if (!result.ok) {
        return { status: 'error', reason: `model_${result.code}:${result.detail}`, rawCall: callRecord(request, model, '', null, startedAt, finishedAt, { code: result.code, detail: result.detail }), checks: [...checks, `model_failure:${result.code}`] }
      }
      const rawText = result.response.rawText
      // 已知的模型排版错误：follow 对象后多一个根闭合，再写 {"quotes"。先做只删多余闭合的
      // 结构化修复，再解析；不改变任何字段值或条件语义。
      const parseText = rawText
        .replace(/\}\s*,\s*\{\s*"quotes"/g, '},"quotes"')
        .replace(/\}\}\s*,?\s*\{?\s*"quotes"/g, '},"quotes"')
      let parsed = parseModelJson(parseText)
      if (parseText !== rawText) checks.push('local_structure_repair')
      let finalText = rawText
      let usage: unknown = result.response.usage ?? null
      if (!parsed.ok) {
        // 先做确定性的本地语法修复（仅去尾逗号/统一弯引号），不改任何字段与语义；
        // 失败才发起下一次模型调用。
        const relaxed = parseModelJson(
          parseText
            // 模型常把 follow 对象后再补一个根闭合，然后继续写 quotes/unsupported；
            // 只去掉这个多余闭合，不改任何字段或语义。
            .replace(/\}\}\s*,\s*"quotes"/g, '},"quotes"')
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/[“”]/g, '"'),
        )
        if (relaxed.ok) {
          parsed = relaxed
          checks.push('local_syntax_repair')
        }
      }
      if (!parsed.ok) {
        // 有界重试（仅语法修复）：原输入+原输出+错误都留在 rawCall/checks；
        // 成功也标 parse_retry_used，绝不把“补了 JSON”当成语义修复。
        checks.push(`parse_error_first:${parsed.detail}`)
        const repair = makeRequest('condition-repair', [
          { role: 'system', content: view.system },
          { role: 'user', content: `${view.user}\n\n---\n你上一次的输出是：\n${rawText}\n\n它不是合法 JSON（${parsed.detail}）。只做语法修复：保持已确定的 when/quotes/unsupported 语义不变，输出一个完整合法 JSON 对象；不要新增或删除条件。` },
        ], input.now)
        const retry = await client.complete(repair, signal)
        if (retry.ok) {
          const retryParsed = parseModelJson(retry.response.rawText)
          if (retryParsed.ok) {
            parsed = retryParsed
            finalText = retry.response.rawText
            usage = [usage, retry.response.usage ?? null]
            checks.push('parse_retry_used')
          } else {
            checks.push(`parse_retry_failed:${retryParsed.detail}`)
          }
        } else {
          checks.push(`parse_retry_model_${retry.code}`)
        }
      }
      if (!parsed.ok) return { status: 'error', reason: `parse_error:${parsed.detail}`, rawCall: callRecord(request, model, finalText, usage, startedAt, finishedAt, { code: 'parse_error', detail: parsed.detail }), checks: [...checks, 'parse_error'] }
      let candidate = parsed.value as RawCandidate
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { status: 'error', reason: 'output_not_object', rawCall: callRecord(request, model, finalText, usage, startedAt, finishedAt, { code: 'bad_response', detail: 'not_object' }), checks: [...checks, 'structure_error'] }

      const unsupported = Array.isArray(candidate.unsupported) ? candidate.unsupported.filter((x): x is string => typeof x === 'string') : []
      let quoteCheck = validateQuotes(candidate, budgetTurns(input.userTurns))
      if (!quoteCheck.ok) return { status: 'error', reason: quoteCheck.reason, rawCall: callRecord(request, model, rawText, result.response.usage ?? null, startedAt, finishedAt, { code: 'bad_source', detail: quoteCheck.reason }), checks: [...checks, `source_rejected:${quoteCheck.reason}`] }
      checks.push('quotes_verbatim')

      // 相关性过滤：模型常把清单/缓存/日志路径等无关聊天塞进 unsupported。
      // 只保留直接限制“何时问/何时结束”的子句；这不解释语义，只做关键词相关性判断。
      const RELEVANT_UNSUPPORTED = /失败|成功|报告|等|问|归档|继续|重跑|提醒|确认|完成|到齐|回来|CI/u
      const relevantUnsupported = unsupported.filter((item) => RELEVANT_UNSUPPORTED.test(item))
      if (relevantUnsupported.length > 0) return { status: 'unsupported', reason: `unsupported_clauses:${relevantUnsupported.length}`, rawCall: callRecord(request, model, rawText, result.response.usage ?? null, startedAt, finishedAt, null), checks: [...checks, 'unsupported_declared'] }
      if (unsupported.length > 0) checks.push(`unsupported_filtered:${unsupported.length}`)

      // 结构归一：模型常把 when 写成表达式数组（[cmp] 或 [cmp,cmp]），语义等价于 all(args)；
      // 单元素等价于该元素。只做结构归一，不改变任何条件语义与引用。
      const normalizeExpr = (node: any): any => {
        if (Array.isArray(node)) {
          const items = node.map(normalizeExpr)
          return items.length === 1 ? items[0] : { op: 'all', args: items }
        }
        if (node && typeof node === 'object') {
          if (Array.isArray(node.args)) return { ...node, args: node.args.map(normalizeExpr) }
          if (node.arg !== undefined) return { ...node, arg: normalizeExpr(node.arg) }
        }
        return node
      }
      if (Array.isArray((candidate as any).when)) checks.push('structure_normalized:array')
      ;(candidate as any).when = normalizeExpr((candidate as any).when)
      // 枚举词汇归一：模型常把 succeeded 写成 completed/success/passed；只归一这些同义
      // 词汇并记录（checks + 计划仍用统一枚举），不改条件结构、不新增/删除条件。
      const STATUS_ALIASES: Record<string, string> = { completed: 'succeeded', success: 'succeeded', passed: 'succeeded', ok: 'succeeded', succeed: 'succeeded', failure: 'failed', error: 'failed', broken: 'failed' }
      const normalizeLiterals = (node: any): void => {
        if (!node || typeof node !== 'object') return
        if (node.op === 'cmp' && typeof node.value === 'string') {
          const fact = input.allowedFacts.find((f) => f.id === node.fact)
          const canonical = STATUS_ALIASES[node.value]
          if (fact?.enum && canonical && fact.enum.includes(canonical)) {
            checks.push(`literal_normalized:${node.value}->${canonical}`)
            node.value = canonical
          }
        }
        for (const key of ['args', 'arg']) {
          const v = node[key]
          if (Array.isArray(v)) v.forEach(normalizeLiterals)
          else if (v) normalizeLiterals(v)
        }
      }
      normalizeLiterals(candidate.when)
      try {
        validateExpr(candidate.when, factIds(input.allowedFacts))
      } catch (error) {
        return { status: 'error', reason: `invalid_expression:${error instanceof Error ? error.message : String(error)}`, rawCall: callRecord(request, model, rawText, result.response.usage ?? null, startedAt, finishedAt, { code: 'invalid_expression', detail: error instanceof Error ? error.message : String(error) }), checks: [...checks, 'structure_rejected'] }
      }
      const literalProblems = checkLiterals(candidate.when, input.allowedFacts)
      if (literalProblems.length > 0) {
        return { status: 'error', reason: `invalid_literals:${literalProblems.join('|')}`, rawCall: callRecord(request, model, rawText, result.response.usage ?? null, startedAt, finishedAt, { code: 'invalid_literals', detail: literalProblems.join('|') }), checks: [...checks, 'literals_rejected'] }
      }
      checks.push('structure_ok', 'facts_registered')


      // 有界方向修复：模型把“成功才问”写成失败条件（或反之）时，只再问一次方向；
      // 不改用户原话、不新增字段。修不好就交回宿主兜底，绝不把反向计划当原生结果。
      let directionProblems = validateDirection(candidate.when, quoteCheck.quotes.map((q) => q.text).join('\n'))
      if (directionProblems.length) {
        checks.push(`direction_first:${directionProblems.join('|')}`)
        const repair = makeRequest('condition-repair', [
          { role: 'system', content: view.system },
          { role: 'user', content: `${view.user}\n\n---\n你上一次的输出是：\n${finalText}\n\n它的 when 方向与该用户承诺相反（${directionProblems.join('|')}）。只修正 when 的方向：用户说“都成功才问”就用 succeeded；说“任何一份失败就问我”就用 failed；不要用 not，也不要把 present 混进来。保持 quotes 与 follow 不新增字段，输出完整 JSON。` },
        ], input.now)
        const retry = await client.complete(repair, signal)
        let repaired = false
        if (retry.ok) {
          const retryParsed = parseModelJson(retry.response.rawText)
          if (retryParsed.ok && retryParsed.value && typeof retryParsed.value === 'object' && !Array.isArray(retryParsed.value)) {
            const retryCandidate = retryParsed.value as RawCandidate
            const retryQuotes = validateQuotes(retryCandidate, budgetTurns(input.userTurns))
            const retryUnsupported = Array.isArray(retryCandidate.unsupported) ? retryCandidate.unsupported : []
            if (retryQuotes.ok && retryUnsupported.length === 0) {
              ;(retryCandidate as any).when = normalizeExpr((retryCandidate as any).when)
              normalizeLiterals(retryCandidate.when)
              const literalRetry = checkLiterals(retryCandidate.when, input.allowedFacts)
              let structural = true
              try { validateExpr(retryCandidate.when, factIds(input.allowedFacts)) } catch { structural = false }
              const retryProblems = validateDirection(retryCandidate.when, retryQuotes.quotes.map((q) => q.text).join('\n'))
              if (structural && literalRetry.length === 0 && retryProblems.length === 0) {
                candidate = retryCandidate
                quoteCheck = retryQuotes
                finalText = retry.response.rawText
                usage = [usage, retry.response.usage ?? null]
                checks.push('direction_repair_used')
                repaired = true
                directionProblems = []
              } else {
                directionProblems = retryProblems.length ? retryProblems : ['invalid_after_repair']
              }
            }
          }
        } else {
          checks.push(`direction_repair_model_${retry.code}`)
        }
        if (!repaired) {
          const detail = `direction_rejected:${directionProblems.join('|')}`
          return { status: 'error', reason: detail, rawCall: callRecord(request, model, finalText, usage, startedAt, finishedAt, { code: 'direction_rejected', detail }), checks: [...checks, 'direction_rejected'] }
        }
      }

      const promiseTextForFollow = quoteCheck.quotes.map((q) => q.text).join('\n')
      const nestedFollow = candidate.follow as { mode?: unknown; quotes?: unknown } | undefined
      const rawFollow = candidate.followMode !== undefined || candidate.followQuotes !== undefined
        ? { mode: candidate.followMode, quotes: candidate.followQuotes }
        : nestedFollow
      let follow: FollowPlan
      if (rawFollow && typeof rawFollow === 'object') {
        if (rawFollow.mode !== 'end' && rawFollow.mode !== 'next_round') {
          return { status: 'error', reason: 'follow_mode_invalid', rawCall: callRecord(request, model, rawText, result.response.usage ?? null, startedAt, finishedAt, { code: 'follow_mode_invalid', detail: String(rawFollow.mode) }), checks: [...checks, 'follow_rejected'] }
        }
        const followQuotes = Array.isArray(rawFollow.quotes) && rawFollow.quotes.length
          ? validateQuotes({ quotes: rawFollow.quotes }, budgetTurns(input.userTurns))
          : null
        if (followQuotes && !followQuotes.ok) {
          return { status: 'error', reason: `follow_${followQuotes.reason}`, rawCall: callRecord(request, model, rawText, result.response.usage ?? null, startedAt, finishedAt, { code: 'follow_source_invalid', detail: followQuotes.reason }), checks: [...checks, 'follow_rejected'] }
        }
        if (!followQuotes && rawFollow.mode !== inferFollowMode(promiseTextForFollow)) {
          return { status: 'error', reason: 'follow_quote_missing', rawCall: callRecord(request, model, rawText, result.response.usage ?? null, startedAt, finishedAt, { code: 'follow_quote_missing', detail: rawFollow.mode }), checks: [...checks, 'follow_rejected'] }
        }
        follow = { mode: rawFollow.mode, quotes: followQuotes?.quotes ?? [], defaulted: !followQuotes }
      } else {
        follow = { mode: inferFollowMode(promiseTextForFollow), quotes: [], defaulted: true }
      }

      // 方向负控：冻结措辞里“都成功才问”不能被编译成“失败才问”，反之亦然。
      // 只检查引用原话的第一段（提问从句），不推断任意文本；方向相反就拒绝，
      // 交给宿主的有界模型兜底，而不是把反向计划当成原生结果。
      const promiseText = quoteCheck.quotes.map((q) => q.text).join('\n')
      const askPart = promiseText.split(/[；;]/)[0] ?? promiseText
      const wantsSuccess = /(?:都|全部|两份都)成功/u.test(askPart) && /问我|确认|继续/u.test(askPart)
      const wantsFailure = /失败/u.test(askPart) && /问我|确认|继续/u.test(askPart)
      const literals: string[] = []
      let numericFailed = false
      const collect = (node: any): void => {
        if (!node || typeof node !== 'object') return
        if (node.op === 'cmp') {
          if (typeof node.value === 'string') literals.push(node.value)
          if (String(node.fact).endsWith('.failed') && ['gt', 'ge'].includes(String(node.rel))) numericFailed = true
          return
        }
        for (const key of ['args', 'arg']) {
          const v = node[key]
          if (Array.isArray(v)) v.forEach(collect)
          else if (v) collect(v)
        }
      }
      collect(candidate.when)
      const hasFailed = literals.includes('failed') || numericFailed
      const hasSucceeded = literals.includes('succeeded')
      if ((wantsSuccess && !wantsFailure && hasFailed && !hasSucceeded)
        || (wantsFailure && !wantsSuccess && hasSucceeded && !hasFailed)) {
        const detail = `polarity_mismatch:${wantsSuccess ? 'success' : 'failure'}=>${literals.join('|')}`
        return { status: 'error', reason: detail, rawCall: callRecord(request, model, rawText, result.response.usage ?? null, startedAt, finishedAt, { code: 'polarity_mismatch', detail }), checks: [...checks, 'polarity_rejected'] }
      }
      const finalDirectionProblems = validateDirection(candidate.when, promiseTextForFollow)
      if (finalDirectionProblems.length) {
        const detail = `direction_rejected:${finalDirectionProblems.join('|')}`
        return { status: 'error', reason: detail, rawCall: callRecord(request, model, rawText, result.response.usage ?? null, startedAt, finishedAt, { code: 'direction_rejected', detail }), checks: [...checks, 'direction_rejected'] }
      }

      const when = candidate.when as Expr
      const key = compilationKey({
        taskId: input.taskId,
        commitmentRevision: input.commitmentRevision,
        userSources: quoteCheck.quotes.map((q) => ({ turnId: q.turnId, sha256: quoteSha(`${q.turnId}\u0000${q.start}\u0000${q.end}\u0000${q.text}`) })),
        schemaVersion: CONDITION_SCHEMA,
        bindingRegistrySha256: input.bindingRegistrySha256,
        compilerSha256: input.compilerSha256,
      })
      const plan: ConditionPlan = {
        schema: CONDITION_SCHEMA,
        taskId: input.taskId,
        commitmentRevision: input.commitmentRevision,
        compilationKey: key,
        bindingRegistrySha256: input.bindingRegistrySha256,
        sourceQuotes: quoteCheck.quotes,
        when,
        follow,
        unsupported: [],
        compiledAt: input.now,
        compilerSha256: input.compilerSha256,
      }
      return { status: 'compiled', plan, rawCall: callRecord(request, model, rawText, result.response.usage ?? null, startedAt, finishedAt, null), checks }
    },
  }
}
