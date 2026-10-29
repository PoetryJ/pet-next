/**
 * 核对器写出比较结果。失败时保留第一条对不上的输入下标。
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { NORMATIVE_EXAMPLES, type ArbiterComparison, type ArbiterInput, type ArbiterRunLog } from '../../../contracts/index.ts';
import { createBaseline } from '../baseline/index.ts';
import { defaultSequences, runCheck } from '../check/run-check.ts';
import { replayFactory, type ReplayFactory } from '../check/replay.ts';
function deliver(id: string): ArbiterInput {
  return { type: 'deliver', event: { id, source: 'click', seq: 0, timeMs: 0, expiresAtMs: 100 }, nowMs: 0 };
}

function shiftQueue(factory: ReplayFactory): ReplayFactory {
  return () => {
    const inner = factory();
    return {
      initialState: () => inner.initialState(),
      step(state, input) {
        const result = inner.step(state, input);
        return { ...result, queueLength: result.queueLength + 1 };
      },
    };
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'arbiter-check-'));
}

describe('runCheck', () => {
  test('两种实现在规范性例子、持续负载和 held-out 上规则违反为 0', async () => {
    const outDir = await tempDir();
    const code = await runCheck({ outDir, refreshLogs: false, requireRunnerLogs: false, silent: true });
    assert.equal(code, 0);
    const comparisons = JSON.parse(await readFile(path.join(outDir, 'check.json'), 'utf8')) as ArbiterComparison[];
    const names = defaultSequences().map((sequence) => sequence.name);
    assert.deepEqual(
      comparisons.map((comparison) => comparison.fixture),
      names,
    );
    for (const comparison of comparisons) {
      assert.equal(comparison.firstDivergenceIndex, null, comparison.fixture);
      assert.equal(comparison.baseline.ruleViolations, 0, comparison.fixture);
      assert.equal(comparison.baseline.expiredExecutions, 0, comparison.fixture);
      assert.equal(comparison.baseline.firstFailureIndex, null, comparison.fixture);
      assert.equal(comparison.stateMachine.ruleViolations, 0, comparison.fixture);
      assert.equal(comparison.stateMachine.expiredExecutions, 0, comparison.fixture);
      assert.equal(comparison.stateMachine.firstFailureIndex, null, comparison.fixture);
      assert.equal(Object.hasOwn(comparison.baseline, 'simulatedWaitMs'), true);
      assert.equal(Object.hasOwn(comparison.baseline, 'machineElapsedMs'), true);
    }
    const text = await readFile(path.join(outDir, 'check-report.txt'), 'utf8');
    assert.equal(text.includes('不是桌宠的线上收益'), true);
    assert.equal(text.includes('simulatedWaitMs'), true);
    assert.equal(text.includes('machineElapsedMs'), true);
    const heldout = JSON.parse(await readFile(path.join(outDir, 'heldout', 'baseline', 'heldout-id-order.json'), 'utf8')) as ArbiterRunLog;
    assert.equal(heldout.fixture, 'heldout-id-order');
    assert.equal(heldout.implementation, 'baseline');
  });

  test('队列长度被改写时记下第一条分叉，不把机器耗时写进模拟等待', async () => {
    const outDir = await tempDir();
    const code = await runCheck({
      outDir,
      refreshLogs: false,
      requireRunnerLogs: false,
      silent: true,
      stateMachine: shiftQueue(createBaseline),
      sequences: [{ name: 'probe', inputs: [deliver('c')], expected: null, copyMachineElapsed: false, seed: null }],
    });
    assert.equal(code, 1);
    const comparisons = JSON.parse(await readFile(path.join(outDir, 'check.json'), 'utf8')) as ArbiterComparison[];
    const probe = comparisons[0];
    assert.ok(probe);
    assert.equal(probe.baseline.firstFailureIndex, null);
    assert.equal(probe.baseline.ruleViolations, 0);
    assert.equal(probe.stateMachine.firstFailureIndex, 0);
    assert.equal(probe.stateMachine.ruleViolations, 1);
    assert.equal(probe.firstDivergenceIndex, 0);
    assert.equal(probe.stateMachine.simulatedWaitMs, probe.baseline.simulatedWaitMs);
  });

  test('规范性例子的机器耗时抄日志，不使用核对器自己的计时', async () => {
    const outDir = await tempDir();
    const example = NORMATIVE_EXAMPLES[0];
    assert.ok(example);
    const replay = replayFactory(createBaseline, example.inputs);
    const log: ArbiterRunLog = {
      implementation: 'baseline',
      fixture: example.name,
      seed: null,
      delivered: example.inputs,
      steps: replay.steps.map((step, index) => {
        const input = example.inputs[index];
        assert.ok(input);
        return { input, decisions: step.decisions, queueLength: step.queueLength };
      }),
      machineElapsedMs: 12.5,
    };
    const stateLog: ArbiterRunLog = { ...log, implementation: 'state-machine', machineElapsedMs: 7.25 };
    await mkdir(path.join(outDir, 'baseline'), { recursive: true });
    await mkdir(path.join(outDir, 'state-machine'), { recursive: true });
    await writeFile(path.join(outDir, 'baseline', `${example.name}.json`), `${JSON.stringify(log)}\n`, 'utf8');
    await writeFile(path.join(outDir, 'state-machine', `${example.name}.json`), `${JSON.stringify(stateLog)}\n`, 'utf8');
    const code = await runCheck({
      outDir,
      refreshLogs: false,
      requireRunnerLogs: true,
      silent: true,
      sequences: [{ name: example.name, inputs: example.inputs, expected: example.expected, copyMachineElapsed: true, seed: null }],
    });
    assert.equal(code, 0);
    const comparisons = JSON.parse(await readFile(path.join(outDir, 'check.json'), 'utf8')) as ArbiterComparison[];
    assert.equal(comparisons[0]?.baseline.machineElapsedMs, 12.5);
    assert.equal(comparisons[0]?.stateMachine.machineElapsedMs, 7.25);
    const text = await readFile(path.join(outDir, 'check-report.txt'), 'utf8');
    assert.equal(text.includes('timeSrc'), true);
    assert.match(text, /baseline\s+0\s+0\s+\d+\s+12\.500000/);
  });

  test('缺少要求中的 runner 日志时退出码为 1，并写下标 0', async () => {
    const outDir = await tempDir();
    const example = NORMATIVE_EXAMPLES[0];
    assert.ok(example);
    const code = await runCheck({
      outDir,
      refreshLogs: false,
      requireRunnerLogs: true,
      silent: true,
      sequences: [{ name: example.name, inputs: example.inputs, expected: example.expected, copyMachineElapsed: true, seed: null }],
    });
    assert.equal(code, 1);
    const comparisons = JSON.parse(await readFile(path.join(outDir, 'check.json'), 'utf8')) as ArbiterComparison[];
    assert.equal(comparisons[0]?.baseline.firstFailureIndex, 0);
    assert.equal(comparisons[0]?.baseline.ruleViolations, 0);
  });

  test('基线工厂抛出尚未实现时退出码为 2', async () => {
    const outDir = await tempDir();
    const code = await runCheck({
      outDir,
      refreshLogs: false,
      requireRunnerLogs: false,
      silent: true,
      baseline: () => {
        throw new Error('baseline 尚未实现');
      },
    });
    assert.equal(code, 2);
  });
});
