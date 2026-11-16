#!/usr/bin/env node
/**
 * 生成 12 条受控多会话长历史故事（6 类 × 开发/验证各一条）。
 *
 * 诚实标注：这是脚本生成的“受控多会话长历史”，不是数周真实使用记录。
 * 每条 8 会话 × 12 轮 = 96 个有内容 turn、3 个任务；关键承诺放在第 1 会话，
 * 更正放在第 5 会话（都在短期窗口之外），干扰任务有实际内容。
 *
 * 用法：node gen-stories.mjs --out <目录>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const FAMILIES = [
  { id: 'reports-ready', label: '多份报告齐备', needs: ['source:c1', 'source:c2'], ruleHint: 'two_reports' },
  { id: 'combo-exception', label: '组合条件与例外', needs: ['source:c1', 'source:c2'], ruleHint: 'exception' },
  { id: 'deadline-window', label: '截止与可用窗口', needs: ['source:c1'], ruleHint: 'deadline' },
  { id: 'retract-correct', label: '来源撤回与改口', needs: ['source:c1'], ruleHint: 'correction' },
  { id: 'old-answer-new-auth', label: '旧回答与新授权', needs: ['source:c1'], ruleHint: 'old_answer' },
  { id: 'multi-task-isolation', label: '多任务隔离', needs: ['source:c1', 'source:c2'], ruleHint: 'isolation' },
]
const SPLITS = ['dev', 'verify']

const filler = [
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
]

function turnsFor(family, split, index) {
  const tag = `${family.id}-${split}`
  const sessions = []
  const base = Date.parse('2026-09-01T01:00:00.000Z') + index * 86400000
  for (let s = 0; s < 8; s += 1) {
    const at = new Date(base + s * 3600_000).toISOString()
    const turns = []
    for (let t = 0; t < 12; t += 1) {
      const n = s * 12 + t
      const role = t % 3 === 2 ? 'assistant' : 'user'
      let text = filler[(n + index) % filler.length]
      let taskIds = ['task:main']
      // 会话 1：关键承诺（短期窗口外）
      if (s === 0 && t === 1) {
        text = family.id === 'combo-exception'
          ? '两份检查报告都回来再问我；除非我在出差，那就不用打断。'
          : '两份检查报告都回来以后再问我，别提前打扰。'
        taskIds = ['task:main']
      }
      // 会话 3：干扰任务的实际内容
      if (s === 2 && t === 4) {
        text = '旁路任务 task:side 的构建也要盯着，但那个等的是另一份报告。'
        taskIds = ['task:side']
      }
      // 会话 5：更正（短期窗口外）
      if (s === 4 && t === 2) {
        text = family.id === 'retract-correct'
          ? '改口：只要主报告回来就问我，第二份报告不用等了。'
          : family.id === 'old-answer-new-auth'
            ? '上次那个回答作废，重新按新授权处理。'
            : '再补充一句：报告要有退出码，缺了不算齐。'
        taskIds = ['task:main']
      }
      // 会话 7：撤回/取消（部分故事）
      if (s === 6 && t === 3 && family.id === 'retract-correct') {
        text = '先撤回刚才那句，还是等两份都齐。'
        taskIds = ['task:main']
      }
      turns.push({ turnId: `${tag}-s${s}-t${t}`, role, text, taskIds })
    }
    sessions.push({ sessionId: `${tag}-s${s}`, at, turns })
  }
  return sessions
}

export function buildStory(family, split, index) {
  const tag = `${family.id}-${split}`
  const sessions = turnsFor(family, split, index)
  const events = [
    { at: sessions[0].at, kind: 'user_message', taskId: 'task:main', turnId: `${tag}-s0-t1` },
    { at: sessions[2].at, kind: 'user_message', taskId: 'task:side', turnId: `${tag}-s2-t4` },
    { at: sessions[3].at, kind: 'scan', taskId: 'task:main', present: false, listingSha: `listing-${tag}` },
    { at: sessions[4].at, kind: 'user_message', taskId: 'task:main', turnId: `${tag}-s4-t2` },
    { at: sessions[5].at, kind: 'result', taskId: 'task:main', sourceId: 'source:c1', revision: 1, failed: 0 },
    { at: sessions[5].at, kind: 'duplicate', taskId: 'task:main', sourceId: 'source:c1', revision: 1, failed: 0 },
    { at: sessions[5].at, kind: 'result', taskId: 'task:side', sourceId: 'source:c9', revision: 1, failed: 0 },
    { at: sessions[6].at, kind: 'result', taskId: 'task:main', sourceId: 'source:c2', revision: 1, failed: 0 },
    { at: sessions[7].at, kind: 'result', taskId: 'task:main', sourceId: 'source:c1', revision: 2, failed: 1 },
  ]
  // 期望窗口（evaluator-only）：按“改口后的实际需要”决定，不是全局固定两条来源
  // 改口/新授权把“两份”收窄成“一份”，其余族仍按原承诺的两份
  const windowSource = family.id === 'retract-correct' || family.id === 'old-answer-new-auth'
    ? 'source:c1'
    : 'source:c2'
  const expectedTurnId = windowSource === 'source:c1' ? `${tag}-s5-t0` : `${tag}-s6-t0`
  return {
    schema: 'pet-r6-controlled-story/v1',
    id: tag,
    split,
    family: family.id,
    familyLabel: family.label,
    label: `受控多会话长历史 ${tag}`,
    sessions,
    turnCount: sessions.reduce((n, s) => n + s.turns.length, 0),
    tasks: [
      { id: 'task:main', label: '主检查任务', needs: family.needs },
      { id: 'task:side', label: '旁路构建', needs: ['source:c9'] },
      { id: 'task:distract', label: '磁盘清理', needs: [] },
    ],
    events,
    rules: {
      ruleHint: family.ruleHint,
      commitmentTurnId: `${tag}-s0-t1`,
      correctionTurnId: `${tag}-s4-t2`,
      requiredSources: family.needs,
    },
    expectation: {
      schema: 'pet-r6-story-expectation/v1',
      requiredDecisionWindows: [{ taskId: 'task:main', afterEvent: `result:${windowSource}`, turnId: expectedTurnId }],
      forbiddenReminderWindows: [{ taskId: 'task:main', beforeEvent: `result:${windowSource}` }],
      maxReminders: 1,
      notes: '判据独立于编译器：只看是否在窗口内介入、是否提前/重复打扰、是否漏办。',
    },
  }
}

export function generate(outDir) {
  const root = resolve(outDir)
  mkdirSync(root, { recursive: true })
  const written = []
  let index = 0
  for (const split of SPLITS) {
    for (const family of FAMILIES) {
      const story = buildStory(family, split, index)
      const path = join(root, `${story.id}.json`)
      writeFileSync(path, `${JSON.stringify(story, null, 2)}\n`)
      written.push(path)
      index += 1
    }
  }
  return written
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname
if (invokedDirectly) {
  const i = process.argv.indexOf('--out')
  if (i < 0) {
    console.error('usage: node gen-stories.mjs --out <dir>')
    process.exit(2)
  }
  console.log(JSON.stringify(generate(process.argv[i + 1]), null, 2))
}
