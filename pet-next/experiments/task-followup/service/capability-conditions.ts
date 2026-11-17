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
import { createHash } from 'node:crypto'
import type { AssessmentDraft, AssessmentResponse, AssessmentSnapshot, AsyncAssessor } from '../runtime/assessment.ts'
import { CapabilityNotConfigured, createCapabilityHandle, findUserCancel } from './capability-assessor.ts'
import type { CapabilityHandle } from './capability-assessor.ts'
import { SHARED_READ_SLOTS } from '../capability/baselines/need-rule.ts'

const ASSESS_MAX = 768
const EXTRACT_MAX = 1536
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** 条件里实际引用的任务 id（用于识别“改口后不再依赖 B”）。 */
export function referencedTaskIds(expr: unknown): Set<string> {
  const out = new Set<string>()
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return
    if (node.op === 'cmp' && typeof node.fact === 'string') {
      const m = /^task:([^.]+)\./.exec(node.fact)
      if (m) out.add(m[1]!)
      return
    }
    for (const key of ['args', 'arg']) {
      const value = node[key]
      if (Array.isArray(value)) value.forEach(walk)
      else if (value) walk(value)
    }
  }
  walk(expr)
  return out
}

const CORRECTION_RE = /更正|不用等|别等|只等|只当参考|取消依赖/

/**
 * 确定性依赖更正：用户明确说“X 不用等了 / 只等 Y”时，直接更新依赖集合。
 * 只处理这两种明确措辞，不猜模糊表达；映射依据是任务标题与绑定别名（宿主已有的真实命名）。
 */
