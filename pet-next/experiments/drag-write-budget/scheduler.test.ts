/**
 * 调度器语义逐条钉住：假时钟手动推进，不 sleep、不读真实时间。
 * 覆盖 `docs/M3-11-DRAG-WRITE-BUDGET.md` 第 2 节的 9 条语义。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createBudgetHarness } from './fake-clock.ts';
import { createWriteBudget, DEFAULT_BUDGET_MS } from './scheduler.ts';

/** 静息时刻的不变式：已写出的只算 written，从未写出的只算 coalesced。 */
function assertStatsClosed(budget: ReturnType<typeof createBudgetHarness>['budget'], writes: readonly unknown[]): void {
  const stats = budget.stats;
  assert.equal(stats.submitted, stats.written + stats.coalesced + stats.duplicateDropped);
  assert.equal(stats.written, writes.length);
}

describe('拖动写入预算调度器', () => {
  test('缺省预算是 8ms 计划值', () => {
    assert.equal(DEFAULT_BUDGET_MS, 8);
  });

  test('begin 后第一个 submit 立即写，不挂 timer', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 4, y: 6 });

    assert.deepEqual(writes, [{ x: 4, y: 6 }]);
    assert.equal(clock.scheduleCalls, 0);
    assert.equal(clock.armedCount(), 0);
    assert.equal(budget.stats.written, 1);
    assert.equal(budget.stats.coalesced, 0);
  });

  test('距上次 <8ms 的 submit 只更新 pending，多次 submit 只挂一个 timer', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 0, y: 0 }); // t=0 直写
    clock.advance(3);
    budget.submit({ x: 1, y: 0 }); // t=3 过密，挂剩余 5ms
    clock.advance(1);
    budget.submit({ x: 2, y: 0 }); // t=4 仍在预算内
    budget.submit({ x: 3, y: 0 }); // 同一时刻再更新，不得重复挂 timer

    assert.deepEqual(writes, [{ x: 0, y: 0 }]);
    assert.equal(clock.scheduleCalls, 1);
    assert.equal(clock.armedCount(), 1);

    clock.advance(4); // t=8，timer 到期写最新的 pending
    assert.deepEqual(writes, [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
    ]);
    assert.equal(clock.armedCount(), 0);
    assertStatsClosed(budget, writes);
    assert.deepEqual(
      { submitted: budget.stats.submitted, written: budget.stats.written, coalesced: budget.stats.coalesced },
      { submitted: 4, written: 2, coalesced: 2 },
    );
  });

  test('距上次 >=8ms 立即写，7.999ms 仍只更新 pending（低频输入不被无故延后）', () => {
    {
      const { clock, writes, budget } = createBudgetHarness();
      budget.begin();
      budget.submit({ x: 0, y: 0 });
      clock.advance(7.999);
      budget.submit({ x: 1, y: 1 });
      assert.deepEqual(writes, [{ x: 0, y: 0 }]);
      assert.equal(clock.armedCount(), 1);
      assert.equal(budget.stats.written, 1); // 第二条仍是 pending，还没裁决
    }
    {
      const { clock, writes, budget } = createBudgetHarness();
      budget.begin();
      budget.submit({ x: 0, y: 0 });
      clock.advance(8);
      budget.submit({ x: 1, y: 1 });
      assert.deepEqual(writes, [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]);
      assert.equal(clock.scheduleCalls, 0);
      assert.equal(clock.armedCount(), 0);
      assert.equal(budget.stats.coalesced, 0);
    }
    {
      // 16ms 一帧的普通拖动：每条都直写，一条不合并。
      const { clock, writes, budget } = createBudgetHarness();
      budget.begin();
      budget.submit({ x: 0, y: 0 });
      for (let i = 1; i <= 5; i += 1) {
        clock.advance(16);
        budget.submit({ x: i, y: 0 });
      }
      assert.equal(writes.length, 6);
      assert.equal(clock.scheduleCalls, 0);
      assert.equal(budget.stats.coalesced, 0);
    }
  });

  test('无 tick 松手：pending 未到期时 end() 立刻写出它', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 0, y: 0 }); // t=0 直写
    clock.advance(2);
    budget.submit({ x: 3, y: 4 }); // t=2 pending，timer 还剩 6ms
    assert.deepEqual(writes, [{ x: 0, y: 0 }]);

    budget.end(); // 定时器一次都没触发
    assert.deepEqual(writes, [
      { x: 0, y: 0 },
      { x: 3, y: 4 },
    ]);
    assert.equal(clock.armedCount(), 0);
    assert.equal(budget.stats.flushes, 1);

    clock.advance(100); // 松手后不得再有写
    assert.equal(writes.length, 2);
    assertStatsClosed(budget, writes);
  });

  test('cancel() 同样 flush 本次 pending；无 pending 时只撤 timer 不写', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 0, y: 0 });
    clock.advance(1);
    budget.submit({ x: 5, y: 6 });

    budget.cancel();
    assert.deepEqual(writes, [
      { x: 0, y: 0 },
      { x: 5, y: 6 },
    ]);
    assert.equal(budget.stats.flushes, 1);
    assert.equal(clock.armedCount(), 0);

    budget.end(); // 本次拖动已无 pending
    assert.equal(writes.length, 2);
    assert.equal(budget.stats.flushes, 1);
    clock.advance(100);
    assert.equal(writes.length, 2);
    assertStatsClosed(budget, writes);
  });

  test('end() 无 pending 时不写也不计 flush；begin() 丢弃的 pending 记 coalesced 不记 written', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 0, y: 0 }); // 写
    budget.submit({ x: 1, y: 0 }); // 同一时刻过密 → pending
    clock.advance(1);
    budget.submit({ x: 2, y: 0 }); // 取代上一条 pending
    assert.equal(budget.stats.coalesced, 1); // {1,0} 已被取代

    budget.begin(); // 丢弃 {2,0}：不写、撤 timer、epoch++
    const afterBegin = budget.stats;
    assert.deepEqual(writes, [{ x: 0, y: 0 }]); // 丢弃 pending 不产生 write
    assert.equal(afterBegin.written, 1); // {2,0} 不计 written
    assert.equal(afterBegin.coalesced, 2); // {1,0} 被取代 + {2,0} 被 begin 丢弃
    assert.equal(afterBegin.flushes, 0);
    assert.equal(clock.armedCount(), 0);
    assertStatsClosed(budget, writes);

    const beforeEnd = budget.stats;
    budget.end(); // 无 pending：只撤 timer / epoch++
    assert.deepEqual(writes, [{ x: 0, y: 0 }]); // 无 write
    assert.deepEqual(budget.stats, beforeEnd); // 所有计数一条不变（含 flushes=0）
    assert.equal(budget.stats.flushes, 0);
    assertStatsClosed(budget, writes);

    budget.cancel(); // 同样没有 pending
    assert.deepEqual(writes, [{ x: 0, y: 0 }]);
    assert.equal(budget.stats.flushes, 0);
  });

  test('end/cancel 后旧 timer 即使被触发也无权写，且不补写已提交目标', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 0, y: 0 }); // t=0 直写
    clock.advance(1);
    budget.submit({ x: 1, y: 1 }); // t=1 pending + timer
    budget.end(); // flush 出 {1,1}，撤 timer，epoch++
    assert.deepEqual(writes, [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);

    const fired = clock.fireCancelled(); // 违约再触发旧回调
    assert.ok(fired >= 1);
    assert.equal(writes.length, 2); // 不重复写，也不补写

    // 旧 epoch 的 timer 也不许把新拖动的新 pending 当成自己的写出去。
    budget.begin();
    budget.submit({ x: 5, y: 5 }); // 新拖动首写仍即时
    clock.advance(1);
    budget.submit({ x: 6, y: 6 }); // 新 pending + 新 timer
    assert.equal(writes.length, 3);
    clock.fireCancelled();
    assert.equal(writes.length, 3);
    assert.equal(clock.armedCount(), 1); // 新 timer 仍在

    clock.advance(8);
    assert.deepEqual(writes.at(-1), { x: 6, y: 6 });
    assertStatsClosed(budget, writes);
  });

  test('新 begin() 后旧 timer 无权写，新拖动首写仍然即时（坐标相同也不算重复）', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 0, y: 0 });
    budget.submit({ x: 1, y: 0 }); // 同一时刻过密 → pending
    assert.equal(clock.armedCount(), 1);

    budget.begin(); // 清 pending、撤 timer、epoch++
    assert.equal(clock.armedCount(), 0);
    assert.equal(writes.length, 1);

    clock.fireCancelled();
    assert.equal(writes.length, 1); // 旧 timer 无权写

    budget.submit({ x: 0, y: 0 }); // 新拖动首写：与上次坐标相同也必须立刻写
    assert.deepEqual(writes, [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
    assert.equal(budget.stats.duplicateDropped, 0);
    assert.equal(clock.armedCount(), 0);
    assertStatsClosed(budget, writes);
  });

  test('dispose() 只清不写，之后 submit 与旧 timer 都不产生 write', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 0, y: 0 });
    clock.advance(1);
    budget.submit({ x: 7, y: 7 }); // pending + timer

    budget.dispose();
    assert.deepEqual(writes, [{ x: 0, y: 0 }]); // 不 flush
    assert.equal(clock.armedCount(), 0);

    clock.fireCancelled();
    clock.advance(100);
    assert.equal(writes.length, 1);

    budget.submit({ x: 8, y: 8 }); // dispose 后 submit 忽略
    assert.equal(writes.length, 1);
    budget.end(); // 无 pending，仍不写
    assert.equal(writes.length, 1);

    const stats = budget.stats;
    assert.equal(stats.submitted, 2); // dispose 后的 submit 不计
    assert.equal(stats.written, 1);
    assert.equal(stats.coalesced, 1); // {7,7} 从未写出
    assert.equal(stats.flushes, 0);
    assertStatsClosed(budget, writes);
  });

  test('相同坐标重复 submit 记 duplicateDropped，不产生 write', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 2, y: 3 });
    budget.submit({ x: 2, y: 3 }); // 无 pending + 与上次已写相同
    clock.advance(100);
    budget.submit({ x: 2, y: 3 }); // 距上次很远仍是重复坐标

    assert.deepEqual(writes, [{ x: 2, y: 3 }]);
    assert.equal(budget.stats.duplicateDropped, 2);
    assert.equal(clock.scheduleCalls, 0);
    assertStatsClosed(budget, writes);

    // pending 存在时相同坐标不算重复：它是对 pending 的更新。
    budget.begin();
    budget.submit({ x: 4, y: 4 });
    clock.advance(1);
    budget.submit({ x: 4.5, y: 4 }); // 合并为 pending
    const before = budget.stats;
    budget.submit({ x: 4.5, y: 4 }); // 与 pending 相同也不是 duplicate
    assert.equal(budget.stats.duplicateDropped, before.duplicateDropped);
    assert.equal(budget.stats.coalesced, before.coalesced + 1);
    budget.end();
    assert.deepEqual(writes.at(-1), { x: 4.5, y: 4 });
  });

  test('小数坐标原样透传，不取整', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 0.5, y: -0.25 });
    assert.deepEqual(writes.at(-1), { x: 0.5, y: -0.25 });

    clock.advance(1);
    budget.submit({ x: 1.75, y: 2.5 });
    clock.advance(20); // 由 timer 写出
    assert.deepEqual(writes.at(-1), { x: 1.75, y: 2.5 });

    clock.advance(1);
    budget.submit({ x: 1.25, y: 2.25 });
    budget.end(); // 由 flush 写出
    assert.deepEqual(writes.at(-1), { x: 1.25, y: 2.25 });
    assert.ok(writes.every((position) => !Number.isInteger(position.x)));
  });

  test('stats 计数自洽：submitted = written + coalesced + duplicateDropped', () => {
    const { clock, writes, budget } = createBudgetHarness();
    budget.begin();
    budget.submit({ x: 0, y: 0 });
    budget.submit({ x: 0, y: 0 }); // duplicate
    clock.advance(1);
    budget.submit({ x: 1, y: 0 }); // coalesced
    budget.submit({ x: 2, y: 0 }); // coalesced（取代上一条）
    budget.end(); // flush，计一次 flushes
    assertStatsClosed(budget, writes);
    assert.equal(budget.stats.flushes, 1);

    budget.begin();
    clock.advance(3);
    budget.submit({ x: 9, y: 9 }); // begin 后首写仍即时
    clock.advance(1);
    budget.submit({ x: 10, y: 9 }); // pending 尚未裁决
    const live = budget.stats;
    // 尚未裁决的 pending 让 submitted 比右边多 1（README 写明的口径）。
    assert.equal(live.submitted, live.written + live.coalesced + live.duplicateDropped + 1);
    budget.cancel();
    assertStatsClosed(budget, writes);

    budget.begin();
    budget.submit({ x: 4, y: 4 });
    clock.advance(1);
    budget.submit({ x: 5, y: 4 });
    budget.dispose(); // pending 丢弃 → coalesced
    assertStatsClosed(budget, writes);

    const stats = budget.stats;
    assert.equal(stats.submitted, 8);
    assert.equal(stats.written, 5);
    assert.equal(stats.coalesced, 2);
    assert.equal(stats.duplicateDropped, 1);
  });

  test('budgetMs 可注入；非法预算在创建时报错', () => {
    const { clock, writes, budget } = createBudgetHarness({ budgetMs: 4 });
    budget.begin();
    budget.submit({ x: 0, y: 0 });
    clock.advance(3.999);
    budget.submit({ x: 1, y: 0 });
    assert.equal(writes.length, 1);
    clock.advance(0.001); // t=4，timer 到期
    assert.deepEqual(writes.at(-1), { x: 1, y: 0 });

    assert.throws(
      () =>
        createWriteBudget({
          budgetMs: -1,
          now: () => 0,
          schedule: () => 1,
          cancel: () => {},
          write: () => {},
        }),
      RangeError,
    );
  });
});
