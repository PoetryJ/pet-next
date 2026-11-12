/**
 * R5 报告：把 12 条故事逐条摊开，允许 NeedRule 不赢。
 *
 * @module pet-next/experiments/task-followup/eval/r5/report
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { R5Summary } from './score.ts'

const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${a}/${b} (${((a / b) * 100).toFixed(1)}%)`)

export function renderR5Report(summary: R5Summary, outPath: string): string {
  const lines: string[] = []
  lines.push('# R5 12 故事：P3 vs NeedRule(N1)')
  lines.push('')
  lines.push(`生成时间：${summary.generatedAt}`)
  lines.push('')
  lines.push('固定分母：12 条故事 × 2 策略 = 24 runs；必完成 10 条；必要决策 9 项。')
  lines.push('')
  lines.push('| 策略 | 有效完成 | 必需问题(产生/可见/回答/行动正确) | 漏提案 | 未触达(已过期) | censored | 通知 | 重复 | 过期通知 | 取消后 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of summary.table) {
    lines.push(
      `| ${row.policy} | ${pct(row.validCompletions, row.mustCompleteSatisfied)} | ${row.produced}/${row.visible}/${row.answered}/${row.actionOk} (共 ${row.required}) | ${row.missed} | ${row.overdue} | ${row.pending} | ${row.notifications} | ${row.duplicateNotifications} | ${row.staleNotifications} | ${row.notificationsAfterCancel} |`,
    )
  }
  lines.push('')
  lines.push('说明：pending 是 censored（故事结束时尚未到最迟时刻），不算成功也不算漏办；')
  lines.push('未回复不是“无用提醒”的证据；本轮没有人工阅读或真实用户评价。')
  lines.push('')
  lines.push('## 逐条结果')
  lines.push('')
  lines.push('| 故事 | 族 | 划分 | 策略 | 有效完成 | 必需问题 | 通知 | wake(fired/stale) |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const run of summary.runs) {
    const req = run.requirements.map((item) => `${item.kind}:${item.reason}`).join(', ') || '—'
    lines.push(
      `| ${run.trajectoryId} | ${run.family} | ${run.split} | ${run.policy} | ${run.validCompletion ? 'yes' : 'no'} | ${req} | ${run.notifications} | ${run.wakeFired}/${run.wakeStale} |`,
    )
  }
  lines.push('')
  const n1 = summary.policies.N1
  const p3 = summary.policies.P3
  if (n1 && p3) {
    const delta = {
      visible: n1.visible - p3.visible,
      answered: n1.answered - p3.answered,
      notifications: n1.notifications - p3.notifications,
      missed: n1.missed - p3.missed,
    }
    lines.push('## 结论（只报计数）')
    lines.push('')
    lines.push(
      `N1 相对 P3：可见 ${delta.visible >= 0 ? '+' : ''}${delta.visible}、回答 ${delta.answered >= 0 ? '+' : ''}${delta.answered}、通知 ${delta.notifications >= 0 ? '+' : ''}${delta.notifications}、漏提案 ${delta.missed >= 0 ? '+' : ''}${delta.missed}。`,
    )
    lines.push('')
    lines.push(
      delta.visible <= 0 && delta.answered <= 0 && delta.notifications >= 0
        ? '本组冻结故事**不支持** NeedRule 更少打扰或更高触达；两份规则在这些故事上完成与触达相同，N1 没有可报告的收益。'
        : '差值只描述这 12 条冻结故事，不上升为研究结论。',
    )
  }
  lines.push('')
  lines.push('## 不能声称')
  lines.push('')
  lines.push('- 没有模型、真实用户、远程任务或真实通知；delivery 仍是本地模拟通道。')
  lines.push('- 没有 12 小时稳定性；实时演示只跑了秒级序列（见交付 r5-demo 日志）。')
  lines.push('- pending/censored 不等于“将来会成功”。')
  const text = `${lines.join('\n')}\n`
  writeFileSync(outPath, text)
  return text
}

export function r5ReportPath(root: string): string {
  return join(root, 'out', 'r5', 'REPORT.md')
}
