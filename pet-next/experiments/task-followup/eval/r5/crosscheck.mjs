/**
 * R5 独立重算（不 import eval/r5/score.ts）：从 raw + gold 的窗口直接算
 * produced/visible/answered/actionOk/missed/pending/overdue，并与 summary.json 逐项比对。
 *
 * 用法：node eval/r5/crosscheck.mjs [rawDir] [goldDir] [summaryPath]
 * 退出码：0 一致；5 有差异。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2).filter((item) => !item.startsWith('--'))
const root = resolve(process.cwd())
const rawDir = resolve(args[0] ?? join(root, 'out', 'r5', 'raw'))
const goldDir = resolve(args[1] ?? join(root, 'gold', 'r5'))
const summaryPath = resolve(args[2] ?? join(root, 'out', 'r5', 'scores', 'summary.json'))

const gold = new Map()
for (const name of readdirSync(goldDir).filter((item) => item.endsWith('.json'))) {
  const doc = JSON.parse(readFileSync(join(goldDir, name), 'utf8'))
  gold.set(doc.trajectoryId, doc)
}

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0
const positiveInt = (value) => typeof value === 'number' && Number.isInteger(value) && value > 0

function currentAsk(raw, kind) {
  const rows = raw.asks.filter((item) => item.reasonCode === kind && item.outcome !== 'invalidated')
  if (!rows.length) return null
  return rows.sort((a, b) => (a.taskRevision ?? 0) - (b.taskRevision ?? 0) || a.at.localeCompare(b.at)).at(-1)
}

const perRun = []
for (const policy of readdirSync(rawDir).sort()) {
  for (const name of readdirSync(join(rawDir, policy)).filter((item) => item.endsWith('.json')).sort()) {
    const raw = JSON.parse(readFileSync(join(rawDir, policy, name), 'utf8'))
    const g = gold.get(raw.trajectoryId)
    if (!g) throw new Error(`gold missing ${raw.trajectoryId}`)
    const rows = g.required.map((requirement) => {
      const ask = currentAsk(raw, requirement.kind)
      if (!ask || !nonEmpty(ask.decisionId) || !nonEmpty(ask.ticketId) || !positiveInt(ask.taskRevision) || !nonEmpty(ask.assignmentId)) {
        return { kind: requirement.kind, produced: Boolean(ask), visible: false, answered: false, actionOk: false, overdue: false, pending: false, missed: true }
      }
      const linked = raw.attentions.filter((item) => item.decisionId === ask.decisionId)
      if (linked.length !== 1) {
        return { kind: requirement.kind, produced: true, visible: false, answered: false, actionOk: false, overdue: false, pending: false, missed: true }
      }
      const attention = linked[0]
      if (attention.taskRevision !== ask.taskRevision || attention.ticketId !== ask.ticketId || attention.assignmentId !== ask.assignmentId) {
        return { kind: requirement.kind, produced: true, visible: false, answered: false, actionOk: false, overdue: false, pending: false, missed: true }
      }
      const seen = attention.deliveredAt ?? attention.presentedAt
      const visible = Boolean(seen) && Date.parse(seen) >= Date.parse(requirement.earliest) && Date.parse(seen) <= Date.parse(requirement.latest)
      const overdue = Boolean(seen) && Date.parse(seen) > Date.parse(requirement.latest)
      const pending = !seen && Date.parse(raw.finalClock) < Date.parse(requirement.latest)
      const answered = visible && attention.state === 'answered'
      return {
        kind: requirement.kind,
        produced: true,
        visible,
        answered,
        actionOk: answered && attention.answerOption === requirement.action,
        overdue,
        pending,
        missed: !visible && !pending && !overdue,
      }
    })
    perRun.push({
      policy,
      run: `${raw.trajectoryId}`,
      requirements: rows,
      produced: rows.filter((row) => row.produced).length,
      visible: rows.filter((row) => row.visible).length,
      answered: rows.filter((row) => row.answered).length,
      actionOk: rows.filter((row) => row.actionOk).length,
      missed: rows.filter((row) => row.missed).length,
      pending: rows.filter((row) => row.pending).length,
      overdue: rows.filter((row) => row.overdue).length,
    })
  }
}

const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const diffs = []
for (const policy of Object.keys(summary.policies ?? {})) {
  const runs = perRun.filter((row) => row.policy === policy)
  const totals = {
    produced: runs.reduce((sum, row) => sum + row.produced, 0),
    visible: runs.reduce((sum, row) => sum + row.visible, 0),
    answered: runs.reduce((sum, row) => sum + row.answered, 0),
    actionOk: runs.reduce((sum, row) => sum + row.actionOk, 0),
    missed: runs.reduce((sum, row) => sum + row.missed, 0),
    pending: runs.reduce((sum, row) => sum + row.pending, 0),
    overdue: runs.reduce((sum, row) => sum + row.overdue, 0),
  }
  for (const [key, value] of Object.entries(totals)) {
    const scored = key === 'actionOk' ? summary.policies[policy].actionOk : summary.policies[policy][key]
    if (value !== scored) diffs.push(`${policy}.${key}: ${value} != ${scored}`)
  }
}

const report = { ok: diffs.length === 0, runs: perRun.length, diffs, perRun }
writeFileSync(summaryPath.replace(/summary\.json$/, 'crosscheck.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ok: report.ok, runs: report.runs, diffs }, null, 2))
process.exit(report.ok ? 0 : 5)
