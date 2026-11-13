/** Decision-frame projection tests only; no model or capability conclusion. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decisionFrame } from '../intervention/decision-frame.ts'
import { buildAssessRequest, type AssessSnapshot } from '../intervention/assess.ts'
import type { EvidenceRef, MemoryPacket, PacketItem } from '../memory/types.ts'

const NOW = '2026-11-13T10:00:00.000Z'
const snapshot = (): AssessSnapshot => ({ taskId: 'task:any', title: '持续委托', goal: '根据当前证据决定下一步', taskRevision: 3, assignmentId: 'run-current-r2', status: 'active', stage: 'result_received', now: NOW,
  latestResult: { sourceId: 'inbox/current-result', revision: 2, status: 'partial', summary: '当前修订仍有三项失败，后续动作待用户选择。', assignment: 'run-current-r2', artifact: 'current-artifact.json' },
  options: [{ optionId: 'analyze_failing', label: '生成失败分析' }, { optionId: 'keep_waiting', label: '继续等待' }],
})
const packet = (): MemoryPacket => ({ schema: 'pet-capability-memory-packet/v1', taskId: 'task:any', asOf: NOW, evaluatedAt: NOW, intent: 'current', memoryCursor: 10, currentFacts: [], preferences: [], commitments: [], outcomes: [], evidenceRefs: [], missing: [], conflicts: [], context: { nonActionable: [], recentTurns: [], slotResolution: [], budgetUsed: { items: 0, chars: 0 }, truncated: false, diagnostics: [] } })
const item = (id: string, key: string, value: string, patch: Partial<PacketItem> = {}): PacketItem => ({ itemId: id, key, value, kind: 'fact', statement: value, scope: { level: 'task', id: 'task:any' }, validFrom: '2026-11-13T09:00:00Z', validUntil: null, status: 'active', authority: 'user', confidence: 1, evidenceTurnIds: [`source-${id}`], supersedes: [], supersededBy: [], ...patch })
const turn = (seq: number, role: EvidenceRef['role'], quote: string): EvidenceRef => ({ turnId: `turn-${seq}`, sessionId: `session-${seq}`, seq, at: `2026-11-13T09:${String(seq).padStart(2, '0')}:00Z`, role, taskIds: ['task:any'], quote, start: 0, end: quote.length })

test('过去ETA、当前时刻、未来截止由真实ISO时区运算，旧/假设/无效时间不复活', () => {
  const p = packet()
  const inputs = [
    item('eta-past', 'expectedUpdateAt', '2026-11-13T17:59:15+08:00'),
    item('eta-now', 'expectedUpdateAt', NOW),
    item('deadline', 'decisionDeadline', '2026-11-13T10:05:00Z'),
    item('old', 'expectedUpdateAt', '2026-11-14T10:00:00Z', { status: 'superseded' }),
    item('hypothesis', 'expectedUpdateAt', '2026-11-14T10:00:00Z', { status: 'hypothetical' }),
    item('malformed', 'decisionDeadline', 'when convenient'),
  ]
  const result = decisionFrame(snapshot(), { ...p, currentFacts: inputs })
  assert.deepEqual(result.timeFacts.map((x) => [x.itemId, x.relationToNow, x.secondsFromNow]), [
    ['eta-past', 'past', -45], ['eta-now', 'now', 0], ['deadline', 'future', 300],
  ])
  assert.equal(result.timeFacts[0]!.at, '2026-11-13T17:59:15+08:00', '保留原证据时刻，不把过期ETA续期')
  assert.deepEqual(result.timeFacts[0]!.sourceTurnIds, ['source-eta-past'])
  assert.equal(inputs[3]!.status, 'superseded')
})

test('当前结果只能原样来自宿主snapshot；观察时间取当前有效outcome，不从过去ETA推断完成', () => {
  const s = snapshot(), p = packet()
  const outcomes = [
    item('r-old', 'resultObserved', 'old-r1', { kind: 'outcome', authority: 'tool', status: 'superseded', validFrom: '2026-11-13T09:59:50Z' }),
    item('r-current', 'resultObserved', 'current-r2', { kind: 'outcome', authority: 'tool', validFrom: '2026-11-13T09:59:00Z' }),
    item('different-receipt', 'analysisArtifact', 'some-path', { kind: 'outcome', authority: 'tool', validFrom: '2026-11-13T09:59:59Z' }),
  ]
  const frame = decisionFrame(s, { ...p, outcomes, currentFacts: [item('eta', 'expectedUpdateAt', '2026-11-13T09:30:00Z')] })
  assert.deepEqual(frame.currentVerifiedResult, s.latestResult)
  assert.equal(frame.currentVerifiedResult!.status, 'partial')
  assert.equal(frame.currentResultObservedAt, '2026-11-13T09:59:00Z')
  assert.equal(frame.timeFacts[0]!.relationToNow, 'past')
  assert.equal('completed' in frame, false)
  const empty = decisionFrame({ ...s, latestResult: null }, p)
  assert.equal(empty.currentVerifiedResult, null)
  assert.equal(empty.currentResultObservedAt, null)
})

test('最近用户原话按持久seq倒序呈现，仅取三条；助手和工具不能冒充用户更新', () => {
  const p = packet()
  const raw = [turn(4, 'user', '第四条更正'), turn(9, 'assistant', '助手建议'), turn(1, 'user', '最早约定'), turn(8, 'tool', '工具结果'), turn(7, 'user', '我现在有空'), turn(6, 'user', '第三条条件')]
  const before = JSON.stringify(raw)
  const frame = decisionFrame(snapshot(), { ...p, context: { ...p.context, recentTurns: raw } })
  assert.deepEqual(frame.uncompiledUserUpdates.map((t) => t.turnId), ['turn-7', 'turn-6', 'turn-4'])
  assert.deepEqual(frame.uncompiledUserUpdates.map((t) => t.text), ['我现在有空', '第三条条件', '第四条更正'])
  assert.equal(JSON.stringify(raw), before, '排序不能原地改写共享记忆包')
})

test('frame为事实投影，不附动作标签；改变候选选项/任务名称不会偷偷预选答案', () => {
  const s = snapshot(), p = packet()
  const frame = decisionFrame(s, p)
  assert.deepEqual(Object.keys(frame).sort(), ['currentTime', 'currentVerifiedResult', 'currentResultObservedAt', 'timeFacts', 'uncompiledUserUpdates', 'note'].sort())
  assert.deepEqual(decisionFrame({ ...s, title: '任意改名', options: [{ optionId: 'new-option', label: '另一个选择' }] }, p), frame)
  const before = JSON.stringify({ s, p })
  const request = buildAssessRequest(s, p)
  const modelInput = JSON.parse(request.messages[1]!.content)
  assert.deepEqual(modelInput.decisionFrame, frame)
  assert.deepEqual(modelInput.snapshot.options, s.options, '可选动作仍由原快照提供，frame不删改菜单')
  assert.deepEqual(modelInput.memory.currentFacts, p.currentFacts)
  assert.equal(JSON.stringify({ s, p }), before)
})
