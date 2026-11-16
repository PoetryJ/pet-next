/**
 * E 臂自测：条件面板只翻宿主给出的结论与原话，不自己编解释；旧模式布局不变。
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { conditionCardHtml, conditionView } from '../demo/condition-view.mjs'

const HASH = 'c'.repeat(64)
const summary = (over: Record<string, unknown> = {}) => ({
  available: true,
  state: 'true' as const,
  action: 'ask',
  why: ['条件已满足'],
  satisfied: ['task:task:R6.result.present'],
  waiting: [],
  unknown: [],
  quotes: [{ turnId: 'u1', text: '两份检查报告都回来以后再问我' }],
  at: '2026-11-16T02:00:00.000Z',
  dev: { compilationKey: HASH, evidenceKey: 'e'.repeat(64), compilerSha256: 'f'.repeat(64), planRevision: 2 },
  ...over,
})

test('没有 conditionSummary 时完全不渲染，旧模式布局不变', () => {
  assert.equal(conditionView(null), null)
  assert.equal(conditionCardHtml(undefined), '')
  assert.equal(conditionCardHtml({ available: false }), '')
})

test('满足并提问：状态标签与“现在需要你选择”来自宿主 state/action', () => {
  const view = conditionView(summary())
  assert.ok(view)
  assert.equal(view!.label, '条件已满足')
  assert.equal(view!.showQuestion, true)
  const html = conditionCardHtml(summary())
  assert.match(html, /条件跟进（实验）· 条件已满足/)
  assert.match(html, /现在需要你选择/)
  assert.match(html, /data-action="ask"/)
})

test('未满足/缺证据：只显示宿主给出的字段与原因，不生成解释', () => {
  const waiting = conditionCardHtml(summary({ state: 'false', action: 'wait', why: ['条件还不满足'], satisfied: [], waiting: ['task:task:R6.result.failed'], unknown: [] }))
  assert.match(waiting, /条件还不满足/)
  assert.match(waiting, /task:task:R6\.result\.failed/)
  assert.doesNotMatch(waiting, /现在需要你选择/)

  const unknown = conditionCardHtml(summary({ state: 'unknown', action: 'wait', why: ['缺证据'], satisfied: [], waiting: [], unknown: ['user.availability（missing）'] }))
  assert.match(unknown, /还在等证据/)
  assert.match(unknown, /user\.availability（missing）/)
  assert.doesNotMatch(unknown, /现在需要你选择/)
})

test('用户原话逐字展示且转义；hash 只在开发区', () => {
  const html = conditionCardHtml(summary({ quotes: [{ turnId: 'u1', text: '两份报告都回来 <再> 问我' }] }))
  const [main] = html.split('<details class="dev">')
  assert.ok(main!.includes('「两份报告都回来 &lt;再&gt; 问我」'))
  assert.ok(!main!.includes(HASH), '主区域不能出现编译 hash')
  assert.ok(html.includes('<details class="dev">'))
  assert.ok(html.includes(HASH))
})

test('视图字段与宿主摘要一一对应，不新增条目', () => {
  const view = conditionView(summary())!
  assert.deepEqual(view.why, ['条件已满足'])
  assert.deepEqual(view.satisfied, ['task:task:R6.result.present'])
  assert.deepEqual(view.waiting, [])
  assert.deepEqual(view.unknown, [])
  assert.deepEqual(view.quotes, ['两份检查报告都回来以后再问我'])
  assert.equal(view.dev!.planRevision, 2)
})
