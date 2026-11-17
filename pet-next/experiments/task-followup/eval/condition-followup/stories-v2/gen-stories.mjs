#!/usr/bin/env node
/**
 * R6-comparison 冻结故事生成器（B）。
 *
 * 12 条故事：6 dev + 6 heldout，每条 96 轮有意义历史（3 个任务：A 主、B 依赖、C 干扰），
 * 关键承诺在第 1 段历史、跨任务更正在后段、报告乱序/重启/取消按族不同。
 *
 * 历史轮次由宿主之外的准备脚本写入 SQLite（cap_turns），当轮 3–4 轮走真实 /api/say；
 * 因此每 run 的模型调用只覆盖“当轮 + 首次抽取/摘要”，不是把 96 轮都当在线对话。
 * 这是数据准备，不是测量：所有请求仍由真实模型完成，逐 run 有 model-io 证据。
 *
 * 输出：<out>/<storyId>.json + <out>/index.json（含每条 story 的 SHA256）
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const FAMILIES = [
  { id: 'two-reports', label: '两份都到齐再问', correction: null, order: 'B,A', restart: false, cancel: false },
  { id: 'narrow-correction', label: '改口只等主报告', correction: '更正：B 的报告只当参考，不用等它；主报告回来就问我', order: 'B,A', restart: false, cancel: false },
  { id: 'out-of-order', label: '报告乱序先到并重复保存', correction: null, order: 'B,A', restart: false, cancel: false, duplicate: true },
  { id: 'cross-task-correction', label: '跨任务更正（在 C 的对话里改 A 的等待条件）', correction: '顺带更正一下：A 那个任务不要等 C 的任何东西，只等它自己的两份报告', order: 'B,A', restart: false, cancel: false, crossTask: true },
  { id: 'restart-missing-source', label: '缺一份时宿主重启', correction: null, order: 'B,A', restart: true, cancel: false },
  { id: 'cancel-distractor', label: '取消干扰任务后不再打扰', correction: null, order: 'B,A', restart: false, cancel: true },
]

const FILLER = [
  '先把上周的样本清单再核一遍，别丢条目。',
  '这个任务的日志我放在共享盘，按日期分目录。',
  '昨天那版脚本跑得比前版快一点，但结果还没对。',
  '我在另一个任务里也在等构建，别把两边数字混在一起。',
  '如果有报错先把原始栈留下，不要只看摘要。',
  '提醒我下午看一眼磁盘占用，别又满了。',
  '中文路径那个检查上次漏了，这次要带上空格目录。',
  '助理先去把缓存清一下，别占用实验机。',
  '这次先只跑主流程，附加实验等主流程稳定。',
  '报告里保留命令和退出码，方便回头复现。',
  '这个结论先别急着写进周报，等第二轮复现。',
  '两份材料要分开存，别混在同一个目录里。',
]

const sha = (text) => createHash('sha256').update(text).digest('hex')

function buildStory(family, split, index) {
  const id = `${family.id}-${split}`
  const turns = []
  const at = (n) => new Date(Date.UTC(2026, 8, 1 + index, 1 + Math.floor(n / 12), (n % 12) * 4)).toISOString()
  const push = (target, text) => turns.push({ target, text, at: at(turns.length) })

  // 第 1 段：主任务承诺
  push('A', '这个主测试任务，两份检查报告都回来以后再问我是否继续，不要提前打断。')
  for (let i = 0; i < 20; i += 1) push(i % 4 === 0 ? 'C' : 'A', FILLER[(i + index) % FILLER.length])

  // 第 2 段：依赖任务的日常
  for (let i = 0; i < 20; i += 1) push(i % 5 === 0 ? 'C' : 'B', FILLER[(i + index + 3) % FILLER.length])

  // 第 3 段：干扰任务与跨任务噪音
  for (let i = 0; i < 20; i += 1) push(i % 3 === 0 ? 'A' : 'C', FILLER[(i + index + 7) % FILLER.length])

  // 第 4 段：中途补充（非更正）
  push('A', '补充一句：报告里要有退出码，缺了不算齐。')
  for (let i = 0; i < 24; i += 1) push(i % 4 === 1 ? 'B' : 'A', FILLER[(i + index + 5) % FILLER.length])

  // 第 5 段：更正（如有）与最后准备
  if (family.correction) {
    push(family.crossTask ? 'C' : 'A', family.correction)
  } else {
    push('A', '还是按原来说的办，两份齐了再问我。')
  }
  for (let i = 0; i < 9; i += 1) push(i % 2 === 0 ? 'B' : 'C', FILLER[(i + index + 9) % FILLER.length])

  const story = {
    schema: 'pet-r6-story/v2',
    id,
    split,
    family: family.id,
    label: `${family.label}（${split}）`,
    tasks: [
      { key: 'A', title: '主测试', dir: 'inbox/A', goal: '跟进主测试报告；按用户承诺决定何时需要用户确认', analysisWhen: 'always', bindings: [{ alias: 'B 报告', key: 'B' }] },
      { key: 'B', title: '依赖检查', dir: 'inbox/B', goal: '接收依赖检查报告' },
      { key: 'C', title: '干扰构建', dir: 'inbox/C', goal: '接收干扰构建报告' },
    ],
    turns,
    turnCount: turns.length,
    // 当轮真实 /api/say 的原话（历史已预置，避免把 96 轮全走在线抽取）
    live: {
      order: family.order,
      restart: family.restart,
      cancel: family.cancel,
      duplicate: Boolean(family.duplicate),
      livesays: [
        { target: 'A', text: `现在开始跑：主测试和依赖检查都要出结果，按之前说的办。` },
        ...(family.correction ? [{ target: family.crossTask ? 'C' : 'A', text: family.correction }] : []),
      ],
    },
    expectation: {
      schema: 'pet-r6-story-expectation/v1',
      primaryKey: 'A',
      needSources: family.correction && !family.crossTask ? ['A'] : ['A', 'B'],
      askOnlyAfterAllSources: true,
      maxReminders: 1,
      mustVerifyAnalysis: true,
      cancelledKey: family.cancel ? 'C' : null,
      notes: '判据只看：是否在来源齐备后问、是否提前/重复打扰、是否有核验分析、取消后是否还有问题。',
    },
  }
  return { ...story, sha256: sha(JSON.stringify({ ...story })) }
}

export function generate(outDir) {
  const root = resolve(outDir)
  mkdirSync(root, { recursive: true })
  const index = []
  let n = 0
  for (const split of ['dev', 'heldout']) {
    for (const family of FAMILIES) {
      const story = buildStory(family, split, n)
      writeFileSync(join(root, `${story.id}.json`), `${JSON.stringify(story, null, 2)}\n`)
      index.push({ id: story.id, split, family: family.id, file: `${story.id}.json`, sha256: story.sha256, turnCount: story.turnCount })
      n += 1
    }
  }
  writeFileSync(join(root, 'index.json'), `${JSON.stringify({ schema: 'pet-r6-story-index/v1', at: new Date().toISOString(), stories: index }, null, 2)}\n`)
  return index
}

const invoked = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname
if (invoked) {
  const i = process.argv.indexOf('--out')
  if (i < 0) { console.error('usage: node gen-stories.mjs --out <dir>'); process.exit(2) }
  const index = generate(process.argv[i + 1])
  console.log(JSON.stringify({ stories: index.length, turns: index.map((s) => s.turnCount) }, null, 2))
}
