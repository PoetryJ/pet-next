#!/usr/bin/env node
/**
 * 冻结矩阵计划：12 故事 × 5 臂 = 60，heldout 的 V-L/V-C 各再重复 1 次 → 72。
 * 输出 plan 后应提交，任何后续修改都会改变 SHA（coverage 会不一致）。
 *
 * 用法：node build-plan.mjs --stories <dir> --out <matrix-plan.json>
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const arg = (name) => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1] }
if (!arg('stories') || !arg('out')) { console.error('usage: --stories <dir> --out <plan.json>'); process.exit(2) }
const dir = resolve(arg('stories'))
const stories = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .sort((a, b) => a.id.localeCompare(b.id))
const ARMS = ['V-R', 'V-L', 'V-C', 'T-L', 'T-C']
const cases = stories.map((s) => ({ id: s.id, split: s.split, storySha: createHash('sha256').update(readFileSync(join(dir, `${s.id}.json`))).digest('hex') }))
const runs = []
for (const story of stories) {
  for (const arm of ARMS) runs.push({ id: `${story.id}-${arm}-r1`, caseId: story.id, arm, repeat: 1 })
}
for (const story of stories.filter((s) => s.split === 'heldout')) {
  for (const arm of ['V-L', 'V-C']) runs.push({ id: `${story.id}-${arm}-r2`, caseId: story.id, arm, repeat: 2 })
}
const plan = {
  schema: 'pet-r6-matrix-plan/v1',
  createdAt: new Date().toISOString(),
  note: '冻结后不得修改；plan SHA 与 coverage.planSha 必须一致。',
  cases,
  runs,
}
const bytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, 'utf8')
writeFileSync(resolve(arg('out')), bytes)
console.log(JSON.stringify({ cases: cases.length, runs: runs.length, sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2))
