/**
 * 矩阵汇总（B）：只读 raw/verification/coverage 与冻结故事，不读策略内部状态、不改 gold。
 *
 * 主指标：有效完成（core verify 通过）、必要决定漏报、无用打扰（提前/重复）、
 * 真实 token/延迟/重试/兜底代价。先逐故事配对，再汇总；C/V 不得用“少请求/少来源”换成本优势。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const readJson = (path, fallback = null) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback)
export const ARMS = ['V-R', 'V-L', 'V-C', 'T-L', 'T-C']

function runMetrics(outRoot, coverageRow, story) {
  const raw = readJson(join(outRoot, coverageRow.rawPath))
  if (!raw) return null
  const dir = join(outRoot, coverageRow.rawPath, '..')
  const verification = readJson(join(dir, 'verification.json'))
  const dump = readJson(join(dir, 'db', 'dump.json'), {})
  const attentions = (dump.attentions ?? []).filter((a) => a.ticket_id === (dump.tasks ?? []).find((t) => t.title === story.tasks.find((x) => x.key === 'A')?.title)?.ticket_id)
  const produced = raw.timeline.filter((t) => t.kind === 'produce')
  const needed = story.expectation.needSources
  const lastNeeded = produced.filter((p) => needed.includes(p.key)).map((p) => p.at).sort().at(-1) ?? produced.map((p) => p.at).sort().at(-1)
  const firstAsk = attentions.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0] ?? null
  const early = Boolean(firstAsk && lastNeeded && Date.parse(firstAsk.created_at) < Date.parse(lastNeeded) - 2000)
  const asked = Boolean(firstAsk)
  const duplicates = Math.max(0, attentions.length - 1)
  const valid = Boolean(verification?.ok)
  const cancelOk = story.live.cancel ? raw.checks?.cancelNoQuestion !== false : true
  return {
    ok: Boolean(asked && !early && duplicates === 0 && valid && cancelOk && raw.checks?.answered),
    asked, early, duplicates, validCompletion: valid, cancelOk,
    answered: Boolean(raw.checks?.answered),
    error: raw.checks?.error ?? null,
    posts: raw.cost?.physicalPosts ?? 0,
    failedPosts: raw.cost?.failedPosts ?? 0,
    retries: raw.cost?.retries ?? 0,
    prompt: raw.cost?.promptTokens ?? 0,
    completion: raw.cost?.completionTokens ?? 0,
    latencyAvg: raw.cost?.latencyMs?.avg ?? null,
    startedAt: raw.startedAt, finishedAt: raw.finishedAt,
    verificationFailures: verification?.failures ?? [],
  }
}

const ratio = (n, d) => (d > 0 ? Number((n / d).toFixed(4)) : null)

export function compare({ outRoot, plan, stories }) {
  const coverage = readJson(join(outRoot, 'coverage.json'), { runs: [] })
  const byId = new Map(coverage.runs.map((r) => [r.id, r]))
  const rows = []
  for (const row of plan.runs) {
    const story = stories.get(row.caseId)
    const measured = byId.get(row.id)
    if (!story || !measured) { rows.push({ id: row.id, caseId: row.caseId, arm: row.arm, repeat: row.repeat, missing: true }); continue }
    const metrics = runMetrics(outRoot, measured, story)
    rows.push({ id: row.id, caseId: row.caseId, arm: row.arm, repeat: row.repeat, split: story.split, rawPath: measured.rawPath, ...(metrics ?? { missing: true }) })
  }

  const perCase = {}
  for (const row of rows) {
    if (row.missing) continue
    perCase[row.caseId] ??= { caseId: row.caseId, split: row.split, arms: {} }
    perCase[row.caseId].arms[row.arm] ??= []
    perCase[row.caseId].arms[row.arm].push({ repeat: row.repeat, ok: row.ok, validCompletion: row.validCompletion, early: row.early, duplicates: row.duplicates, missed: !row.asked, posts: row.posts, prompt: row.prompt, completion: row.completion, retries: row.retries, latencyAvg: row.latencyAvg })
  }

  const byArm = {}
  for (const arm of ARMS) {
    const list = rows.filter((r) => r.arm === arm && !r.missing)
    const runs = list.length
    const valid = list.filter((r) => r.validCompletion).length
    const ok = list.filter((r) => r.ok).length
    byArm[arm] = {
      runs,
      ok,
      okRate: ratio(ok, runs),
      validCompletion: valid,
      validCompletionRate: ratio(valid, runs),
      missed: list.filter((r) => !r.asked).length,
      early: list.filter((r) => r.early).length,
      duplicateRuns: list.filter((r) => r.duplicates > 0).length,
      answered: list.filter((r) => r.answered).length,
      promptTokens: list.reduce((n, r) => n + r.prompt, 0),
      completionTokens: list.reduce((n, r) => n + r.completion, 0),
      posts: list.reduce((n, r) => n + r.posts, 0),
      failedPosts: list.reduce((n, r) => n + r.failedPosts, 0),
      retries: list.reduce((n, r) => n + r.retries, 0),
      latencyAvg: list.map((r) => r.latencyAvg).filter((x) => Number.isFinite(x)).reduce((a, b, _, arr) => a + b / arr.length, 0) || null,
      tokensPerValidCompletion: valid > 0 ? Math.round((list.reduce((n, r) => n + r.prompt + r.completion, 0)) / valid) : null,
      postsPerValidCompletion: valid > 0 ? Number((list.reduce((n, r) => n + r.posts, 0) / valid).toFixed(2)) : null,
    }
  }

  // 键覆盖率：同一故事里 C/V 引用的来源数必须一致（不得用“少来源”换成本）
  const sourceCounts = {}
  for (const row of rows) {
    if (row.missing) continue
    const raw = readJson(join(outRoot, row.rawPath))
    const dump = readJson(join(outRoot, row.rawPath, '..', 'db', 'dump.json'), {})
    const task = (dump.tasks ?? []).find((t) => t.title === stories.get(row.caseId).tasks.find((x) => x.key === 'A').title)
    const proof = task?.analysis_json ? null : null
    sourceCounts[row.caseId] ??= {}
    sourceCounts[row.caseId][row.arm] = (task?.bindings_json ? JSON.parse(task.bindings_json).length : 0) + 1
    void raw; void proof
  }
  const sourceParityViolations = []
  for (const [caseId, arms] of Object.entries(sourceCounts)) {
    const values = Object.values(arms)
    if (values.length > 1 && new Set(values).size > 1) sourceParityViolations.push({ caseId, arms })
  }

  const comparison = {
    schema: 'pet-r6-comparison/v1',
    at: new Date().toISOString(),
    planSha: coverage.planSha,
    runsPlanned: plan.runs.length,
    runsMeasured: rows.filter((r) => !r.missing).length,
    byArm,
    perCase: Object.values(perCase),
    perRun: rows,
    sourceParityViolations,
    notes: [
      '有效完成只认 core-completion/verify.mjs；状态 completed 不算。',
      '早提醒=首个问题早于最后必需来源到达；重复=同一 run 多于 1 个问题。',
      'token/POST 来自每次真实请求（含失败与语法重试），见各 run model-io。',
    ],
  }

  const costLedger = {
    schema: 'pet-r6-cost-ledger/v1',
    at: new Date().toISOString(),
    planSha: coverage.planSha,
    totals: {
      runs: rows.filter((r) => !r.missing).length,
      physicalPosts: rows.filter((r) => !r.missing).reduce((n, r) => n + r.posts, 0),
      failedPosts: rows.filter((r) => !r.missing).reduce((n, r) => n + r.failedPosts, 0),
      retries: rows.filter((r) => !r.missing).reduce((n, r) => n + r.retries, 0),
      promptTokens: rows.filter((r) => !r.missing).reduce((n, r) => n + r.prompt, 0),
      completionTokens: rows.filter((r) => !r.missing).reduce((n, r) => n + r.completion, 0),
    },
    byArm: Object.fromEntries(Object.entries(byArm).map(([arm, v]) => [arm, { posts: v.posts, failedPosts: v.failedPosts, retries: v.retries, promptTokens: v.promptTokens, completionTokens: v.completionTokens, okRate: v.okRate, validCompletionRate: v.validCompletionRate, tokensPerValidCompletion: v.tokensPerValidCompletion }])),
    perRun: rows.map((r) => ({
      id: r.id, arm: r.arm, caseId: r.caseId, repeat: r.repeat, missing: Boolean(r.missing),
      posts: r.posts ?? null, failedPosts: r.failedPosts ?? null, retries: r.retries ?? null,
      prompt: r.prompt ?? null, completion: r.completion ?? null, latencyAvg: r.latencyAvg ?? null,
      ok: r.ok ?? null, validCompletion: r.validCompletion ?? null,
    })),
  }
  return { comparison, costLedger }
}
