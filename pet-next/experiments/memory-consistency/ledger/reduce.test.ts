/**
 * A1 纯账本测试：身份、幂等、生命周期、未知值。
 * 这些断言只描述契约语义，不引用任何产品文案。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { requestKey, sessionKey, type MemoryEvent } from '../contracts.ts';
import {
  acknowledged,
  generated,
  event,
  presented,
  requestCancelled,
  requestFailed,
  sessionReset,
  statement,
  taskChanged,
  toolResult,
} from '../testing/factory.ts';
import { reduce, stepEvent } from './reduce.ts';
import { emptyState } from '../contracts.ts';

function fold(events: readonly MemoryEvent[]) {
  return reduce(events);
}

describe('reduce 身份与幂等', () => {
  test('同 eventId 同载荷重复到达不生效', () => {
    const first = statement(1, 'e1', '我喜欢简短回答。', 'pref:style');
    const result = fold([first, { ...first, sequence: 2 }]);
    assert.equal(result.state.events.length, 1);
    assert.equal(result.state.globalVersion, 1);
    assert.equal(result.state.subjectVersions['pref:style'], 1);
    assert.deepEqual(result.rejectedEvents, []);
  });

  test('同 eventId 不同载荷必须显式冲突且不覆盖', () => {
    const first = statement(1, 'e1', '我喜欢简短回答。', 'pref:style');
    const second = statement(2, 'e1', '我喜欢详细回答。', 'pref:style');
    const result = fold([first, second]);
    assert.equal(result.state.events.length, 1);
    assert.equal(result.state.conflicts.length, 1);
    assert.equal(result.rejectedEvents[0]?.reason, 'event_id_conflict');
    assert.equal(result.state.events[0]?.payload.text, '我喜欢简短回答。');
  });

  test('同 requestId 跨 epoch 是两个身份', () => {
    const events = [
      generated(1, 'e1', 'req-1', 'resp-1'),
      sessionReset(2, 'e2', 1),
      generated(3, 'e3', 'req-1', 'resp-2', '好的。', ),
      { ...generated(4, 'e4', 'req-1', 'resp-2'), sessionEpoch: 2 },
    ];
    const state = reduce(events).state;
    const epoch1 = state.requests[requestKey('sess-1', 1, 'req-1')];
    const epoch2 = state.requests[requestKey('sess-1', 2, 'req-1')];
    assert.ok(epoch1);
    assert.ok(epoch2);
    assert.equal(epoch1.generated, true);
    assert.equal(epoch1.responseIds.length, 1);
    assert.equal(epoch2.responseIds.length, 1);
    assert.notEqual(epoch1.requestKey, epoch2.requestKey);
  });

  test('乱序到达按 sequence 回放', () => {
    const ordered = [
      generated(1, 'e1', 'req-1', 'resp-1'),
      presented(2, 'e2', 'req-1', 'resp-1'),
      acknowledged(3, 'e3', 'req-1', 'resp-1'),
    ];
    const shuffled = [ordered[2], ordered[0], ordered[1]] as MemoryEvent[];
    const a = fold(ordered).state;
    const b = fold(shuffled).state;
    assert.equal(a.globalVersion, b.globalVersion);
    assert.equal(a.lastSequence, b.lastSequence);
    assert.equal(a.events.length, b.events.length);
    assert.equal(a.requests['sess-1#1#req-1']?.acknowledged, true);
  });
});

describe('reduce 生命周期独立性', () => {
  test('生成不等于呈现，也不等于已读', () => {
    const state = fold([generated(1, 'e1', 'req-1', 'resp-1')]).state;
    const view = state.requests['sess-1#1#req-1'];
    assert.equal(view?.generated, true);
    assert.equal(view?.presented, false);
    assert.equal(view?.acknowledged, false);
  });

  test('呈现不等于已读', () => {
    const state = fold([
      generated(1, 'e1', 'req-1', 'resp-1'),
      presented(2, 'e2', 'req-1', 'resp-1', 'ui'),
    ]).state;
    const view = state.requests['sess-1#1#req-1'];
    assert.equal(view?.presented, true);
    assert.equal(view?.acknowledged, false);
  });

  test('呈现通道 unknown 不升级为已知', () => {
    const state = fold([presented(1, 'e1', 'req-1', 'resp-1', 'unknown')]).state;
    assert.equal(state.requests['sess-1#1#req-1']?.presented, true);
  });

  test('确认不证明工具成功', () => {
    const state = fold([
      generated(1, 'e1', 'req-1', 'resp-1'),
      acknowledged(2, 'e2', 'req-1', 'resp-1'),
    ]).state;
    const view = state.requests['sess-1#1#req-1'];
    assert.equal(view?.acknowledged, true);
    assert.equal(view?.toolOutcome, 'none');
  });

  test('单次请求取消不撤销任务', () => {
    const events = [
      statement(1, 'e1', '帮我整理周报。', 'task:weekly-report'),
      taskChanged(2, 'e2', 'weekly-report', 1, 'created'),
      generated(3, 'e3', 'req-1', 'resp-1'),
      requestCancelled(4, 'e4', 'req-1'),
    ];
    const state = fold(events).state;
    assert.equal(state.requests['sess-1#1#req-1']?.cancelled, true);
    const task = state.tasks['sess-1::weekly-report'];
    assert.equal(task?.change, 'created');
    assert.equal(task?.authority, 'explicit');
  });

  test('会话重置不撤销长期偏好', () => {
    const state = fold([
      statement(1, 'e1', '以后都用中文。', 'pref:language'),
      taskChanged(2, 'e2', 'weekly-report', 1, 'created'),
      sessionReset(3, 'e3', 1),
    ]).state;
    assert.equal(state.sessions[sessionKey('sess-1', 1)]?.closed, true);
    assert.equal(state.subjectVersions['pref:language'], 1);
    assert.equal(state.tasks['sess-1::weekly-report']?.change, 'created');
  });

  test('请求失败保留原因，不影响任务', () => {
    const state = fold([requestFailed(1, 'e1', 'req-1', 'provider_timeout')]).state;
    assert.equal(state.requests['sess-1#1#req-1']?.failed, true);
    assert.equal(state.requests['sess-1#1#req-1']?.failReason, 'provider_timeout');
  });
});

describe('reduce 任务与未知值', () => {
  test('旧 revision 不能覆盖新 revision', () => {
    const result = fold([
      taskChanged(1, 'e1', 't1', 2, 'revised'),
      taskChanged(2, 'e2', 't1', 1, 'cancelled'),
    ]);
    assert.equal(result.state.tasks['sess-1::t1']?.revision, 2);
    assert.equal(result.state.tasks['sess-1::t1']?.change, 'revised');
    assert.equal(result.rejectedEvents[0]?.reason, 'stale_task_revision:1<=2');
  });

  test('自然语言候选不能变成权威撤销', () => {
    const result = fold([
      taskChanged(1, 'e1', 't1', 1, 'created'),
      taskChanged(2, 'e2', 't1', 2, 'cancelled', 'scripted-candidate'),
    ]);
    const task = result.state.tasks['sess-1::t1'];
    assert.equal(task?.change, 'created');
    assert.equal(task?.revision, 1);
    assert.equal(task?.candidates.length, 1);
    assert.equal(task?.candidates[0]?.change, 'cancelled');
  });

  test('工具结果未知保持未知', () => {
    const state = fold([toolResult(1, 'e1', 'req-1', 'unknown', 'shell')]).state;
    assert.equal(state.requests['sess-1#1#req-1']?.toolOutcome, 'unknown');
  });

  test('同一请求的工具结算不能翻转', () => {
    const result = fold([
      toolResult(1, 'e1', 'req-1', 'ok', 'shell'),
      toolResult(2, 'e2', 'req-1', 'error', 'shell'),
    ]);
    assert.equal(result.state.requests['sess-1#1#req-1']?.toolOutcome, 'ok');
    assert.equal(result.rejectedEvents[0]?.reason, 'tool_outcome_conflict:ok!=error');
  });

  test('关闭代际拒收新陈述，但接受结清在途请求', () => {
    const result = fold([
      generated(1, 'e1', 'req-1', 'resp-1'),
      sessionReset(2, 'e2', 1),
      statement(3, 'e3', '以后都用英文。', 'pref:language'),
      presented(4, 'e4', 'req-1', 'resp-1'),
    ]);
    assert.equal(result.rejectedEvents[0]?.reason, 'epoch_closed');
    assert.equal(result.state.subjectVersions['pref:language'], undefined);
    assert.equal(result.state.requests['sess-1#1#req-1']?.presented, true);
  });

  test('跨代际跳跃被拒绝', () => {
    const result = fold([
      statement(1, 'e1', 'x', 'pref:a'),
      { ...statement(2, 'e2', 'y', 'pref:b'), sessionEpoch: 5 },
    ]);
    assert.equal(result.rejectedEvents[0]?.reason, 'epoch_jump');
  });

  test('openUntilSequence 只开放当时', () => {
    const events = [statement(1, 'e1', '旧偏好', 'pref:x'), statement(2, 'e2', '新偏好', 'pref:x')];
    const open = reduce(events, { openUntilSequence: 1 }).state;
    assert.equal(open.events.length, 1);
    assert.equal(open.events[0]?.payload.text, '旧偏好');
  });

  test('形状不合法的事件不进入状态', () => {
    const broken = { ...statement(1, 'e1', 'x', 'pref:a'), payload: {} } as MemoryEvent;
    const outcome = stepEvent(emptyState(), broken);
    assert.equal(outcome.disposition, 'rejected');
    assert.match(outcome.reason ?? '', /^shape:/);
  });

  test('事件列表为空时状态就是空状态', () => {
    const state = fold([]).state;
    assert.equal(state.globalVersion, 0);
    assert.deepEqual(state.events, []);
  });

  test('同一 subject 的新陈述令版本 +1（补丁依赖据此失效）', () => {
    const events = [
      statement(1, 'e1', '先给草稿', 'pref:send'),
      statement(2, 'e2', '直接发送', 'pref:send'),
    ];
    const state = fold(events).state;
    assert.equal(state.subjectVersions['pref:send'], 2);
  });
});
