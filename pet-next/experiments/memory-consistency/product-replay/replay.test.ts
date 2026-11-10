/**
 * C2 产品纯模块回放测试。
 *
 * 断言分两层：
 * 1) 产品事实（会话结算状态、历史轮数/字符、busy、跨代际）；
 * 2) 记忆事实（请求视图的四阶段标志、取消与失败是否被混淆）。
 *
 * 明确不证明：真实 Qwen 生成、真实 UI 呈现、用户是否读到。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { requestKey } from '../contracts.ts';
import { reduce } from '../ledger/reduce.ts';
import { productCodeHashes, runAllScenarios, type ScenarioResult } from './replay.ts';

const results = await runAllScenarios();
const byId = new Map(results.map((result) => [result.meta.scenarioId, result]));

function resultOf(id: string): ScenarioResult {
  const found = byId.get(id);
  assert.ok(found !== undefined, `scenario ${id} missing`);
  return found;
}

describe('C2 产品回放：身份与生命周期', () => {
  test('八个场景全部有结果，且都标注 product-replay + stub', () => {
    assert.equal(results.length, 8);
    for (const result of results) {
      assert.equal(result.meta.sourceCategory, 'product-replay');
      assert.equal(result.meta.executionCategory, 'stub');
      assert.ok(result.meta.doesNotProve.length > 0);
    }
  });

  test('S1 成功入史，但记忆里只能确认 generated', () => {
    const s1 = resultOf('S1');
    assert.equal(s1.productStatus, 'ok');
    assert.equal(s1.historyTurns, 1);
    const state = reduce(s1.events).state;
    const view = state.requests[requestKey('pr-success', 1, 'chat-req-1')];
    assert.equal(view?.generated, true);
    assert.equal(view?.presented, false);
    assert.equal(view?.acknowledged, false);
    assert.equal(view?.toolOutcome, 'none');
  });

  test('S2 取消在途：立即 cancelled，迟到结果不入史', () => {
    const s2 = resultOf('S2');
    assert.equal(s2.productStatus, 'cancelled');
    assert.equal(s2.historyTurns, 0);
    const state = reduce(s2.events).state;
    const view = state.requests[requestKey('pr-cancel', 1, 'chat-req-2')];
    assert.equal(view?.cancelled, true);
    assert.equal(view?.generated, false);
    assert.equal(s2.events.filter((event) => event.kind === 'response.generated').length, 0);
  });

  test('S3 超时与 S4 provider 失败是独立事实', () => {
    const s3 = resultOf('S3');
    assert.equal(s3.productStatus, 'error');
    assert.equal(s3.productCode, 'timeout');
    assert.equal(s3.historyTurns, 0);
    const s4 = resultOf('S4');
    assert.equal(s4.productCode, 'provider-error');
    const state3 = reduce(s3.events).state;
    const view = state3.requests[requestKey('pr-timeout', 1, 'chat-req-3')];
    assert.equal(view?.failed, true);
    assert.equal(view?.cancelled, false);
    assert.equal(view?.failReason, 'timeout');
  });

  test('S5 重置：取消在途 + 清空短期历史，不产生长期撤销', () => {
    const s5 = resultOf('S5');
    assert.equal(s5.productStatus, 'cancelled');
    assert.equal(s5.historyTurns, 0);
    const state = reduce(s5.events).state;
    assert.equal(state.sessions['pr-reset#1']?.closed, true);
    const view = state.requests[requestKey('pr-reset', 1, 'chat-req-5b')];
    assert.equal(view?.cancelled, true);
    assert.equal(view?.generated, false);
  });

  test('S6 同 id 跨代际复用是两个身份', () => {
    const s6 = resultOf('S6');
    const state = reduce(s6.events).state;
    const epoch1 = state.requests[requestKey('pr-epoch', 1, 'chat-reuse')];
    const epoch2 = state.requests[requestKey('pr-epoch', 2, 'chat-reuse')];
    assert.ok(epoch1 !== undefined && epoch2 !== undefined);
    assert.equal(epoch1.responseIds.length, 1);
    assert.equal(epoch2.responseIds.length, 1);
    assert.notEqual(epoch1.requestKey, epoch2.requestKey);
  });

  test('S7 短期历史上界是 4 轮，单轮超界时按产品规则清空旧轮', () => {
    const s7 = resultOf('S7');
    assert.equal(s7.notes.some((note) => note.includes('保留 4 轮')), true, s7.notes.join('|'));
    // 5 轮后只留 4 轮；随后一轮 1997 字符（7 字提问 + 1990 字答复）把旧轮全部挤出，只留它自己。
    assert.equal(s7.historyTurns, 1);
    assert.equal(s7.historyChars, 1997);
  });

  test('S8 被 busy 拒绝的请求没有进入 provider，也没有请求身份', () => {
    const s8 = resultOf('S8');
    assert.equal(s8.productStatus, 'error');
    assert.equal(s8.productCode, 'busy');
    const state = reduce(s8.events).state;
    assert.equal(Object.keys(state.requests).length, 1);
  });

  test('产品从不产生 response.presented：没有证据就不能伪造呈现', () => {
    for (const result of results) {
      assert.equal(
        result.events.filter((event) => event.kind === 'response.presented').length,
        0,
        result.meta.scenarioId,
      );
    }
  });

  test('回放绑定到明确的代码指纹', () => {
    const hashes = productCodeHashes();
    for (const value of Object.values(hashes)) {
      assert.match(value, /^[0-9a-f]{64}$/);
    }
  });
});
