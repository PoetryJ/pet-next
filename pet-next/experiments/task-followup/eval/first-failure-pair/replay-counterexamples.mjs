#!/usr/bin/env node
/** 先复现包里的三个反例，再让 live 跑。只读评审包；不修改原树。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluate } from '../../capability/conditions/kernel.ts'
import { defaultFactDeclarations } from '../../capability/conditions/plan-types.ts'
import { validateDirection } from '../../capability/conditions/compiler.ts'
import { falseBranchAction } from '../../service/capability-conditions.ts'

const root = process.argv[2] ?? '/data/home/user_00/pet-r7-codex-review-20261120/next'
const read = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'))
const sha = (text) => text
const out = {}

const first = read('design/first-failure.json')
const facts = defaultFactDeclarations(['4bd5a234c420ebba469aaed95a07fd21', 'f41b88d17cb4a9789a11c574df80a5b5'])
const a = '4bd5a234c420ebba469aaed95a07fd21'
const b = 'f41b88d17cb4a9789a11c574df80a5b5'
const binding = (id) => ({ sourceId: `result:${id}`, version: '1', sha256: 'a'.repeat(64) })
const ctx = {
  now: '2026-11-20T09:00:00.000Z',
  allowedFacts: facts.map((f) => f.id),
  facts: {
    [`task:${a}.result.present`]: { value: true, binding: binding(a), observedAt: '2026-11-20T08:59:00.000Z' },
    [`task:${a}.result.status`]: { value: 'failed', binding: binding(a), observedAt: '2026-11-20T08:59:00.000Z' },
  },
  currentBindings: { [`result:${a}`]: binding(a), [`result:${b}`]: binding(b) },
}
const firstEval = evaluate(first.when, ctx)
out.firstFailure = {
  recorded: { task: first.afterFirstFailure.task, open: first.afterFirstFailure.open, notifications: first.afterFirstFailure.notifications, guards: first.afterFirstFailure.guards },
  replay: { state: firstEval.state, reads: firstEval.reads },
}

const watch = read('design/watch-vs-archive.json')
out.watchVsArchive = watch.cases.map((c) => ({
  id: c.id,
  quoted: c.quoted,
  recorded: c.actual,
  now: falseBranchAction({ follow: { mode: c.id === 'watch' ? 'next_round' : 'end', quotes: [], defaulted: false } }),
  want: c.want,
}))

const guard = read('attribution/guard-replay.json')
const correction = '更正：B 那份报告失败也不用问我，只有 A 失败才需要来问我。'
out.guardReplay = guard.map((g) => ({
  source: g.source,
  recordedStatus: g.status,
  problems: validateDirection(g.when, correction),
}))

const allRejected = out.guardReplay.every((g) => g.problems.length > 0)
const watchOk = out.watchVsArchive.find((c) => c.id === 'watch')?.now === 'wait'
const archiveOk = out.watchVsArchive.find((c) => c.id === 'close')?.now === 'archive'
const firstTrue = out.firstFailure.replay.state === 'true'
console.log(JSON.stringify({ ...out, verdict: { allRejected, watchOk, archiveOk, firstTrue } }, null, 2))
process.exit(allRejected && watchOk && archiveOk && firstTrue ? 0 : 1)
