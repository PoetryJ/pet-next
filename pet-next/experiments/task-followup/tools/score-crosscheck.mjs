/**
 * R4.2 独立评分交叉核对（不 import eval/score.ts，也不 import runner）。
 *
 * 输入：out/eval/raw 的 72 份 raw + gold + summary.json。
 * 输出：逐 run 的 required/produced/visible/answered 身份链，以及三个缺失量。
 *
 * 规则（与 eval/score.ts 文字口径一致，但实现独立）：
 * - 当前有效实例 = 未被撤销的 ask 中 (taskRevision, at, decisionId) 最大者；
 * - attention 只按 decisionId 精确连接；ticketId/taskRevision/assignmentId 必须相等；
 * - 0 条或 >1 条候选都 fail closed，不算已见；Answered 只在 Visible 内计数。
 *
 * 用法：
 *   node tools/score-crosscheck.mjs [rawDir] [goldDir] [summaryPath] [outputPath] [--external <result.json>]
 * 退出码：0 全部一致；5 有差异。
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const flags = new Set(process.argv.slice(2).filter((item) => item.startsWith('--')))
const args = process.argv.slice(2).filter((item) => !item.startsWith('--'))
const externalIndex = process.argv.indexOf('--external')
const externalPath = externalIndex >= 0 ? process.argv[externalIndex + 1] : null
const root = resolve(process.cwd())
const rawDir = resolve(args[0] ?? join(root, 'out/eval/raw'))
const goldDir = resolve(args[1] ?? join(root, 'gold'))
const summaryPath = resolve(args[2] ?? join(root, 'out/eval/scores/summary.json'))
const outputPath = resolve(args[3] ?? join(root, 'out/eval/scores/crosscheck.json'))

const gold = new Map()
for (const name of readdirSync(goldDir).filter((item) => item.endsWith('.json'))) {
  const file = JSON.parse(readFileSync(join(goldDir, name), 'utf8'))
  gold.set(file.trajectoryId, file.variants)
}

function instanceOf(raw, kind) {
  const asks = raw.asks.filter((item) => item.reasonCode === kind && item.outcome !== 'invalidated')
  if (!asks.length) return { status: 'not_proposed' }
  const ask = [...asks]
    .sort(
      (a, b) =>
        (a.taskRevision ?? 0) - (b.taskRevision ?? 0) ||
        a.at.localeCompare(b.at) ||
        String(a.decisionId ?? '').localeCompare(String(b.decisionId ?? '')),
    )
    .at(-1)
  if (!ask.decisionId) return { status: 'unmatched', reason: 'ask_identity_missing', ask }
  const candidates = raw.attentions.filter((item) => item.decisionId === ask.decisionId)
  if (candidates.length === 0) return { status: 'unmatched', reason: 'attention_missing', ask }
  if (candidates.length > 1) return { status: 'unmatched', reason: 'attention_ambiguous', ask }
  const attention = candidates[0]
  if (attention.taskRevision !== ask.taskRevision) return { status: 'unmatched', reason: 'revision_mismatch', ask, attention }
  if ((attention.ticketId ?? '') !== (ask.ticketId ?? '')) return { status: 'unmatched', reason: 'ticket_mismatch', ask, attention }
  if ((attention.assignmentId ?? '') !== (ask.assignmentId ?? '')) {
    return { status: 'unmatched', reason: 'assignment_mismatch', ask, attention }
  }
  if (!(attention.deliveredAt || attention.presentedAt)) {
    return { status: 'unmatched', reason: `not_visible:${attention.state}`, ask, attention }
  }
  return { status: 'matched', ask, attention, answered: attention.state === 'answered' }
}

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const diffs = []
const runs = []
for (const policy of ['P0', 'P1', 'P2', 'P3']) {
  let dir
  try {
    dir = readdirSync(join(rawDir, policy))
  } catch {
    continue
  }
  for (const name of dir.filter((item) => item.endsWith('.json')).sort()) {
    const raw = JSON.parse(readFileSync(join(rawDir, policy, name), 'utf8'))
    const variant = gold.get(raw.trajectoryId)?.[raw.variantId]
    if (!variant) {
      diffs.push(`${policy}/${name}: gold variant missing`)
      continue
    }
    const chain = variant.requiredDecisions.map((kind) => {
      const instance = instanceOf(raw, kind)
      return {
        kind,
        status: instance.status,
        reason: instance.reason ?? null,
        decisionId: instance.ask?.decisionId ?? null,
        taskRevision: instance.ask?.taskRevision ?? null,
        assignmentId: instance.ask?.assignmentId ?? null,
        ticketId: instance.ask?.ticketId ?? null,
        attentionId: instance.attention?.attentionId ?? null,
        deliveredAt: instance.attention?.deliveredAt ?? null,
        presentedAt: instance.attention?.presentedAt ?? null,
        state: instance.attention?.state ?? null,
      }
    })
    runs.push({ policy, run: `${raw.trajectoryId}-${raw.variantId}`, required: variant.requiredDecisions.length, chain })
  }
}

const recomputed = {}
for (const row of runs) {
  const bucket = (recomputed[row.policy] ??= { required: 0, produced: 0, visible: 0, answered: 0 })
  bucket.required += row.required
  for (const item of row.chain) {
    if (item.status === 'not_proposed') continue
    bucket.produced += 1
    if (item.status !== 'matched') continue
    bucket.visible += 1
    if (item.state === 'answered') bucket.answered += 1
  }
}
for (const [policy, bucket] of Object.entries(recomputed)) {
  bucket.notProposed = bucket.required - bucket.produced
  bucket.notVisible = bucket.required - bucket.visible
  bucket.notAnswered = bucket.required - bucket.answered
  const scored = summary.policies?.[policy]
  if (!scored) {
    diffs.push(`${policy}: summary missing policy`)
    continue
  }
  const summaryKeys = {
    required: 'requiredDecisions',
    produced: 'requiredProduced',
    visible: 'requiredVisible',
    answered: 'requiredAnswered',
    notProposed: 'notProposed',
    notVisible: 'notVisible',
    notAnswered: 'notAnswered',
  }
  for (const [key, summaryKey] of Object.entries(summaryKeys)) {
    if (bucket[key] !== scored[summaryKey]) diffs.push(`${policy}.${key}: ${bucket[key]} != ${scored[summaryKey]}`)
  }
}

let external = null
if (externalPath) {
  const file = JSON.parse(readFileSync(resolve(externalPath), 'utf8'))
  external = file
  for (const [policy, bucket] of Object.entries(recomputed)) {
    const other = file.policies?.[policy]
    if (!other) {
      diffs.push(`${policy}: external result missing policy`)
      continue
    }
    const pairs = [
      ['required', 'required'],
      ['produced', 'produced'],
      ['visible', 'visible'],
      ['answered', 'answered'],
      ['notProposed', 'unproduced'],
      ['notVisible', 'unreached'],
      ['notAnswered', 'unansweredRequired'],
    ]
    for (const [mine, theirs] of pairs) {
      if (bucket[mine] !== other[theirs]) diffs.push(`${policy}.${mine}: ${bucket[mine]} != external ${other[theirs]}`)
    }
  }
}

const report = {
  schema: 'pet-followup-crosscheck/v1',
  rawDir,
  summaryPath,
  external: externalPath ? { path: externalPath, checks: external?.checks ?? null, failed: external?.failed ?? null } : null,
  runs: runs.length,
  chains: runs,
  recomputed,
  diffs,
  ok: diffs.length === 0,
  generatedAt: new Date().toISOString(),
}
mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ ok: report.ok, runs: report.runs, diffs: report.diffs, recomputed }, null, 2)}\n`)
process.exit(report.ok ? 0 : 5)
