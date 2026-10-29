/**
 * runner 写出原始日志，并用退出码表达基线是否对上例子。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  NORMATIVE_EXAMPLES,
  SUSTAINED_LOAD,
  type Arbiter,
  type ArbiterEvent,
  type ArbiterInput,
  type ArbiterRunLog,
} from '../../../contracts/index.ts';
import { createBaseline, type BaselineState } from '../baseline/index.ts';
import { explainDivergence, explainExpectedMismatch, firstDivergence, firstExpectedMismatch } from './compare.ts';
import { runExperiment } from './run-experiment.ts';

const petRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'arbiter-'));
}

async function readLog(dir: string, implementation: string, fixture: string): Promise<ArbiterRunLog> {
  const raw = await readFile(path.join(dir, implementation, `${fixture}.json`), 'utf8');
  return JSON.parse(raw) as ArbiterRunLog;
}

function expiredStarts(log: ArbiterRunLog): number {
  const events = new Map<string, ArbiterEvent>();
  for (const input of log.delivered) {
    if (input.type === 'deliver') events.set(input.event.id, input.event);
  }
  let count = 0;
  for (const step of log.steps) {
    for (const decision of step.decisions) {
      if (decision.reason !== 'started' || decision.eventId === null) continue;
      const event = events.get(decision.eventId);
      if (event === undefined) continue;
      if (step.input.nowMs >= event.expiresAtMs || event.timeMs >= event.expiresAtMs) count += 1;
    }
  }
  return count;
}

function runNode(args: readonly string[], cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('runExperiment', () => {
  test('注入尚未实现的状态机替身时退出码为 0，并留下原始日志', async () => {
    const dir = await tempDir();
    const missing = (): Arbiter<unknown> => ({
      initialState() {
        throw new Error('state-machine 尚未实现');
      },
      step() {
        throw new Error('state-machine 尚未实现');
      },
    });
    try {
      const code = await runExperiment({ outDir: dir, silent: true, stateMachine: missing });
      assert.equal(code, 0);
      for (const example of NORMATIVE_EXAMPLES) {
        const log = await readLog(dir, 'baseline', example.name);
        assert.equal(log.implementation, 'baseline');
        assert.equal(log.fixture, example.name);
        assert.equal(log.seed, null);
        assert.equal(log.steps.length, example.inputs.length);
        assert.equal(Number.isFinite(log.machineElapsedMs) && log.machineElapsedMs >= 0, true);
        for (let index = 0; index < example.expected.length; index += 1) {
          const want = example.expected[index];
          const got = log.steps[index];
          assert.ok(want && got);
          assert.equal(got.queueLength, want.queueLength, `${example.name}#${index}`);
          assert.deepEqual(got.decisions, want.decisions, `${example.name}#${index}`);
          assert.equal('state' in got, false);
        }
      }
      const sustained = await readLog(dir, 'baseline', 'sustained-high-priority');
      assert.equal(sustained.seed, SUSTAINED_LOAD.seed);
      assert.equal(sustained.delivered.length, SUSTAINED_LOAD.count);
      assert.equal(sustained.steps.length, SUSTAINED_LOAD.count);
      assert.equal(
        sustained.delivered.every((input) => input.type === 'deliver'),
        true,
      );
      assert.equal(expiredStarts(sustained), 0);
      const status = JSON.parse(await readFile(path.join(dir, 'state-machine', 'status.json'), 'utf8')) as { status: string };
      assert.deepEqual(status, { status: 'not-implemented' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('两侧都实现且持续负载一致时退出码为 0，并清掉占位标记', async () => {
    const dir = await tempDir();
    try {
      const code = await runExperiment({ outDir: dir, silent: true, stateMachine: createBaseline });
      assert.equal(code, 0);
      const baseline = await readLog(dir, 'baseline', 'sustained-high-priority');
      const candidate = await readLog(dir, 'state-machine', 'sustained-high-priority');
      assert.equal(candidate.implementation, 'state-machine');
      assert.equal(firstDivergence(baseline, candidate), null);
      await assert.rejects(readFile(path.join(dir, 'state-machine', 'status.json')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('持续负载分叉时退出码为 1', async () => {
    const dir = await tempDir();
    const divergent = (): Arbiter<BaselineState> => {
      const inner = createBaseline();
      return {
        initialState: () => inner.initialState(),
        step(state: BaselineState, input: ArbiterInput) {
          if (input.type === 'deliver' && input.event.id === 'sustained-0') {
            return {
              state,
              decisions: [{ outcome: 'wait', reason: 'queued-same-rank', eventId: input.event.id, actionId: null }],
              queueLength: 1,
            };
          }
          return inner.step(state, input);
        },
      };
    };
    try {
      const code = await runExperiment({ outDir: dir, silent: true, stateMachine: divergent });
      assert.equal(code, 1);
      const baseline = await readLog(dir, 'baseline', 'sustained-high-priority');
      const candidate = await readLog(dir, 'state-machine', 'sustained-high-priority');
      assert.equal(firstDivergence(baseline, candidate), 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('状态机抛出其他错误时退出码为 1，基线日志仍在', async () => {
    const dir = await tempDir();
    const broken = (): Arbiter<unknown> => ({
      initialState: () => ({}),
      step() {
        throw new Error('计算失败');
      },
    });
    try {
      const code = await runExperiment({ outDir: dir, silent: true, stateMachine: broken });
      assert.equal(code, 1);
      const normal = await readLog(dir, 'baseline', 'normal');
      assert.equal(normal.steps.length > 0, true);
      await assert.rejects(readFile(path.join(dir, 'state-machine', 'status.json')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('基线尚未实现时退出码为 2', async () => {
    const dir = await tempDir();
    const missing = (): Arbiter<unknown> => ({
      initialState() {
        throw new Error('baseline 尚未实现');
      },
      step() {
        throw new Error('baseline 尚未实现');
      },
    });
    try {
      const code = await runExperiment({ outDir: dir, silent: true, baseline: missing });
      assert.equal(code, 2);
      await assert.rejects(readFile(path.join(dir, 'baseline', 'normal.json')));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('实现改写入参时，日志里仍是原来的事件', async () => {
    const dir = await tempDir();
    const mutating = (): Arbiter<unknown> => ({
      initialState: () => ({}),
      step(state, input) {
        if (input.type === 'deliver') input.event.id = 'mutated';
        return {
          state,
          decisions: [{ outcome: 'discard', reason: 'duplicate', eventId: 'mutated', actionId: null }],
          queueLength: 0,
        };
      },
    });
    try {
      const code = await runExperiment({ outDir: dir, silent: true, baseline: mutating });
      assert.equal(code, 1);
      const normal = await readLog(dir, 'baseline', 'normal');
      const first = normal.delivered[0];
      assert.ok(first && first.type === 'deliver');
      if (first.type === 'deliver') assert.equal(first.event.id, 'c');
      const recorded = normal.steps[0]?.input;
      assert.ok(recorded && recorded.type === 'deliver');
      if (recorded?.type === 'deliver') assert.equal(recorded.event.id, 'c');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('导入入口不改退出码', async () => {
    const before = process.exitCode;
    await import('./main.ts');
    assert.equal(process.exitCode, before);
  });

  test('直接执行入口：基线和状态机都写出日志且一致', async () => {
    const result = await runNode(['--experimental-strip-types', 'experiments/arbiter/runner/main.ts'], petRoot);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.includes('尚未实现'), false);
    const outDir = path.join(petRoot, 'experiments/arbiter/out');
    await assert.rejects(readFile(path.join(outDir, 'state-machine', 'status.json')));
    for (const example of NORMATIVE_EXAMPLES) {
      const baseline = await readLog(outDir, 'baseline', example.name);
      const candidate = await readLog(outDir, 'state-machine', example.name);
      assert.equal(baseline.implementation, 'baseline', example.name);
      assert.equal(candidate.implementation, 'state-machine', example.name);
      assert.equal(firstExpectedMismatch(baseline, example.expected), null, example.name);
      assert.equal(firstExpectedMismatch(candidate, example.expected), null, example.name);
      assert.equal(firstDivergence(baseline, candidate), null, example.name);
    }
    const sustainedBaseline = await readLog(outDir, 'baseline', 'sustained-high-priority');
    const sustainedCandidate = await readLog(outDir, 'state-machine', 'sustained-high-priority');
    assert.equal(sustainedBaseline.seed, SUSTAINED_LOAD.seed);
    assert.equal(sustainedCandidate.seed, SUSTAINED_LOAD.seed);
    assert.equal(firstDivergence(sustainedBaseline, sustainedCandidate), null);
  });
});

describe('compare', () => {
  test('差异说明带夹具名和输入下标', () => {
    const log = {
      implementation: 'baseline',
      fixture: 'normal',
      seed: null,
      delivered: [],
      steps: [{ input: { type: 'complete', actionId: 'c', nowMs: 0 }, decisions: [], queueLength: 1 }],
      machineElapsedMs: 0,
    } as const satisfies ArbiterRunLog;
    const expected = [{ decisions: [{ outcome: 'execute', reason: 'started', eventId: 'c', actionId: 'c' } as const], queueLength: 0 }];
    assert.equal(firstExpectedMismatch(log, expected), 0);
    assert.match(explainExpectedMismatch('baseline', 'normal', 0, expected, log), /normal/);
    assert.match(explainExpectedMismatch('baseline', 'normal', 0, expected, log), /下标 0/);
    const other = { ...log, steps: [{ ...log.steps[0], queueLength: 0 }] };
    assert.equal(firstDivergence(log, other), 0);
    assert.equal(explainDivergence('sustained-high-priority', 3), 'baseline 与 state-machine 在夹具 sustained-high-priority 的输入下标 3 分叉。');
  });
});
