#!/usr/bin/env node
/**
 * R7 现场演示：同一份 CI 输入、同一任务/绑定/尾部聊天，只换一条早期承诺。
 *
 *   --replay <P run dir>,<O run dir>   直接读真实 run 的数据库与时间线（秒级）
 *   --live --out <新目录> [--arm V-C]  现场重跑两份都成功的配对（各约 5 分钟）
 *
 * 演示只陈述真实记录：谁在什么时候提问/归档/回答、旁支送达几条、产物是否核验。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runOne } from './run-pair.mjs'
import { ARMS, storyFor } from './stories.mjs'

const args = process.argv.slice(2)
const arg = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1] }
const flag = (name) => args.includes(`--${name}`)
const readJson = (p, f = null) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : f)

function summarize(dir) {
  const raw = readJson(join(dir, 'raw.json'))
  if (!raw) throw Error(`missing raw.json: ${dir}`)
  const dump = readJson(join(dir, 'db', 'dump.json'), {})
  const tasks = dump.tasks ?? []
  const primary = tasks.find((t) => t.title === '主测试')
  const completion = primary?.completion_json ? JSON.parse(primary.completion_json) : null
  const attentions = (dump.attentions ?? []).filter((a) => a.ticket_id === primary?.ticket_id)
  const side = (dump.notifications ?? []).filter((n) => n.ticket_id !== primary?.ticket_id)
  const events = raw.timeline ?? []
  return {
    id: `${raw.promise}-${raw.trajectory}`,
    promise: raw.promise,
    promiseText: raw.promiseText,
    arm: raw.arm,
    action: raw.checks?.action ?? null,
    status: primary?.status ?? raw.checks?.finalStatus ?? null,
    archive: completion?.mode === 'quiet_archive',
    analysis: raw.checks?.analysisValid === true,
    asked: attentions.length > 0,
    question: attentions[0]?.question ?? null,
    answered: attentions.some((a) => a.state === 'answered'),
    mainNotifications: (dump.notifications ?? []).filter((n) => n.ticket_id === primary?.ticket_id).length,
    sideDelivered: side.filter((n) => n.state === 'delivered' || n.state === 'presented').length,
    posts: raw.cost?.clientPosts ?? null,
    tokens: raw.cost?.clientTokens ?? null,
    events: events.filter((e) => ['produce', 'action', 'answer', 'terminal', 'check.quiet'].includes(e.kind)).map((e) => `${e.kind}${e.key ? `:${e.key}` : ''}${e.status ? `(${e.status})` : ''}`),
  }
}

function printPair(p, o) {
  const row = (label, a, b) => console.log(`${label.padEnd(18)} ${String(a).padEnd(34)} ${b}`)
  console.log('\n=== R7 承诺配对演示（同一输入，只换第一条承诺）===')
  row('承诺', p.promiseText.slice(0, 32) + '…', o.promiseText.slice(0, 32) + '…')
  row('臂', p.arm, o.arm)
  row('主任务动作', p.action ?? '-', o.action ?? '-')
  row('主任务状态', p.status ?? '-', o.status ?? '-')
  row('静默归档', p.archive ? '是' : '否', o.archive ? '是' : '否')
  row('提问/回答', `${p.asked ? '是' : '否'}/${p.answered ? '是' : '否'}`, `${o.asked ? '是' : '否'}/${o.answered ? '是' : '否'}`)
  row('有效分析', p.analysis ? '是（核验通过）' : '否', o.analysis ? '是（核验通过）' : '否')
  row('旁支送达提醒', String(p.sideDelivered), String(o.sideDelivered))
  row('模型调用/token', `${p.posts}/${p.tokens}`, `${o.posts}/${o.tokens}`)
  console.log('\n关键时间线：')
  row('  失败才问', p.events.join(' → '), '')
  row('  成功才问', o.events.join(' → '), '')
  if (p.action === 'ask' && o.action === 'archive') {
    console.log('\n结论：同一份“B 失败”的 CI 输入；“失败才问”在最后一份到达后提问并经核验分析，“成功才问”安静归档。')
  } else if (p.archive && o.asked) {
    console.log('\n结论：同一份“两份都成功”的 CI 输入；“失败才问”安静归档，“成功才问”在最后一份到达后提问并通过核验。')
  } else {
    console.log(`\n本次记录：P=${p.action ?? '-'}，O=${o.action ?? '-'}；后续处理见上方时间线。`)
  }
}

if (flag('live')) {
  const out = resolve(arg('out'))
  const arm = arg('arm', 'V-C')
  if (!ARMS[arm]) throw Error(`unknown arm ${arm}`)
  if (existsSync(out) && readJson(join(out, 'P-D1', 'raw.json'))) throw Error(`live demo output already exists: ${out}`)
  const port = Number(arg('base-port', '19400'))
  const p = await runOne({ trajectory: 'D1', promise: 'P', arm, outDir: join(out, 'P-D1'), port })
  const o = await runOne({ trajectory: 'D1', promise: 'O', arm, outDir: join(out, 'O-D1'), port: port + 1 })
  printPair(summarize(join(out, 'P-D1')), summarize(join(out, 'O-D1')))
  console.log(`\n原始记录：${out}/P-D1 与 ${out}/O-D1`)
} else {
  const dirs = (arg('replay', '') ?? '').split(',').map((s) => resolve(s.trim())).filter(Boolean)
  if (dirs.length !== 2) throw Error('usage: --replay <P run dir>,<O run dir> | --live --out <new dir>')
  printPair(summarize(dirs[0]), summarize(dirs[1]))
  console.log(`\n原始记录：${dirs[0]} 与 ${dirs[1]}`)
}
