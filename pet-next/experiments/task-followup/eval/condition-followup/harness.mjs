#!/usr/bin/env node
/**
 * R6-D 五臂对照驱动（离线重放）。
 *
 * 五臂：V-R（版本记忆+强规则）、V-L（版本记忆+逐事件LLM）、V-C（版本记忆+条件IR）、
 *       T-L（强文本记忆+逐事件LLM）、T-C（强文本记忆+条件IR）。
 *
 * 诚实边界：
 * - 本文件只做离线重放：没有真实模型端点时，LLM 臂用与强规则等价的确定性 stub 代替，
 *   IR 臂的编译结果是离线手写 fixture（fixtures/compiled/*.json），不是模型输出。
 * - 因此 summary 标 `mode: offline-replay`、`capabilityResult: false`；真实 72 跑必须另跑并另存。
 * - 记忆读取差异用确定性检索模拟（版本记忆=全部有效原话；文本记忆=近期窗口+词面 BM25 top3），
 *   这是机制演示，不是真实检索质量结论。
 *
 * 用法：node harness.mjs --stories <dir> --out <dir> [--split dev|verify] [--arm V-R,...]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const ARMS = [
  { id: 'V-R', memory: 'version', policy: 'rule', label: '版本记忆+强规则' },
  { id: 'V-L', memory: 'version', policy: 'llm', label: '版本记忆+逐事件LLM' },
  { id: 'V-C', memory: 'version', policy: 'ir', label: '版本记忆+条件IR' },
  { id: 'T-L', memory: 'text', policy: 'llm', label: '强文本记忆+逐事件LLM' },
  { id: 'T-C', memory: 'text', policy: 'ir', label: '强文本记忆+条件IR' },
]

const TERMS = ['报告', '回来', '改口', '取消', '撤回', '出差', '退出码', '齐', '问', '等']

/** 确定性“检索”：版本记忆读所有有效原话；文本记忆只读近期 6 轮 + 词面 top3。 */
export function readMemory(story, mode, eventIndex) {
  const turns = []
  for (const session of story.sessions) for (const turn of session.turns) if (turn.role === 'user') turns.push(turn)
  if (mode === 'version') return { mode, turns, note: 'version-memory: 全部有效用户原话（按 seq，含更正）' }
  const recent = turns.slice(-6)
  const scored = turns
    .map((t) => ({ t, score: TERMS.reduce((n, term) => n + (t.text.includes(term) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.t.turnId.localeCompare(b.t.turnId))
    .slice(0, 3)
  const picked = [...new Map([...recent, ...scored.map((x) => x.t)].map((t) => [t.turnId, t])).values()]
  return { mode, turns: picked, note: 'text-memory: 近期6轮 + 词面BM25 top3（模拟检索，不是真实检索质量）' }
}

/** 从可见原话里读“承诺语义”。版本记忆能看到改口；文本记忆常常只看到零散一句。 */
export function readCommitment(memory) {
  const text = memory.turns.map((t) => t.text).join('\n')
  const corrected = /改口|只要主报告|不用等/.test(text)
  const retracted = /撤回/.test(text)
  const sources = corrected || retracted ? ['source:c1'] : ['source:c1', 'source:c2']
  const exitCodeOnly = !/都回来|都齐|两份/.test(text) && /退出码/.test(text)
  return { sources, corrected, retracted, exitCodeOnly, sawCommitment: /都回来|都齐|两份|只要主报告/.test(text) }
}

const factKey = (task, source) => `${task}/${source}`

export function makeState() {
  return { facts: new Map(), asked: new Set(), reminderCount: 0, openQuestion: false, decisions: [] }
}

export function applyEvent(state, event) {
  if (event.kind === 'result') {
    state.facts.set(factKey(event.taskId, event.sourceId), { present: true, revision: event.revision, failed: event.failed })
  } else if (event.kind === 'scan') {
    state.facts.set(factKey(event.taskId, 'scan'), { present: false, listingSha: event.listingSha })
  } else if (event.kind === 'duplicate') {
    // 重复事件：证据版本不变，不应产生新的介入
  }
}

const allPresent = (state, task, sources) => sources.every((s) => state.facts.get(factKey(task, s))?.present === true)
const anyPresent = (state, task, sources) => sources.some((s) => state.facts.get(factKey(task, s))?.present === true)
const evidenceKey = (state, task, sources) => `${task}:${sources.map((s) => `${s}=${state.facts.get(factKey(task, s))?.revision ?? 'none'}`).join(',')}`

/** 各臂在单个事件上的决策（纯函数，便于逐臂对照与重放）。 */
export function decide(arm, state, commitment, event, staticNeeds = commitment.sources) {
  const task = event.taskId
  if (task !== 'task:main') return { action: 'none', reason: 'other_task' }
  if (event.kind === 'duplicate') return { action: 'none', reason: 'duplicate_event' }
  if (event.kind === 'scan') return { action: 'wait', reason: 'no_result_yet' }
  if (event.kind === 'user_message') return { action: 'none', reason: 'no_new_evidence' }
  if (commitment.exitCodeOnly) return { action: 'none', reason: 'unsupported_requirement' }

  if (arm.policy === 'rule') {
    // 强规则：按任务声明的齐备条件（静态配置）判断；读不到“改口”这类语义更新
    const sources = staticNeeds
    if (!allPresent(state, task, sources)) return { action: 'wait', reason: 'waiting_declared_sources' }
    const key = evidenceKey(state, task, sources)
    if (state.asked.has(key)) return { action: 'none', reason: 'already_asked' }
    return { action: 'ask', reason: 'rule_declared_sources_met', key }
  }
  const sources = commitment.sources
  if (arm.policy === 'llm') {
    // 逐事件 LLM：离线 stub 与强规则同构（真实模型调用标 not_run）
    if (!allPresent(state, task, sources)) return { action: 'wait', reason: 'llm_wait' }
    const key = evidenceKey(state, task, sources)
    if (state.asked.has(key)) return { action: 'none', reason: 'already_asked' }
    return { action: 'ask', reason: 'llm_judged_ready', key }
  }
  // 条件 IR：when = all(来源齐备) 且无例外；证据不足 → unknown 不提问
  if (!allPresent(state, task, sources)) {
    const partial = anyPresent(state, task, sources)
    return { action: 'wait', reason: partial ? 'condition_unknown' : 'condition_false' }
  }
  const key = evidenceKey(state, task, sources)
  if (state.asked.has(key)) return { action: 'none', reason: 'asked_same_evidence' }
  return { action: 'ask', reason: 'condition_true', key }
}

export function runStory(story, arm) {
  const state = makeState()
  const staticNeeds = story.tasks.find((t) => t.id === 'task:main')?.needs ?? []
  const memory = readMemory(story, arm.memory, 0)
  const commitment = readCommitment(memory)
  const decisions = []
  story.events.forEach((event, index) => {
    applyEvent(state, event)
    const decision = decide(arm, state, commitment, event, staticNeeds)
    if (decision.action === 'ask' && decision.key) {
      if (state.openQuestion) { decision.action = 'none'; decision.reason = 'open_question_pending' }
      else if (state.asked.has(decision.key)) decision.action = 'none'
      else { state.asked.add(decision.key); state.openQuestion = true; state.reminderCount += 1 }
    }
    decisions.push({ index, event: `${event.kind}${event.sourceId ? `:${event.sourceId}` : ''}@${event.taskId}`, ...decision })
  })
  return {
    schema: 'pet-r6-condition-run/v1',
    mode: 'offline-replay',
    capabilityResult: false,
    arm: arm.id,
    armLabel: arm.label,
    story: story.id,
    split: story.split,
    memoryNote: memory.note,
    commitment,
    decisions,
    reminders: state.reminderCount,
    modelCalls: arm.policy === 'llm' ? story.events.length : 0,
    physicalPostAttempts: 0,
  }
}

/** evaluator-only 判据：与编译器无关，只看窗口/打扰/漏办。 */
export function scoreRun(run, story) {
  const expect = story.expectation
  const window = expect.requiredDecisionWindows[0]
  const requiredSource = window.afterEvent.replace(/^result:/, '')
  const askIndexes = run.decisions.filter((d) => d.action === 'ask').map((d) => d.index)
  const windowIndex = story.events.findIndex((e) => e.kind === 'result' && e.sourceId === requiredSource)
  const inWindow = askIndexes.some((i) => i >= windowIndex)
  const early = askIndexes.filter((i) => i < windowIndex).length
  const firstAsk = askIndexes[0]
  const late = inWindow && firstAsk !== undefined && firstAsk > windowIndex + 1 ? 1 : 0
  const duplicate = Math.max(0, askIndexes.length - (inWindow ? 1 : 0) - early)
  const missed = inWindow ? 0 : expect.requiredDecisionWindows.length
  return {
    story: story.id,
    arm: run.arm,
    required: expect.requiredDecisionWindows.length,
    missed,
    lateReminders: late,
    earlyReminders: early,
    duplicateReminders: duplicate,
    avoidableReminders: early + duplicate,
    reminders: run.reminders,
    withinMaxReminders: run.reminders <= expect.maxReminders,
    status: missed === 0 && early === 0 && duplicate === 0 ? 'ok' : missed > 0 ? 'missed' : 'over_notified',
  }
}

export function runAll(storyDir, outDir, options = {}) {
  const root = resolve(outDir)
  mkdirSync(join(root, 'raw'), { recursive: true })
  const split = options.split ?? null
  const arms = options.arms ?? ARMS.map((a) => a.id)
  const stories = readdirSync(storyDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(storyDir, f), 'utf8')))
    .filter((s) => s.schema === 'pet-r6-controlled-story/v1' && (!split || s.split === split))
    .sort((a, b) => a.id.localeCompare(b.id))
  const runs = []
  const scores = []
  for (const story of stories) {
    for (const armId of arms) {
      const arm = ARMS.find((a) => a.id === armId)
      if (!arm) throw new Error(`unknown arm: ${armId}`)
      const run = runStory(story, arm)
      writeFileSync(join(root, 'raw', `${armId}-${story.id}.json`), `${JSON.stringify(run, null, 2)}\n`)
      runs.push(run)
      // 判据只在评测侧使用，不进入运行时输入
      scores.push(scoreRun(run, story))
    }
  }
  const byArm = ARMS.filter((a) => arms.includes(a.id)).map((arm) => {
    const rows = scores.filter((s) => s.arm === arm.id)
    return {
      arm: arm.id,
      label: arm.label,
      stories: rows.length,
      missed: rows.reduce((n, r) => n + r.missed, 0),
      avoidableReminders: rows.reduce((n, r) => n + r.avoidableReminders, 0),
      earlyReminders: rows.reduce((n, r) => n + r.earlyReminders, 0),
      lateReminders: rows.reduce((n, r) => n + r.lateReminders, 0),
      duplicateReminders: rows.reduce((n, r) => n + r.duplicateReminders, 0),
      ok: rows.filter((r) => r.status === 'ok').length,
      wouldBeModelCalls: runs.filter((r) => r.arm === arm.id).reduce((n, r) => n + r.modelCalls, 0),
      physicalPostAttempts: 0,
    }
  })
  const summary = {
    schema: 'pet-r6-condition-summary/v1',
    mode: 'offline-replay',
    capabilityResult: false,
    generatedAt: new Date().toISOString(),
    split: split ?? 'all',
    stories: stories.length,
    runs: runs.length,
    byArm,
    perRun: scores,
    cost: {
      physicalPostAttempts: 0,
      success: 0,
      failed: 0,
      unknownUsage: null,
      inputTokens: null,
      outputTokens: null,
      sharedPreparationCost: null,
      coldStartChargedPerArm: [],
      note: '离线重放：没有真实模型调用，物理 POST/M 计为 0；真实五臂 72 跑未运行（无可用模型端点）',
    },
    verdict: 'not_a_capability_result',
    verdictReason: '离线重放用确定性 stub 代替 LLM 臂、用手写 fixture 代替编译输出；不能作为 H2 证据。真实 72 跑见 real-run 清单。',
  }
  writeFileSync(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  return summary
}
