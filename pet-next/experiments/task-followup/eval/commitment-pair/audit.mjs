#!/usr/bin/env node
/**
 * R7 交付审计：冻结输入、语义网格、旧 S1 九格、用量对账、原始文件完整性。
 *
 * 只读运行目录；不修改任何证据。任何一项失败都写进 audit.json 并以非零退出。
 *
 * 用法：
 *   node eval/commitment-pair/audit.mjs --runs <dir1,dir2> --s1 <S1 run dir> --out <json>
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ARMS, PROMISES, TRAJECTORIES, storyFor } from './stories.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const roots = (arg('runs', '') ?? '').split(',').map((s) => resolve(s.trim())).filter(Boolean)
const s1 = arg('s1') ? resolve(arg('s1')) : null
const outPath = resolve(arg('out', join(roots[0] ?? '.', 'audit.json')))
mkdirSync(dirname(outPath), { recursive: true })
const readJson = (p, f = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : f)
const checks = []
const add = (name, ok, detail = null) => checks.push({ name, ok: Boolean(ok), ...(detail !== null ? { detail } : {}) })
const NODE = process.execPath

const runs = []
for (const root of roots) {
  const listed = readJson(join(root, 'runs.json'), { rows: [] }).rows ?? []
  for (const row of listed) runs.push({ ...row, root, dir: join(root, `${row.trajectory}-${row.promise}-${row.arm}`) })
}
add('runs.count', runs.length === 18, { n: runs.length })
add('runs.unique', new Set(runs.map((r) => `${r.trajectory}-${r.promise}-${r.arm}`)).size === runs.length)
for (const arm of Object.keys(ARMS)) add(`runs.arm.${arm}`, runs.filter((r) => r.arm === arm).length === 6, { n: runs.filter((r) => r.arm === arm).length })
for (const trajectory of Object.keys(TRAJECTORIES).filter((id) => id !== 'D1')) {
  add(`runs.trajectory.${trajectory}`, runs.filter((r) => r.trajectory === trajectory).length === 6)
}
for (const promise of Object.keys(PROMISES)) add(`runs.promise.${promise}`, runs.filter((r) => r.promise === promise).length === 9)

const raw = []
for (const run of runs) {
  const id = `${run.trajectory}-${run.promise}-${run.arm}`
  const data = readJson(join(run.dir, 'raw.json'))
  if (!data) { add(`raw.${id}`, false, 'missing raw.json'); continue }
  raw.push({ run, data })
  const has = (p) => existsSync(join(run.dir, p))
  add(`files.${id}`, has('raw.json') && has('db/copy.sqlite') && has('client-ledger.jsonl') && has('proxy-ledger.jsonl') && has('model-io'))
  add(`promise.${id}`, data.promiseText === PROMISES[run.promise].text, { promise: data.promiseText })
  add(`arm.${id}`, data.adapter === ARMS[run.arm].adapter, { adapter: data.adapter })
  const historyOk = Array.isArray(data.timeline) && data.timeline.some((t) => t.kind === 'history.intake')
  add(`timeline.${id}`, historyOk)
}

// 同一轨迹只改第一条承诺：尾部聊天、任务名、绑定完全相同。
for (const trajectory of Object.keys(TRAJECTORIES).filter((id) => id !== 'D1')) {
  const p = storyFor(trajectory, 'P')
  const o = storyFor(trajectory, 'O')
  const sameLength = p.history.length === 96 && o.history.length === 96
  const tailSame = sameLength && p.history.slice(1).every((turn, i) => turn.text === o.history[i + 1].text && turn.target === o.history[i + 1].target)
  const firstDiff = p.history[0].text !== o.history[0].text
  add(`freeze.${trajectory}`, sameLength && tailSame && firstDiff && p.bindings.join() === o.bindings.join(), {
    sameLength, tailSame, firstDiff, bindings: p.bindings,
  })
}

// 期望不进入模型：所有模型请求里不出现 evaluator-only 判据键。
const leaks = []
for (const { run } of raw) {
  const dir = join(run.dir, 'model-io')
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.request.json'))) {
    const text = readFileSync(join(dir, file), 'utf8')
    for (const marker of ['askedAfter', 'quietBefore', 'correctedDropsB', '"expectation"']) {
      if (text.includes(marker)) leaks.push(`${run.trajectory}-${run.promise}-${run.arm}/${file}:${marker}`)
    }
  }
}
add('expectation.not_in_model', leaks.length === 0, leaks.slice(0, 10))

// 语义网格：T1 的两条相反承诺都要能区分 4 种组合 + 单边缺报；负控必须检出。
const semantic = []
for (const promise of ['P', 'O']) {
  const run = raw.find(({ run }) => run.trajectory === 'T1' && run.promise === promise && run.arm === 'V-C')
  if (!run) { add(`semantic.${promise}`, false, 'missing T1-V-C run'); continue }
  const out = join(run.run.dir, 'semantic-grid.json')
  try {
    execFileSync(NODE, ['--experimental-transform-types', '--no-warnings', 'eval/commitment-pair/check-grid.mjs', '--run', run.run.dir, '--negative', '--out', out], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' })
    const report = readJson(out)
    semantic.push({ promise, ...report })
    add(`semantic.${promise}.grid`, report.ok === true, { cases: report.cases?.length ?? null, oneSided: report.oneSided?.length ?? null })
    add(`semantic.${promise}.negative`, report.negative?.detected === true, report.negative)
    add(`semantic.${promise}.citation`, report.citation?.quoted === true, report.citation)
  } catch (error) {
    add(`semantic.${promise}`, false, String(error?.message ?? error).slice(0, 500))
  }
}

// 旧 S1 九格保留：仍对上一轮真实计划做同样的 9 种到达状态检查。
if (s1) {
  const db = join(s1, 'ws/state/followup.sqlite')
  if (existsSync(db)) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      const handle = new DatabaseSync(db, { readOnly: true })
      const ticket = handle.prepare("SELECT ticket_id FROM tasks WHERE title = '主测试'").get()?.ticket_id
      handle.close()
      const stdout = execFileSync(NODE, ['--experimental-transform-types', '--no-warnings', 'eval/condition-followup/usable/check-all-arrived.mjs', db, ticket], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' })
      const report = JSON.parse(stdout)
      add('s1.nine-grid', report.ok === true, { ticket, cases: report.cases })
    } catch (error) {
      add('s1.nine-grid', false, String(error?.message ?? error).slice(0, 500))
    }
  } else add('s1.nine-grid', false, 'S1 database missing')
} else add('s1.nine-grid', false, 'no --s1 provided')

// 用量对账。
const reconcile = readJson(arg('reconcile') ? resolve(arg('reconcile')) : join(roots[0] ?? '.', 'reconcile', 'reconcile.json'))
if (reconcile) {
  const t = reconcile.totals
  add('usage.client-balanced', t.clientStarts === t.clientEnds, { starts: t.clientStarts, ends: t.clientEnds })
  add('usage.proxy-balanced', t.proxyStarts === t.proxyEnds || (t.proxyStarts > t.proxyEnds && reconcile.missing?.proxyUnfinished?.length === t.proxyStarts - t.proxyEnds), { starts: t.proxyStarts, ends: t.proxyEnds, unfinished: t.proxyUnfinished, listed: reconcile.missing?.proxyUnfinished?.length })
  const unfinished = new Set((reconcile.missing?.proxyUnfinished ?? []).map((x) => x.id))
  const clientOnlyUnfinished = (reconcile.missing?.clientOnly ?? []).every((x) => unfinished.has(x.id))
  add('usage.ids-matched', t.proxyOnly === 0 && (t.clientOnly === 0 || clientOnlyUnfinished), { clientOnly: t.clientOnly, proxyOnly: t.proxyOnly, clientOnlyUnfinished })
  add('usage.global-unique', t.uniqueRequestIds === t.proxyStarts - (t.duplicateStarts ?? 0), { unique: t.uniqueRequestIds, starts: t.proxyStarts, duplicateStarts: t.duplicateStarts ?? 0, retried: t.retried ?? [] })
  add('usage.unknown-listed', Array.isArray(reconcile.missing?.unknownUsage), { unknown: t.unknownUsage })
} else add('usage.reconcile', false, 'reconcile.json missing')

// 真实工作区与通知表：每次 run 都有主/旁支记录。
for (const { run, data } of raw) {
  const dump = readJson(join(run.dir, 'db', 'dump.json'), {})
  const tasks = dump.tasks ?? []
  const primary = tasks.find((t) => t.title === '主测试')
  add(`workspace.${run.trajectory}-${run.promise}-${run.arm}`, Boolean(primary) && Array.isArray(dump.attentions) && Array.isArray(dump.notifications), {
    tasks: tasks.map((t) => t.title), attentions: (dump.attentions ?? []).length, notifications: (dump.notifications ?? []).length,
    sideAttentions: data.checks?.sideAttentions ?? null, sideNotifications: data.checks?.sideNotifications ?? null,
  })
}

const ok = checks.every((c) => c.ok)
const report = {
  schema: 'pet-r7-audit/v1',
  at: new Date().toISOString(),
  roots,
  s1,
  runs: runs.map((r) => `${r.trajectory}-${r.promise}-${r.arm}`),
  checks,
  semantic,
  ok,
}
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ok, failed: checks.filter((c) => !c.ok).map((c) => c.name), checks: checks.length, out: outPath }, null, 2))
process.exitCode = ok ? 0 : 1