export function detectDependencyCorrection(
  turns: readonly { turnId: string; text: string }[],
  bindings: readonly { alias: string; taskId: string }[],
): { reportBindings: { alias: string; taskId: string }[]; sourceTurnIds: string[]; reason: string } | null {
  if (!bindings.length) return null
  const candidates = turns.slice(-3).filter((t) => t.text.length <= 200 && /不用等|别等|只等|不再等/.test(t.text))
  const turn = candidates.at(-1)
  if (!turn) return null
  const token = (value: string) => value.replace(/[\s\-—:：]/g, '').slice(0, 12)
  const names = (alias: string) => [alias, alias.split(/\s+/)[0] ?? '', alias.slice(0, 2)].filter((x) => x.length > 0)
  const keepMatch = /只等\s*([^\s，。；,;]{1,10})/.exec(turn.text)
  let kept: { alias: string; taskId: string }[]
  if (keepMatch) {
    const keep = keepMatch[1]!
    kept = bindings.filter((b) => names(b.alias).some((name) => keep.includes(name.slice(0, 2)) || name.includes(keep.slice(0, 2))))
  } else {
    kept = bindings.filter((b) => !names(b.alias).some((name) => new RegExp(`(不用等|别等|不再等)[^。；]{0,8}${name.slice(0, 2)}|${name.slice(0, 2)}[^。；]{0,8}(不用等|别等|不再等)`).test(turn.text)))
  }
  if (kept.length === bindings.length) return null
  return { reportBindings: [...kept], sourceTurnIds: [turn.turnId], reason: 'explicit_dependency_correction' }
}

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
  const stats = { assessments: 0, evaluated: 0, compiles: 0, compileHits: 0, asks: 0, waits: 0, fallbacks: 0, ignored: 0 }

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
    const bound = (task.reportBindings ?? []).map((b) => b.taskId)
    if (bound.length) return [...new Set([task.ticketId, ...bound])].sort()
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

  const assessor: AsyncAssessor = {
    id: `conditions/v1:${cfg.ok ? cfg.config.model : 'override'}`,
    capability: true,
    async assess(snapshot: AssessmentSnapshot, _packet, signal): Promise<AssessmentResponse> {
      const { mem: memStore, plans: planStore } = need()
      stats.assessments += 1
      const task = snapshot.task
      // A：V/T 两种真实不同的记忆实现，由 PET_MEMORY_ADAPTER 选择（默认 versioned）。
      const memoryKind = adapterKindFromEnv(process.env)
      const loaded = await compilation.run(task.ticketId, (compilationSignal) => loadMemory(memoryKind, {
        store: memStore,
        client,
        taskId: task.ticketId,
        taskTitle: task.title,
        now: new Date().toISOString(),
        signal: compilationSignal,
        extract: { entities: [{ id: task.ticketId, type: 'task', label: task.title }], maxTurns: 12, maxTokens: EXTRACT_MAX },
        read: { question: `${task.title} 的条件承诺、用户更正与当前结果`, requiredSlots: SHARED_READ_SLOTS, maxItems: 24, maxChars: 4500 },
      }))
      const extraction = loaded.extraction ?? { status: 'applied', requestId: null }
      // 抽取失败不拖垮整次判断：沿用已持久化记忆，错误记录在 memoryView/extractionError。
      if (signal.aborted) throw signal.reason ?? new Error('aborted')

      const now = new Date().toISOString()
      const control = findUserCancel(memStore, task.ticketId, now)
      if (control) return { drafts: [], taskControl: control, raw: { provider: 'conditions', model: 'no-intervention-model-call', rawOutput: '', meta: { taskControl: control } } }

      const askTemplate = snapshot.actionMenu.find((item) => item.kind === 'ask_user' && (item.options?.length ?? 0) > 0)
      const packet = loaded.packet
      // 明确的依赖更正优先于编译：即使模型编译失败，也要把真实依赖改过来（S2 的核心）。
      const depCorrection = detectDependencyCorrection(
        loaded.view.turns.filter((t) => t.role === 'user').map((t) => ({ turnId: t.turnId, text: t.text })),
        task.reportBindings ?? [],
      )
      if (depCorrection) {
        stats.ignored += 1
        return {
          drafts: [],
          dependencyUpdate: depCorrection,
          raw: { provider: 'conditions', model: 'dependency-correction', rawOutput: '', meta: { dependencyUpdate: depCorrection, memoryView: { kind: loaded.view.kind, viewSha: loaded.view.viewSha, refs: loaded.view.refs } } },
        }
      }
      if (!task.result && !askTemplate) {
        stats.ignored += 1
        return {
          drafts: [{ intent: 'none', reasonCode: 'await_new_evidence', reasonText: '目录监听持续等待结果；当前无可选行动，不重复占用模型判断。' }],
          raw: { provider: 'event-driven-host', model: 'no-intervention-model-call', rawOutput: '', meta: { conditions: { skipped: 'no_result_no_menu' } } },
        }
      }

      const declaredTasks = declaredTasksOf(task, packet)
      const declarations: FactDeclaration[] = defaultFactDeclarations(declaredTasks)
      const bindingSha = bindingRegistrySha256(declarations, declaredTasks)
      const modelName = cfg.ok ? cfg.config.model : 'override'
      const compilerSha = compilerSha256({ name: modelName, provider: cfg.ok ? cfg.config.provider : 'override' })
      const fingerprint = commitmentFingerprint({
        revision: task.taskRevision,
        commitmentItemIds: packet.commitments.filter((i) => i.authority === 'user').map((i) => i.itemId),
        commitmentValues: packet.commitments.filter((i) => i.authority === 'user').map((i) => String(i.value ?? '')),
        latestUserTurnSha: (() => {
          const last = memStore.turns().filter((t) => t.role === 'user').at(-1)
          return last ? sha(last.text) : null
        })(),
      })
      const commitmentRevision = planStore.revision(task.ticketId, fingerprint, now)

      const replay = (): ConditionSummary => buildSummary(task.ticketId)
      let plan = planStore.current(task.ticketId)
      const stalePlan = !!plan && (plan.commitmentRevision !== commitmentRevision || plan.compilerSha256 !== compilerSha || plan.bindingRegistrySha256 !== bindingSha || plan.unsupported.length > 0)
      let compileStatus: 'hit' | 'compiled' | 'unsupported' | 'error' = 'hit'
      let compileDetail: string | null = null
      let rawCall: unknown = null
      if (!plan || stalePlan) {
        // 消费者只拿 MemoryView 里的原话（refs 可追溯）；T 同时给摘要，V 为 null。
        const view = loaded.view
        // 编译只给“承诺相关”的原话：承诺/偏好条目的证据 + 摘要引用 + 最后一条用户原话。
        // 96 条历史里的填充内容不进编译输入，避免模型把它们当成待支持子句。
        const focus = new Set<string>([...packet.commitments, ...packet.preferences].flatMap((i) => i.evidenceTurnIds))
        for (const id of view.summaryKeyTurns) focus.add(id)
        const lastUser = view.turns.filter((t) => t.role === 'user').at(-1)
        if (lastUser) focus.add(lastUser.turnId)
        const focused = view.turns.filter((t) => t.role === 'user' && focus.has(t.turnId)).slice(-12)
        const base = focused.length ? focused : view.turns.filter((t) => t.role === 'user').slice(-6)
        // 有更正时，更正之前的旧承诺已被替代：只把“更正及其之后”的原话交给编译器，
        // 避免模型把作废条件与更正条件用 all 合并（S2 的真实失败）。
        const correctionAt = base.map((t) => CORRECTION_RE.test(t.text)).lastIndexOf(true)
        const chosen = correctionAt >= 0 ? base.slice(correctionAt) : base
        const turns = chosen.map((t) => ({ turnId: t.turnId, role: 'user' as const, at: t.at, text: t.text, sha256: sha(t.text) }))
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

      // 改口收窄依赖：编译产物不再引用 B，且引用原话是更正 → 交给宿主更新真实 bindings（事务内撤销旧问题/授权）。
      const referenced = referencedTaskIds(plan!.when)
      const currentDeps = (task.reportBindings ?? []).map((b) => b.taskId)
      const dropped = currentDeps.filter((id) => !referenced.has(id))
      const correction = plan!.sourceQuotes.some((q) => CORRECTION_RE.test(q.text))
      if (dropped.length > 0 && correction) {
        const aliasOf = new Map((task.reportBindings ?? []).map((b) => [b.taskId, b.alias]))
        const bindings = [...referenced]
          .filter((id) => id !== task.ticketId)
          .map((id) => ({ alias: aliasOf.get(id) ?? `依赖${id.slice(-6)}`, taskId: id }))
        stats.ignored += 1
        return {
          drafts: [],
          dependencyUpdate: {
            reportBindings: bindings,
            sourceTurnIds: plan!.sourceQuotes.map((q) => q.turnId),
            reason: `correction dropped ${dropped.join(',')}`,
          },
          raw: {
            provider: 'conditions', model: 'dependency-update', rawOutput: '',
            meta: { dependencyUpdate: { bindings, dropped, sourceTurnIds: plan!.sourceQuotes.map((q) => q.turnId) }, plan: plan!.compilationKey, memoryView: { kind: loaded.view.kind, viewSha: loaded.view.viewSha, refs: loaded.view.refs } },
          },
        }
      }

      const context = makeContext(task, packet, {
        taskId: task.ticketId, declaredTasks,
        result: verifiedResult(task, now),
        resultsByTask: resultsByTask(task),
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
        stats.asks += 1
        planStore.recordEval({ ...record, action: 'ask' })
        const options = askTemplate.options ?? []
        const draft: AssessmentDraft = {
          intent: 'ask_now',
          actionId: askTemplate.actionId,
          reasonCode: 'condition_satisfied',
          reasonText: `条件已满足：${readText}。依据你的原话 ${quoteText}`,
          question: askTemplate.question ?? `${task.title} 的条件已经满足，现在处理吗？`,
          options,
        }
        return { drafts: [draft], raw: { provider: 'conditions', model: 'event-evaluation', rawOutput: '', requestPayload: rawCall, meta } }
      }

      if (evaluation.state === 'false') {
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

      // unknown：缺证据/冲突/过期，不直接变成提问
      return await fallbackOrWait(task, snapshot, packet, signal, evidenceKey, now, `条件缺证据（${readText}）`, meta, record)
    },
  }

  async function fallbackOrWait(
    task: AssessmentSnapshot['task'], snapshot: AssessmentSnapshot, packet: CapPacket, signal: AbortSignal,
    evidenceKey: string, now: string, why: string, meta: Record<string, unknown>, record?: ConditionEvalRecord,
  ): Promise<AssessmentResponse> {
    const { plans: planStore } = need()
    const notBefore = new Date(Date.parse(now) + hostRecheckMs).toISOString()
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
