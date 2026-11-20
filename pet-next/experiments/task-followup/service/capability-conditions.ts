/**
 * R6 集成接线：`--assessor capability-conditions`（条件承诺 + 事件求值）。
 *
 * 一次 assess（不持事务）：
 *   抽取新原话（与 capability 臂同一 MemoryCompilation，单飞且取消不影响）→ 读该臂记忆包
 *   → 承诺版本/字段注册表/编译器版本决定编译身份 → 命中当前 plan 就只求值；
 *     未命中（首次/改口/撤回/字段变化）才编译一次，先写完整版本再切指针
 *   → makeContext 只读宿主已核验结果字节 + 用户有效记忆 + 宿主时钟 → evaluate(when)
 *   → true 且有当前合法选择才提问；false 有界等待；unknown/unsupported 同证据版本最多一次模型兜底。
 *
 * 旧 plan 在新承诺版本出现后立即不可行动（commitmentRevision 不匹配 → 走兜底/等待），
 * 不会因为保留旧指针而继续执行旧条件。工具执行仍只经既有用户授权链路。
 *
 * @module service/capability-conditions
 */
import type { DatabaseSync } from 'node:sqlite'
import { CapabilityMemoryStore } from '../capability/memory/store.ts'
import { adapterKindFromEnv, loadMemory } from '../capability/memory/adapters.ts'
import type { MemoryLoad } from '../capability/memory/adapters.ts'
import { extractPending } from '../capability/memory/extract.ts'
import { readForDecision } from '../capability/memory/read.ts'
import { ingestVerifiedOutcome, type VerifiedOutcome } from '../capability/memory/verified.ts'
import { MemoryCompilation } from '../capability/memory/compilation.ts'
import { OpenAICompatibleClient, configFromEnv } from '../capability/model/openai-compatible.ts'
import type { ModelClient } from '../capability/model/protocol.ts'
import type { MemoryPacket as CapPacket, Turn } from '../capability/memory/types.ts'
import { createConditionCompiler, compilerSha256 } from '../capability/conditions/compiler.ts'
import { makeContext } from '../capability/conditions/context.ts'
import { evaluate } from '../capability/conditions/kernel.ts'
import { SqliteConditionStore, commitmentFingerprint } from '../capability/conditions/store.ts'
import { WatchIndex } from '../capability/conditions/watch-index.ts'
import { bindingRegistrySha256, defaultFactDeclarations, COMPILE_INPUT_CHARS } from '../capability/conditions/plan-types.ts'
import type { CompileTurn, ConditionEvalRecord, ConditionPlan, FactDeclaration, VerifiedInputs, VerifiedResult } from '../capability/conditions/plan-types.ts'
import type { MemoryView } from '../capability/memory/view.ts'
import { createHash } from 'node:crypto'
import type { AssessmentDraft, AssessmentResponse, AssessmentSnapshot, AsyncAssessor } from '../runtime/assessment.ts'
import { CapabilityNotConfigured, createCapabilityHandle, findUserCancel } from './capability-assessor.ts'
import type { CapabilityHandle } from './capability-assessor.ts'
import { SHARED_READ_SLOTS } from '../capability/baselines/need-rule.ts'

const ASSESS_MAX = 768
const EXTRACT_MAX = 2048
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

const CORRECTION_RE = /更正|不用等|别等|只等|只当参考|取消依赖/

export interface ConditionSummary {
  readonly available: boolean
  readonly state: 'true' | 'false' | 'unknown' | null
  readonly action: string | null
  /** “为何现在问/为何不问” */
  readonly why: readonly string[]
  /** 已满足的事实 */
  readonly satisfied: readonly string[]
  /** 还在等什么 */
  readonly waiting: readonly string[]
  /** 缺什么证据（unknown 的原因） */
  readonly unknown: readonly string[]
  /** 用户原话（可核对），只在面板展示 */
  readonly quotes: readonly { readonly turnId: string; readonly text: string }[]
  readonly at: string | null
  /** 开发区信息：hash/内部 id 不上主区域 */
  readonly dev: { readonly compilationKey: string | null; readonly evidenceKey: string | null; readonly compilerSha256: string | null; readonly planRevision: number | null }
}

export interface ConditionsHandle extends CapabilityHandle {
  readonly conditionSummary: (taskId: string) => ConditionSummary
  readonly conditionStats: () => Record<string, number>
}

export interface ConditionsHandleOptions {
  readonly hostRecheckMs?: number
  /** 兜底用：复用现有逐事件模型判断（同证据版本最多一次）。 */
  readonly fallbackToModel?: boolean
}

const reason = (state: string): string => state === 'true' ? '条件已满足' : state === 'false' ? '条件未满足' : '缺证据'

/** when=false 的分支：显式 end 才归档；持续观察（含旧计划缺省）继续等待下一轮。 */
export function falseBranchAction(plan: import('../capability/conditions/plan-types.ts').ConditionPlan | null): 'wait' | 'archive' {
  return (plan?.follow?.mode ?? 'end') === 'next_round' ? 'wait' : 'archive'
}

