/**
 * 未来模型 runner 的 dry-run 测试。
 *
 * 只证明「计划、预留、stub 尝试三者账目正确；失败不重试；超额在动作前拒绝；无网络传输」。
 * 不证明任何模型效果。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { cannedProvider, dryRun, loadManifest, planOperations, type FutureManifest } from './runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = loadManifest();

describe('dry-run 计划', () => {
  test('计划条数与臂/样本/操作数一致，且预留次数等于计划条数', () => {
    const result = dryRun(manifest, cannedProvider);
    const backgroundArms = manifest.arms.filter((arm) => arm.backgroundConsolidation).length;
    const expected = 5 * 24 * 4 + backgroundArms * 24;
    assert.equal(result.exitCode, 0);
    assert.equal(result.plannedOperations, expected);
    assert.equal(planOperations(manifest).length, expected);
    assert.equal(result.reservations.length, expected, '每次计划操作都应在动作前预留');
  });

  test('provider 尝试数等于真实调用次数，不等于计划条数', () => {
    let actual = 0;
    const result = dryRun(manifest, (input) => {
      actual += 1;
      return { text: `ok-${input.sampleIndex}` };
    });
    assert.equal(actual, 120, '每样本一次 stub 调用');
    assert.equal(result.providerAttempts, actual);
    assert.equal(result.attempts.length, actual);
    assert.equal(new Set(result.attempts.map((item) => item.attemptId)).size, actual, 'attemptId 必须唯一');
    assert.ok(result.plannedOperations > result.providerAttempts);
  });

  test('每臂预留独立统计，且不超过 manifest 声明的每臂上限', () => {
    const result = dryRun(manifest, cannedProvider);
    for (const arm of manifest.arms) {
      assert.ok(
        (result.perArmReserved[arm.id] ?? 0) <= manifest.frozen.totalUtf16BudgetPerArm,
        `${arm.id} 超额`,
      );
    }
    assert.equal(result.perArmReserved['A-strong-ledger'], 71808);
    assert.equal(result.perArmReserved['B-constrained-nobg'], 66048);
  });

  test('每臂 70000 时 A/D 必须在动作前被拒，不能借别臂余额', () => {
    const tight: FutureManifest = { ...manifest, frozen: { ...manifest.frozen, totalUtf16BudgetPerArm: 70000 } };
    let calls = 0;
    const result = dryRun(tight, () => {
      calls += 1;
      return { text: 'ok' };
    });
    assert.equal(result.exitCode, 3);
    assert.deepEqual([...result.exceededArms].sort(), ['A-strong-ledger', 'D-free-bg']);
    for (const value of Object.values(result.perArmReserved)) assert.ok(value <= 70000, `${value} > 70000`);
    assert.ok(calls < 120, '超额臂不该继续调用 provider');
    // 未超额臂照常跑满，说明没有把全局余额挪给 A/D，也没有因 A/D 停掉别人。
    assert.equal(result.perArmReserved['B-constrained-nobg'], 66048);
  });

  test('全局预算另算：超出时停止后续动作', () => {
    const tight: FutureManifest = { ...manifest, frozen: { ...manifest.frozen, totalUtf16BudgetGlobal: 100000 } };
    const result = dryRun(tight, cannedProvider);
    assert.equal(result.exitCode, 3);
    assert.equal(result.exceededGlobal, true);
    assert.ok(result.globalReserved <= 100000);
  });

  test('stub 失败：保留 attempt、计 1 次、不重试、不释放额度、非零退出', () => {
    let calls = 0;
    const result = dryRun(manifest, () => {
      calls += 1;
      return calls === 1 ? { error: 'injected' } : { text: 'ok' };
    });
    assert.equal(result.failures, 1);
    assert.equal(result.implicitRetries, 0);
    assert.equal(result.exitCode, 4);
    assert.equal(result.attempts[0]?.outcome, 'failed');
    assert.equal(result.attempts[0]?.failure, 'injected');
    assert.equal(result.providerAttempts, calls);
    // 第一条 sample 的预留仍然占着额度（没有退还）。
    assert.equal(result.perArmReserved['A-strong-ledger'], 71808);
  });

  test('manifest 声明零重试与每臂预算', () => {
    assert.equal(manifest.reservationPolicy.reserveBeforeCall, true);
    assert.equal(manifest.reservationPolicy.implicitRetries, 0);
    assert.equal(manifest.reservationPolicy.failureCountsAsAttempt, true);
    assert.equal(manifest.reservationPolicy.overBudgetExitCode, 3);
    assert.equal(typeof manifest.frozen.totalUtf16BudgetPerArm, 'number');
  });

  test('runner 源码里没有 live 传输', () => {
    const source = readFileSync(join(HERE, 'runner.ts'), 'utf8');
    for (const needle of ['node:http', 'node:https', 'node:net', 'fetch(', 'WebSocket', 'undici']) {
      assert.equal(source.includes(needle), false, needle);
    }
  });

  test('计划里有需要人决策的项，不擅自替产品选型', () => {
    const raw = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8')) as FutureManifest & {
      decisionsNeededFromOwner: string[];
    };
    assert.ok(raw.decisionsNeededFromOwner.length >= 3);
  });
});
