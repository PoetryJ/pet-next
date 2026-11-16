#!/usr/bin/env node
/**
 * R6-D 入口：生成/复用 12 条故事，跑五臂离线重放，写 summary.json 与逐 run 原始文件。
 *
 * 用法：
 *   node eval/condition-followup/run.mjs --out out/condition-followup [--split dev|verify] [--regenerate]
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generate } from './gen-stories.mjs'
import { runAll, ARMS } from './harness.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}

const out = resolve(value('out', 'out/condition-followup'))
const storyDir = join(out, 'stories')
mkdirSync(out, { recursive: true })
if (flag('regenerate') || !existsSync(storyDir) || readdirSync(storyDir).length === 0) generate(storyDir)

const summary = runAll(storyDir, out, { split: value('split', null) })
const pad = (v, n) => String(v).padEnd(n)
console.log(`${pad('arm', 6)}${pad('stories', 9)}${pad('missed', 8)}${pad('avoidable', 11)}${pad('ok', 4)}${pad('llmCalls(stub)', 15)}physicalPOST`)
for (const row of summary.byArm) {
  console.log(`${pad(row.arm, 6)}${pad(row.stories, 9)}${pad(row.missed, 8)}${pad(row.avoidableReminders, 11)}${pad(row.ok, 4)}${pad(row.wouldBeModelCalls, 15)}${row.physicalPostAttempts}`)
}
console.log(`\nmode=${summary.mode} capabilityResult=${summary.capabilityResult} verdict=${summary.verdict}`)
console.log(`summary: ${join(out, 'summary.json')}`)
console.log(`arms: ${ARMS.map((a) => a.id).join(', ')}`)