/**
 * 静默归档的适用范围：条件只读“已声明报告的结果字段”。时间/可用性条件的 false
 * 只是“此刻不成立”，不能当作最终结论去关闭任务。
 * 返回条件实际读取且需要核验的任务；含非结果字段时返回 null。
 */
function resultTasksOf(expr: import('../capability/conditions/kernel.ts').Expr): string[] | null {
  const tasks = new Set<string>()
  const walk = (node: import('../capability/conditions/kernel.ts').Expr): boolean => {
    if (node.op === 'cmp') {
      const match = /^task:([^.]+)\.result\./.exec(node.fact)
      if (!match) return false
      tasks.add(match[1]!)
      return true
    }
    if (node.op === 'not') return walk(node.arg)
    return node.args.every(walk)
  }
  return walk(expr) ? [...tasks].sort() : null
}

export function createConditionsHandle(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  clientOverride?: ModelClient,
  handleOptions: ConditionsHandleOptions = {},
): ConditionsHandle {
  const hostRecheckMs = handleOptions.hostRecheckMs ?? 30 * 60_000
  const cfg = configFromEnv(env)
  if (!clientOverride && !cfg.ok) throw new CapabilityNotConfigured(`模型未配置：缺 ${cfg.missing.join(', ')}`)
  const client: ModelClient = clientOverride ?? new OpenAICompatibleClient(cfg.ok ? cfg.config : undefined, fetchImpl)
  const compiler = createConditionCompiler()
  const watched = new WatchIndex()
  const stats = { assessments: 0, evaluated: 0, compiles: 0, compileHits: 0, asks: 0, partialAsks: 0, waits: 0, follows: 0, archives: 0, fallbacks: 0, ignored: 0 }

  let mem: CapabilityMemoryStore | null = null
  let plans: SqliteConditionStore | null = null
  let inner: CapabilityHandle | null = null
  let seq = 0
  const compilation = new MemoryCompilation<MemoryLoad>()
  const need = (): { mem: CapabilityMemoryStore; plans: SqliteConditionStore } => {
    if (!mem || !plans) throw new Error('provider_error: conditions store not attached to host database')
    return { mem, plans }
  }

  const declaredTasksOf = (task: AssessmentSnapshot['task'], packet: CapPacket): string[] => {
    // R6-live：优先用宿主显式声明的依赖（reportBindings）；旧模式才从任务作用域承诺推断。
    // 显式绑定注册表（包括改口后为空的 []）优先：空数组表示用户已撤掉全部依赖，
    // 不能再从旧记忆条目里把被撤掉的来源捡回来。
    if (task.reportBindings !== undefined) {
      const bound = task.reportBindings.map((b) => b.taskId)
      return [...new Set([task.ticketId, ...bound])].sort()
    }
    const deps = packet.commitments
      .filter((i) => i.authority === 'user' && i.status === 'active' && i.scope.level === 'task' && i.scope.id)
      .map((i) => i.scope.id!)
      .filter((id) => id !== task.ticketId)
    return [...new Set([task.ticketId, ...deps])].sort()
  }

  /** 每个已声明来源的核验结果；未核验的来源为 null（不是 0/失败）。 */
  const resultsByTask = (task: AssessmentSnapshot['task']): Record<string, VerifiedResult | null> => {
    const out: Record<string, VerifiedResult | null> = {}
    const set = task.inputSet
    if (!set) {
      const single = verifiedResult(task)
      if (single) out[task.ticketId] = single
      return out
    }
    for (const entry of [set.primary, ...set.dependencies]) {
      out[entry.taskId] = entry.summary && entry.ref
        ? { ...entry.summary, resultFileSha: entry.ref.resultFileSha, artifactSha: entry.ref.artifactSha }
        : null
    }
    return out
  }

  const compileTurns = (memStore: CapabilityMemoryStore, taskId: string, packet: CapPacket): CompileTurn[] => {
    const ids = new Set<string>()
    for (const item of [...packet.commitments, ...packet.preferences, ...packet.currentFacts]) for (const id of item.evidenceTurnIds) ids.add(id)
    for (const ref of packet.context.recentTurns) ids.add(ref.turnId)
    const turns = memStore.turns()
      .filter((t) => ids.has(t.turnId) && t.role === 'user' && (t.taskIds.length === 0 || t.taskIds.includes(taskId)))
      .sort((a, b) => a.seq - b.seq)
    let used = 0
    const kept: CompileTurn[] = []
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const t = turns[i]!
      const cost = t.text.length + 40
      if (used + cost > COMPILE_INPUT_CHARS && kept.length > 0) break
      used += cost
      kept.unshift({ turnId: t.turnId, role: 'user', at: t.at, text: t.text, sha256: sha(t.text) })
    }
    return kept
  }


  const verifiedResult = (task: AssessmentSnapshot['task'], now: string = task.updatedAt): VerifiedInputs['result'] => {
    if (!task.result) return null
    const r = task.result
    return {
      runId: r.runId, revision: r.revision, status: r.status,
      metrics: {
        total: r.metrics.total, passed: r.metrics.passed, failed: r.metrics.failed,
        ...(typeof r.metrics.score === 'number' ? { score: r.metrics.score } : {}),
      },
      resultFileSha: r.resultFileSha, artifactSha: r.artifactSha, observedAt: now,
    }
  }

  const buildSummary = (taskId: string): ConditionSummary => {
    const { plans: p } = need()
    const plan = p.current(taskId)
    const last = p.lastEval(taskId)
    const dev = { compilationKey: plan?.compilationKey ?? null, evidenceKey: last?.evidenceKey ?? null, compilerSha256: plan?.compilerSha256 ?? null, planRevision: plan?.commitmentRevision ?? null }
    if (!plan || !last) return { available: false, state: null, action: null, why: [], satisfied: [], waiting: [], unknown: [], quotes: [], at: null, dev }
    const facts = last.watch
    const satisfied = last.reads.filter((r) => r.state === 'true').map((r) => r.fact)
    const unknown = last.reads.filter((r) => r.state === 'unknown').map((r) => `${r.fact}（${r.reason ?? 'unknown'}）`)
    const waiting = facts.filter((f) => !satisfied.includes(f) && !unknown.some((u) => u.startsWith(f)))
    return {
      available: true,
      state: last.state,
      action: last.action,
      why: [reason(last.state), ...(plan.unsupported.length ? [`模型不支持：${plan.unsupported.join('；')}`] : [])],
      satisfied,
      waiting,
      unknown,
      quotes: plan.sourceQuotes.map((q) => ({ turnId: q.turnId, text: q.text })),
      at: last.at,
      dev,
    }
  }

  /** 结果变化不需要重抽记忆：用已持久化的当前计划 + 最小记忆包直接求值。 */
  const fastLoad = (task: AssessmentSnapshot['task'], now: string): MemoryLoad => {
    const packet: CapPacket = {
      schema: 'pet-capability-memory-packet/v1', taskId: task.ticketId, asOf: now, evaluatedAt: now,
      intent: 'current', memoryCursor: task.memoryCursor,
      currentFacts: [], preferences: [], commitments: [], outcomes: [],
      evidenceRefs: [], missing: [], conflicts: [],
      context: { nonActionable: [], recentTurns: [], slotResolution: [], budgetUsed: { items: 0, chars: 0 }, truncated: false, diagnostics: ['fast_path_result_only'], summary: null },
    }
    const view: MemoryView = {
      kind: 'versioned', taskId: task.ticketId, turns: [], refs: [], coveredSeq: 0,
      coverage: { coveredSeq: 0, visitedSeq: 0, pending: 0 }, summary: null, summaryKeyTurns: [],
      packet, viewSha: sha(`fast:${task.ticketId}:${task.result?.resultFileSha ?? 'none'}`), detail: { fast: true },
    }
    return { kind: 'versioned', packet, view, detail: { fast: true } }
  }

  const assessor: AsyncAssessor = {
    id: `conditions/v1:${cfg.ok ? cfg.config.model : 'override'}`,
    capability: true,
    async assess(snapshot: AssessmentSnapshot, _packet, signal): Promise<AssessmentResponse> {
      const { mem: memStore, plans: planStore } = need()
      stats.assessments += 1
      const task = snapshot.task
      const now = new Date().toISOString()
      // 结果事件不需要重抽记忆：当前计划仍匹配声明/编译器，且编译后没有新的用户原话时，
      // 直接本地求值。首败提醒因此不再排在几分钟的记忆抽取之后。
      const fastPlanCandidate = planStore.current(task.ticketId)
      const fastDeclared = task.reportBindings !== undefined
        ? [...new Set([task.ticketId, ...task.reportBindings.map((b) => b.taskId)])].sort()
        : null
      const modelNameForFast = cfg.ok ? cfg.config.model : 'override'
      const compilerShaForFast = compilerSha256({ name: modelNameForFast, provider: cfg.ok ? cfg.config.provider : 'override' })
      const COMMITMENT_RE = /更正|不用等|别等|只等|只当参考|取消依赖|才来问我|再问我|就问我|问我是否|失败就|成功就/u
      const latestUserTurn = memStore.turns()
        .filter((t) => t.role === 'user' && (t.taskIds.length === 0 || t.taskIds.includes(task.ticketId)))
        .sort((a, b) => a.seq - b.seq).at(-1)
      const latestCommitmentTurn = memStore.turns()
        .filter((t) => t.role === 'user' && (t.taskIds.length === 0 || t.taskIds.includes(task.ticketId)) && COMMITMENT_RE.test(t.text))
        .sort((a, b) => a.seq - b.seq).at(-1)
      const fastQuoted = new Set((fastPlanCandidate?.sourceQuotes ?? []).map((q) => q.turnId))
      const fastNewCommitment = Boolean(latestCommitmentTurn && !fastQuoted.has(latestCommitmentTurn.turnId))
      const fastPath = Boolean(fastPlanCandidate && fastDeclared && latestUserTurn && !fastNewCommitment
        && fastPlanCandidate.bindingRegistrySha256 === bindingRegistrySha256(defaultFactDeclarations(fastDeclared), fastDeclared)
        && fastPlanCandidate.compilerSha256 === compilerShaForFast
        && fastPlanCandidate.unsupported.length === 0)
      const memoryKind = adapterKindFromEnv(process.env)
      const loaded = fastPath ? fastLoad(task, now) : await compilation.run(task.ticketId, (compilationSignal) => loadMemory(memoryKind, {
        store: memStore,
        client,
        taskId: task.ticketId,
        taskTitle: task.title,
        now,
        signal: compilationSignal,
        extract: { entities: [{ id: task.ticketId, type: 'task', label: task.title }], maxTurns: 48, maxTokens: EXTRACT_MAX },
        read: { question: `${task.title} 的条件承诺、用户更正与当前结果`, requiredSlots: SHARED_READ_SLOTS, maxItems: 24, maxChars: 4500 },
      }))
      const extraction = loaded.extraction ?? { status: fastPath ? 'skipped_fast_path' : 'applied', requestId: null }
      // 抽取失败不拖垮整次判断：沿用已持久化记忆，错误记录在 memoryView/extractionError。
      if (signal.aborted) throw signal.reason ?? new Error('aborted')

      const control = findUserCancel(memStore, task.ticketId, now)
      if (control) return { drafts: [], taskControl: control, raw: { provider: 'conditions', model: 'no-intervention-model-call', rawOutput: '', meta: { taskControl: control } } }

      const packet = loaded.packet
      if (!task.result && !snapshot.actionMenu.some((item) => item.kind === 'ask_user' && (item.options?.length ?? 0) > 0)) {
        stats.ignored += 1
        return {
          drafts: [{ intent: 'none', reasonCode: 'await_new_evidence', reasonText: '目录监听持续等待结果；当前无可选行动，不重复占用模型判断。' }],
          raw: { provider: 'event-driven-host', model: 'no-intervention-model-call', rawOutput: '', meta: { conditions: { skipped: 'no_result_no_menu' } } },
        }
      }
      // 无结果时，已编译计划且没有新的更正原话 → 后续填充聊天不重抽记忆/重编译。
      // 首条承诺仍会在计划为空时编译一次；结果到达时走 fastPath 本地求值。
      if (!task.result) {
        const anySourcePresent = Boolean(task.inputSet && [task.inputSet.primary, ...task.inputSet.dependencies].some((entry) => entry.ref))
        const existing = anySourcePresent ? null : planStore.current(task.ticketId)
        const COMMITMENT_RE_SKIP = /更正|不用等|别等|只等|只当参考|取消依赖|才来问我|再问我|就问我|问我是否|失败就|成功就/u
        const latestCommitment = memStore.turns()
          .filter((t) => t.role === 'user' && (t.taskIds.length === 0 || t.taskIds.includes(task.ticketId)) && COMMITMENT_RE_SKIP.test(t.text))
          .sort((a, b) => a.seq - b.seq).at(-1)
        const quoted = new Set((existing?.sourceQuotes ?? []).map((q) => q.turnId))
        const newCommitment = Boolean(latestCommitment && !quoted.has(latestCommitment.turnId))
        if (existing && !newCommitment) {
          stats.ignored += 1
          return {
            drafts: [{ intent: 'none', reasonCode: 'await_result', reasonText: '计划已编译且没有新的更正原话；等结果到达再本地求值。' }],
            raw: { provider: 'event-driven-host', model: 'no-intervention-model-call', rawOutput: '', meta: { conditions: { skipped: 'await_result', plan: existing.compilationKey } } },
          }
        }
      }

      const declaredTasks = fastPath ? fastDeclared! : declaredTasksOf(task, packet)
      const declarations: FactDeclaration[] = defaultFactDeclarations(declaredTasks)
      const bindingSha = bindingRegistrySha256(declarations, declaredTasks)
      const modelName = cfg.ok ? cfg.config.model : 'override'
      const compilerSha = compilerSha256({ name: modelName, provider: cfg.ok ? cfg.config.provider : 'override' })
      // 消费者只拿 MemoryView 里的原话（refs 可追溯）；T 同时给摘要，V 为 null。
      const view = loaded.view
      // 编译只给“承诺相关”的原话：承诺/偏好条目的证据 + 摘要引用 + 最后一条用户原话。
      // 96 条历史里的填充内容不进编译输入，避免模型把它们当成待支持子句。
      const turns: CompileTurn[] = []
      const focus = new Set<string>([...packet.commitments, ...packet.preferences].flatMap((i) => i.evidenceTurnIds))
      for (const id of view.summaryKeyTurns) focus.add(id)
      const lastUser = view.turns.filter((t) => t.role === 'user').at(-1)
      if (lastUser) focus.add(lastUser.turnId)
      // 最早承诺与最近更正一样重要：抽取/摘要推进后仍要把第一段真实用户原话交给编译器。
      // 从持久 turn 表取，而不是只从当前摘要窗口取；否则 96 条 intake 后首条承诺会被摘要裁掉。
      const firstUser = memStore.turns()
        .filter((t) => t.role === 'user' && !t.turnId.startsWith('delegate-')
          && (t.taskIds.length === 0 || t.taskIds.includes(task.ticketId)))
        .sort((a, b) => a.seq - b.seq)[0]
      const anchor = firstUser
        ? { turnId: firstUser.turnId, role: 'user' as const, at: firstUser.at, text: firstUser.text, seq: firstUser.seq, sha256: sha(firstUser.text) }
        : null
      if (firstUser) focus.add(firstUser.turnId)
      const focused = view.turns.filter((t) => t.role === 'user' && focus.has(t.turnId)).slice(-12)
      const withAnchor = anchor && !focused.some((t) => t.turnId === anchor.turnId) ? [anchor, ...focused] : focused
      const base = withAnchor.length ? withAnchor : view.turns.filter((t) => t.role === 'user').slice(-6)
      // 有更正时，更正之前的旧承诺已被替代：只把“更正及其之后”的原话交给编译器，
      // 避免模型把作废条件与更正条件用 all 合并（S2 的真实失败）。
      const correctionAt = base.map((t) => CORRECTION_RE.test(t.text)).lastIndexOf(true)
      const chosen = correctionAt >= 0 ? base.slice(correctionAt) : base
      if (!fastPath) turns.push(...chosen.map((t) => ({ turnId: t.turnId, role: 'user' as const, at: t.at, text: t.text, sha256: sha(t.text) })))
      const fingerprint = commitmentFingerprint({
        revision: task.taskRevision,
        commitmentItemIds: packet.commitments.filter((i) => i.authority === 'user').map((i) => i.itemId),
        commitmentValues: packet.commitments.filter((i) => i.authority === 'user').map((i) => String(i.value ?? '')),
        // The cache must track the scoped language the compiler actually received.
        latestUserTurnSha: sha(JSON.stringify({ quotes: turns.map(t => [t.turnId, t.sha256]), summary: view.summary })),
      })
      const commitmentRevision = fastPath ? fastPlanCandidate!.commitmentRevision : planStore.revision(task.ticketId, fingerprint, now)

      const replay = (): ConditionSummary => buildSummary(task.ticketId)
      let plan = fastPath ? fastPlanCandidate : planStore.current(task.ticketId)
      const stalePlan = !fastPath && !!plan && (plan.commitmentRevision !== commitmentRevision || plan.compilerSha256 !== compilerSha || plan.bindingRegistrySha256 !== bindingSha || plan.unsupported.length > 0)
      let compileStatus: 'hit' | 'compiled' | 'unsupported' | 'error' = 'hit'
      let compileDetail: string | null = null
      let rawCall: unknown = null
      if (fastPath) stats.compileHits += 1
      else if (!plan || stalePlan) {
        const compileIdentity = sha(JSON.stringify({ commitmentRevision, compilerSha, bindingSha, turnIds: turns.map((t) => t.turnId), viewSha: view.viewSha }))
        const cachedFailure = planStore.failure(task.ticketId, compileIdentity)
        if (cachedFailure) {
          // 同一编译身份已经失败过：不因 recheck 反复打模型；新的承诺版本/来源集合才重编。
          compileStatus = cachedFailure.status === 'unsupported' ? 'unsupported' : 'error'
          compileDetail = cachedFailure.detail
          stats.compileHits += 1
          plan = null
        } else if (turns.length === 0) {
          compileStatus = 'unsupported'
          compileDetail = 'no_user_turns_selected'
        } else {
          const result = await compiler.compile({
            taskId: task.ticketId, commitmentRevision, userTurns: turns, allowedFacts: declarations,
            bindingRegistrySha256: bindingSha, compilerSha256: compilerSha, now,
            memorySummary: view.summary, viewSha: view.viewSha,
          }, client, signal)
          rawCall = result.rawCall
          if (result.status === 'compiled') {
            compileStatus = 'compiled'
            planStore.put(result.plan)
            planStore.setCurrent(task.ticketId, result.plan.compilationKey)
            plan = result.plan
            watched.add(plan.compilationKey, [])
            stats.compiles += 1
          } else {
            compileStatus = result.status === 'unsupported' ? 'unsupported' : 'error'
            compileDetail = result.reason
            planStore.putFailure({
              taskId: task.ticketId, identity: compileIdentity, status: compileStatus, detail: result.reason,
              rawJson: JSON.stringify(result.rawCall ?? null), at: now,
            })
            // 新版本编译未成功：旧指针保留但已不可行动（revision 不匹配），只允许新版本兜底
            stats.compiles += 1
          }
        }
      } else {
        stats.compileHits += 1
      }

      const active = !!plan && plan.commitmentRevision === commitmentRevision && plan.compilerSha256 === compilerSha && plan.bindingRegistrySha256 === bindingSha && plan.unsupported.length === 0
      const evidenceKey = sha(JSON.stringify({
        plan: active ? plan!.compilationKey : `${compileStatus}:${compileDetail ?? ''}`,
        result: task.result ? `${task.result.revision}:${task.result.resultFileSha}` : 'none',
        sources: task.inputSet ? task.inputSet.sha : 'single',
        commitmentRevision,
        facts: bindingSha,
      }))

      const draftNone = (reasonCode: string, reasonText: string, meta: Record<string, unknown>): AssessmentResponse => ({
        drafts: [{ intent: 'none', reasonCode, reasonText }],
        raw: { provider: 'conditions', model: 'event-evaluation', rawOutput: '', requestPayload: rawCall, meta },
      })

      if (!active) {
        // 新版本 pending/error/unsupported：同证据版本最多一次模型兜底，之后有界等待
        const meta = { compile: { status: compileStatus, detail: compileDetail }, plan: plan ? { revision: plan.commitmentRevision, key: plan.compilationKey } : null, commitmentRevision, evidenceKey, memoryPacket: packet }
        return await fallbackOrWait(task, snapshot, packet, signal, evidenceKey, now, `新承诺版本未编译成功（${compileStatus}${compileDetail ? `：${compileDetail}` : ''}）`, meta)
      }

      const byTask = resultsByTask(task)
      const context = makeContext(task, packet, {
        taskId: task.ticketId, declaredTasks,
        result: verifiedResult(task, now),
        resultsByTask: byTask,
        // 可用性只由 context 按 key/作用域/有效期投影；不再取“最后一条任意事实”
        userAvailability: null,
      }, now)
      let evaluation
      try {
        evaluation = evaluate(plan!.when, context)
      } catch (error) {
        stats.ignored += 1
        return draftNone('condition_invalid', `条件表达式无法求值：${error instanceof Error ? error.message : String(error)}`, { plan: plan!.compilationKey, evidenceKey })
      }
      stats.evaluated += 1
      watched.add(plan!.compilationKey, evaluation.watch)
      const record: ConditionEvalRecord = {
        taskId: task.ticketId, compilationKey: plan!.compilationKey, evidenceKey,
        state: evaluation.state, watch: evaluation.watch,
        reads: evaluation.reads.map((r) => ({ fact: r.fact, state: r.state, ...(r.reason ? { reason: r.reason } : {}) })),
        action: 'none', at: now,
      }
      const meta = {
        plan: { compilationKey: plan!.compilationKey, commitmentRevision, compilerSha256: compilerSha, quotes: plan!.sourceQuotes },
        evaluation, evidenceKey, memoryPacket: packet, compile: { status: compileStatus, rawCall },
        memoryView: { kind: loaded.view.kind, viewSha: loaded.view.viewSha, refs: loaded.view.refs, coveredSeq: loaded.view.coveredSeq, summarySha: loaded.view.summary ? sha(loaded.view.summary) : null },
      }
      const quoteText = plan!.sourceQuotes.map((q) => `「${q.text}」`).join(' ')
      const readText = evaluation.reads.map((r) => `${r.fact}=${r.state}${r.reason ? `(${r.reason})` : ''}`).join('，')

      // 首败：已核验失败来源 + 仍缺来源，所有策略共用宿主注入的同一组选项。
      const set = task.inputSet
      const entries = set ? [set.primary, ...set.dependencies] : []
      const failed = entries.filter((entry) => entry.ref && entry.summary?.status === 'failed')
      const waiting = entries.filter((entry) => !entry.ref)
      const partialTemplate = snapshot.actionMenu.find((item) => item.kind === 'ask_user' && (item.options?.some((option) => option.id === 'analyze_this') ?? false))
      const normalTemplate = snapshot.actionMenu.find((item) => item.kind === 'ask_user' && (item.options?.length ?? 0) > 0)
      const partialEligible = Boolean(set && !set.ok && failed.length && waiting.length && partialTemplate)
      const partialShas = failed.map((entry) => entry.ref!.resultFileSha)
      const samePartialFailure = Boolean(task.partial && partialShas.length === task.partial.failedShas.length
        && partialShas.every((value) => task.partial!.failedShas.includes(value)))
      const askTemplate = partialEligible ? partialTemplate : normalTemplate

      const analyzedFailedSha = task.analysis?.scope === 'partial' ? task.analysis.inputRef?.resultFileSha : null
      const alreadyAnalyzedFailure = Boolean(analyzedFailedSha && failed.some((entry) => entry.ref?.resultFileSha === analyzedFailedSha))
      if (evaluation.state === 'true' && alreadyAnalyzedFailure) {
        planStore.recordEval({ ...record, action: 'skip' })
        stats.ignored += 1
        return draftNone('partial_already_analyzed', '这份失败报告已经按你的选择分析过；同一失败版本不重复追问，等新一轮或新失败再判。', meta)
      }

      if (evaluation.state === 'true' && samePartialFailure) {
        if (task.partial?.optionId === 'skip_once') {
          planStore.recordEval({ ...record, action: 'skip' })
          stats.ignored += 1
          return draftNone('skip_once_active', '这次失败已选择跳过，同一失败版本不重复追问。', meta)
        }
        if (task.partial?.optionId === 'wait_other' && set && !set.ok) {
          planStore.recordEval({ ...record, action: 'wait' })
          stats.waits += 1
          return draftNone('wait_other_active', '已选择等另一份报告；同一失败版本不重复追问，另一份到达后再判。', meta)
        }
      }

      if (evaluation.state === 'true') {
        if (!askTemplate) {
          planStore.recordEval({ ...record, action: 'wait' })
          return draftNone('condition_true_no_option', `条件已满足（${readText}），但宿主当前没有可选行动，继续有界等待。`, meta)
        }
        const askKey = `ask:${evidenceKey}`
        if (!planStore.markOnce(task.ticketId, askKey, now)) {
          planStore.recordEval({ ...record, action: 'skip' })
          stats.ignored += 1
          return draftNone('asked_same_evidence', `同一证据版本已提问，等待回答，不重复打扰。`, meta)
        }
        if (partialEligible) stats.partialAsks += 1
        stats.asks += 1
        planStore.recordEval({ ...record, action: 'ask' })
        const options = askTemplate.options ?? []
        const draft: AssessmentDraft = {
          intent: 'ask_now',
          actionId: askTemplate.actionId,
          reasonCode: partialEligible ? 'first_failure_partial' : 'condition_satisfied',
          reasonText: partialEligible
            ? `已有失败来源核验（${failed.map((entry) => entry.alias).join('、')}），仍有来源未到（${waiting.map((entry) => entry.alias).join('、')}）；先问是否只分析这份。依据你的原话 ${quoteText}`
            : `条件已满足：${readText}。依据你的原话 ${quoteText}`,
          question: askTemplate.question ?? `${task.title} 的条件已经满足，现在处理吗？`,
          options,
        }
        return { drafts: [draft], raw: { provider: 'conditions', model: 'event-evaluation', rawOutput: '', requestPayload: rawCall, meta } }
      }

      if (evaluation.state === 'false') {
        const follow = plan!.follow
        if (falseBranchAction(plan) === 'wait') {
          stats.follows += 1
          planStore.recordEval({ ...record, action: 'wait' })
          const followQuote = follow?.quotes.map((q) => `「${q.text}」`).join(' ') ?? ''
          const notBefore = new Date(Date.parse(now) + hostRecheckMs).toISOString()
          return {
            drafts: [{
              intent: 'wait', reasonCode: 'follow_next_round',
              reasonText: `本轮条件未成立（${readText}），按你的原话 ${followQuote || quoteText} 先安静，继续跟下一轮；${Math.round(hostRecheckMs / 60000)} 分钟后按当前证据复查。`,
              notBefore,
            }],
            raw: { provider: 'conditions', model: 'event-evaluation', rawOutput: '', requestPayload: rawCall, meta },
          }
        }
        // 条件明确“此刻不该问”，且条件实际读取的来源都已核验 → 这是承诺的终局：
        // 安静归档，不发通知、不建 attention、不执行工具。
        const used = resultTasksOf(plan!.when)
        // 显式绑定注册表存在（含改口后为空 []) 才可归档；单来源旧任务 reportBindings 未定义。
        // false 在三值逻辑里已经确定（补上未知事实也不会变 true）；只要至少一个
        // 已核验来源锚定判断即可归档，不要求所有被引用的来源都到齐。
        const canArchive = Boolean(used && used.length > 0 && task.reportBindings !== undefined
          && used.includes(task.ticketId) && used.some((id) => Boolean(byTask[id])))
        if (canArchive && used) {
          stats.archives += 1
          planStore.recordEval({ ...record, action: 'archive' })
          return {
            drafts: [{
              intent: 'archive',
              reasonCode: 'commitment_no_ask',
              reasonText: `条件未成立（${readText}）；按你的原话 ${quoteText} 静默归档，不打扰。`,
              archive: {
                compilationKey: plan!.compilationKey,
                condition: JSON.stringify(plan!.when),
                quotes: plan!.sourceQuotes.map((q) => ({ turnId: q.turnId, text: q.text })),
                taskIds: used,
              },
            }],
            raw: { provider: 'conditions', model: 'event-evaluation', rawOutput: '', requestPayload: rawCall, meta },
          }
        }
        stats.waits += 1
        planStore.recordEval({ ...record, action: 'wait' })
        const notBefore = new Date(Date.parse(now) + hostRecheckMs).toISOString()
        return {
          drafts: [{
            intent: 'wait', reasonCode: 'condition_not_met',
            reasonText: `条件未满足（${readText}）；依据你的原话 ${quoteText}；${Math.round(hostRecheckMs / 60000)} 分钟后按当前证据复查。`,
            notBefore,
          }],
          raw: { provider: 'conditions', model: 'event-evaluation', rawOutput: '', requestPayload: rawCall, meta },
        }
      }

      // unknown：缺证据/冲突/过期，不直接变成提问。若只是“报告还没到齐”，
      // 承诺已经说明该等；不要为此占用一次慢速模型兜底（会把后续原生判断堵在队后）。
      const sourcesComplete = declaredTasks.every((id) => Boolean(byTask[id]))
      return await fallbackOrWait(task, snapshot, packet, signal, evidenceKey, now, `条件缺证据（${readText}）`, meta, record, sourcesComplete)
    },
  }

  async function fallbackOrWait(
    task: AssessmentSnapshot['task'], snapshot: AssessmentSnapshot, packet: CapPacket, signal: AbortSignal,
    evidenceKey: string, now: string, why: string, meta: Record<string, unknown>, record?: ConditionEvalRecord,
    allowFallback = true,
  ): Promise<AssessmentResponse> {
    const { plans: planStore } = need()
    const notBefore = new Date(Date.parse(now) + hostRecheckMs).toISOString()
    if (!allowFallback) {
      stats.waits += 1
      if (record) planStore.recordEval({ ...record, action: 'wait' })
      return {
        drafts: [{ intent: 'wait', reasonCode: 'condition_waiting_sources', reasonText: `${why}；声明的报告尚未齐备，按承诺等待，不调用模型兜底；${Math.round(hostRecheckMs / 60000)} 分钟后按当前证据复查。`, notBefore }],
        raw: { provider: 'conditions', model: 'event-evaluation', rawOutput: '', meta: { ...meta, fallback: 'skipped_sources_incomplete' } },
      }
    }
    const key = `fallback:${evidenceKey}`
    const first = planStore.markOnce(task.ticketId, key, now)
    if (!first || handleOptions.fallbackToModel === false || !inner) {
      stats.waits += 1
      if (record) planStore.recordEval({ ...record, action: 'wait' })
      return {
        drafts: [{ intent: 'wait', reasonCode: record ? 'condition_unknown' : 'condition_uncompiled', reasonText: `${why}；不转成提问，${Math.round(hostRecheckMs / 60000)} 分钟后按当前证据复查。`, notBefore }],
        raw: { provider: 'conditions', model: 'event-evaluation', rawOutput: '', meta: { ...meta, fallback: first ? 'unavailable' : 'already_used' } },
      }
    }
    stats.fallbacks += 1
    if (record) planStore.recordEval({ ...record, action: 'fallback' })
    // 兜底完全复用 capability 臂：它不使用 runtime 侧的 packet 包装，这里按签名原样传入。
    const response = await inner.assessor.assess(snapshot, undefined as unknown as Parameters<CapabilityHandle['assessor']['assess']>[1], signal)
    return { ...response, raw: { ...response.raw, meta: { ...(typeof response.raw.meta === 'object' && response.raw.meta ? response.raw.meta : {}), conditions: meta, fallbackReason: why } } }
  }

  return {
    assessor,
    attach(db: DatabaseSync) {
      mem = new CapabilityMemoryStore(db)
      plans = new SqliteConditionStore(db)
      seq = (mem.turns().at(-1)?.seq ?? 0)
      if (handleOptions.fallbackToModel !== false) {
        try {
          inner = createCapabilityHandle(env, fetchImpl, client, { hostRecheckMs, intervention: 'model' })
          inner.attach(db)
        } catch (error) {
          if (!(error instanceof CapabilityNotConfigured)) throw error
          inner = null
        }
      }
    },
    appendTurn(turn) {
      const { mem: memStore } = need()
      if (memStore.turns().some((existing) => existing.turnId === turn.turnId)) return false
      seq += 1
      memStore.appendTurn({ ...turn, seq: turn.seq ?? seq } as Turn)
      return true
    },
    ingestResult(turn, taskId, outcome: VerifiedOutcome) {
      const { mem: memStore } = need()
      if (!memStore.turns().some((existing) => existing.turnId === turn.turnId)) {
        seq += 1
        memStore.appendTurn({ ...turn, seq } as Turn)
      }
      ingestVerifiedOutcome(memStore, memStore.turn(turn.turnId)!, taskId, outcome, turn.at)
      return true
    },
    hostRecheckMs,
    validateTaskControl(control, snapshot, now) {
      const current = findUserCancel(need().mem, snapshot.task.ticketId, now)
      return !!current && current.kind === control.kind && current.itemId === control.itemId
    },
    memorySummary(taskId, now) {
      return readForDecision(need().mem, { taskId, asOf: now, intent: 'current', question: '', requiredSlots: [], budget: { maxItems: 20, maxChars: 3000 } })
    },
    conditionSummary: (taskId: string) => buildSummary(taskId),
    conditionStats: () => ({ ...stats, watch: watched.stats().evaluated, watchSkipped: watched.stats().skipped }),
    async close() { await compilation.close(new Error('host stopping')) },
    model: { baseUrl: cfg.ok ? cfg.config.baseUrl : 'override', name: cfg.ok ? cfg.config.model : 'override', provider: cfg.ok ? cfg.config.provider : 'override' },
  }
}
