/**
 * 未来模型 runner 的 dry-run 测试。
 *
 * 只证明「计划与预算账目正确、失败不重试、超预算非零退出、无网络传输」。
 * 不证明任何模型效果。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { cannedProvider, dryRun, loadManifest, type FutureManifest } from './runner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = loadManifest();

describe('dry-run 计划', () => {
  test('五个臂 × 24 样本，只有后台整理臂产生整理调用', () => {
    const result = dryRun(manifest, cannedProvider);
    assert.equal(result.exitCode, 0);
    assert.equal(result.arms, 5);
    assert.equal(result.samples, 24);
    const backgroundArms = manifest.arms.filter((arm) => arm.backgroundConsolidation).length;
    assert.equal(result.callsByKind.consolidate, backgroundArms * manifest.frozen.samples);
    // 每样本固定 4 次（读/检索/写/判分）+ 后台整理。
    assert.equal(result.calls, 5 * 24 * 4 + backgroundArms * 24);
  });

  test('预算按样本 × 三档字符上限预留，不超过上限', () => {
    const result = dryRun(manifest, cannedProvider);
    assert.equal(result.budgetUtf16, manifest.frozen.totalUtf16BudgetPerArm * manifest.arms.length);
    assert.ok(result.reservedUtf16 <= result.budgetUtf16, `reserved ${result.reservedUtf16} > ${result.budgetUtf16}`);
  });

  test('provider 失败只计一次尝试，不隐式重试', () => {
    let calls = 0;
    const result = dryRun(manifest, (input) => {
      calls += 1;
      if (input.armId === 'B-constrained-nobg' && input.sampleIndex === 0) return { error: 'injected' };
      return { text: 'ok' };
    });
    assert.equal(result.failures, 1);
    assert.equal(result.implicitRetries, 0);
    assert.equal(calls, manifest.arms.length * manifest.frozen.samples);
    const failed = result.reservations.filter((item) => item.outcome === 'failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.attempts, 0);
  });

  test('预算不足时立即非零退出，且不再继续发起调用', () => {
    const tight: FutureManifest = { ...manifest, frozen: { ...manifest.frozen, totalUtf16BudgetPerArm: 100 } };
    const result = dryRun(tight, cannedProvider);
    assert.equal(result.exitCode, 3);
    assert.ok(result.calls < 5 * 24 * 4);
  });

  test('manifest 本身声明零重试与预留预算', () => {
    assert.equal(manifest.reservationPolicy.reserveBeforeCall, true);
    assert.equal(manifest.reservationPolicy.implicitRetries, 0);
    assert.equal(manifest.reservationPolicy.failureCountsAsAttempt, true);
    assert.equal(manifest.reservationPolicy.overBudgetExitCode, 3);
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
