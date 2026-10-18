/**
 * 位置 / 抛掷指令的**纯决策层**单元测试 —— 钉住契约里最容易走样的几处：
 *
 *   - **坐标夹取**：越界夹到 `0~1`，调用方拿响应里的实际值即可，不必自己算边界；
 *   - **宠物解析口径**：`?pet=` 优先 → 当前桌宠 → 兜底 `main`，且 id 必须真实存在
 *     （绝不猜、绝不退到列表第一只）；
 *   - **不设死区**：`power` 再小也受理（死区是拖拽语义，接口是明确命令）；
 *   - 参数形状校验：字符串 / `NaN` / `Infinity` 一律拒，且**先于**宠物解析报错。
 *
 * 跑法：node --experimental-strip-types --test src/host/motion-cue.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decidePosition, decideThrow } from './motion-cue.ts';

/** 最小可用成品配置：两个条目各一只宠物（与 ./anim.test.ts 同一形状） */
const cfg = {
  main: { pets: [{ id: 'main', name: 'A' }] },
  pack1: { pets: [{ id: 'pack1', name: 'B' }] },
};

/** 决策结论 → 失败原因（通过时给 null，方便断言） */
const reasonOf = (d: { ok: boolean } & Record<string, unknown>): unknown => (d.ok ? null : d.reason);

describe('decidePosition —— 参数校验与夹取', () => {
  test('合法坐标原样通过，smooth 缺省按 true', () => {
    const d = decidePosition({ cfg, requested: 'main', active: '', x: 0.5, y: 0.35 });
    assert.deepEqual(d, { ok: true, petId: 'main', x: 0.5, y: 0.35, smooth: true });
  });

  test('越界夹到 0~1（夹取而不是拒绝）', () => {
    const hi = decidePosition({ cfg, requested: 'main', active: '', x: 1.8, y: 99 });
    assert.deepEqual(hi, { ok: true, petId: 'main', x: 1, y: 1, smooth: true });
    const lo = decidePosition({ cfg, requested: 'main', active: '', x: -3, y: -0.01 });
    assert.deepEqual(lo, { ok: true, petId: 'main', x: 0, y: 0, smooth: true });
  });

  test('边界值 0 与 1 原样保留（中心可到屏幕边缘，允许半个身体出屏）', () => {
    const d = decidePosition({ cfg, requested: 'main', active: '', x: 0, y: 1 });
    assert.equal(d.ok && d.x, 0);
    assert.equal(d.ok && d.y, 1);
  });

  test('smooth 只有严格 false 才是"立即"（其余一律平滑）', () => {
    for (const v of [false, 'no', 0, null, undefined]) {
      const d = decidePosition({ cfg, requested: 'main', active: '', x: 0.5, y: 0.5, smooth: v });
      assert.equal(d.ok && d.smooth, v !== false, `smooth=${String(v)}`);
    }
  });

  test('非有限数字 → bad-request（字符串 / NaN / Infinity / 缺失都拒）', () => {
    for (const bad of ['0.5', NaN, Infinity, -Infinity, null, undefined, {}]) {
      const d = decidePosition({ cfg, requested: 'main', active: '', x: bad, y: 0.5 });
      assert.equal(reasonOf(d), 'bad-request', `x=${String(bad)}`);
    }
    const dy = decidePosition({ cfg, requested: 'main', active: '', x: 0.5, y: NaN });
    assert.equal(reasonOf(dy), 'bad-request');
  });
});

describe('decideThrow —— 参数校验', () => {
  test('合法角度与力度原样通过（角度不做归一化）', () => {
    const d = decideThrow({ cfg, requested: 'main', active: '', angle: 135, power: 3 });
    assert.deepEqual(d, { ok: true, petId: 'main', angle: 135, power: 3 });
    const neg = decideThrow({ cfg, requested: 'main', active: '', angle: -90, power: 0.5 });
    assert.equal(neg.ok && neg.angle, -90, '负角度是"正下"，必须原样保留（sin/cos 天然按 360 周期）');
  });

  test('power 必须 > 0 且有限（0 / 负数 / NaN / Infinity / 字符串一律拒）', () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity, '1', null, undefined]) {
      const d = decideThrow({ cfg, requested: 'main', active: '', angle: 45, power: bad });
      assert.equal(reasonOf(d), 'bad-request', `power=${String(bad)}`);
    }
  });

  test('**不设死区**：极小的 power 也照样受理（死区是拖拽语义，接口是明确命令）', () => {
    const d = decideThrow({ cfg, requested: 'main', active: '', angle: 45, power: 0.001 });
    assert.equal(d.ok, true);
  });

  test('角度非法 → bad-request', () => {
    for (const bad of ['45', NaN, Infinity, null, undefined]) {
      const d = decideThrow({ cfg, requested: 'main', active: '', angle: bad, power: 1 });
      assert.equal(reasonOf(d), 'bad-request', `angle=${String(bad)}`);
    }
  });
});

describe('宠物解析口径（两条接口共用）', () => {
  test('?pet= 优先；空则当前桌宠；再空兜底 main', () => {
    const explicit = decidePosition({ cfg, requested: 'pack1', active: 'main', x: 0, y: 0 });
    assert.equal(explicit.ok && explicit.petId, 'pack1');
    const byActive = decidePosition({ cfg, requested: '', active: 'pack1', x: 0, y: 0 });
    assert.equal(byActive.ok && byActive.petId, 'pack1');
    const fallback = decidePosition({ cfg, requested: '', active: '', x: 0, y: 0 });
    assert.equal(fallback.ok && fallback.petId, 'main');
  });

  test('id 不存在 → unknown-pet（绝不猜、绝不退到列表第一只）', () => {
    const d = decidePosition({ cfg, requested: 'nope', active: 'main', x: 0, y: 0 });
    assert.equal(reasonOf(d), 'unknown-pet');
    const t = decideThrow({ cfg, requested: 'nope', active: 'main', angle: 0, power: 1 });
    assert.equal(reasonOf(t), 'unknown-pet');
  });

  test('参数非法**优先**于宠物解析报错（参数是调用方的错，先纠它）', () => {
    const d = decidePosition({ cfg, requested: 'nope', active: '', x: 'bad', y: 0 });
    assert.equal(reasonOf(d), 'bad-request');
    const t = decideThrow({ cfg, requested: 'nope', active: '', angle: 0, power: -1 });
    assert.equal(reasonOf(t), 'bad-request');
  });
});
