/**
 * scripts/chat-local-core.mjs 的行为锁定：全部注入假 spawn / 假 env / 假 fetch，不启动真 Electron。
 * 覆盖：不起 fake、local 环境变量与 QWEN 配置下发、调试端口参数、正常关窗 0、启动失败与异常退
 * 出非零、信号清理、--probe 成功/失败、配置非法不 spawn，以及 .mjs 常量与 contracts 的一致性。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  CHAT_LOCAL_ENV,
  CHAT_PREVIEW_ENV,
  QWEN_BASE_URL_ENV,
  QWEN_DEFAULT_BASE_URL,
  QWEN_DEFAULT_MODEL,
  QWEN_MODEL_ENV,
} from '../contracts/chat.ts';
import { resolveQwenConfig } from '../electron/chat-config.ts';
import {
  BASE_URL_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  LOCAL_ENV,
  MODEL_ENV,
  PREVIEW_ENV,
  probeLocalService,
  resolveLocalConfig,
  runLocal,
} from './chat-local-core.mjs';

const FAKE_MARKER = 'fake-server-main.ts';
const MAIN_ENTRY = path.join('dist', 'electron', 'main.js');

/** 假子进程：模拟 stdout/stderr、exit/error 事件和 kill。 */
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: string[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;

  emitStdout(chunk: string): void {
    this.stdout.emit('data', Buffer.from(chunk));
  }

  emitStderr(chunk: string): void {
    this.stderr.emit('data', Buffer.from(chunk));
  }

  kill(signal: string = 'SIGTERM'): boolean {
    this.kills.push(signal);
    if (this.exitCode !== null || this.signalCode !== null) return false;
    queueMicrotask(() => this.exitBySignal(signal));
    return true;
  }

  exitBySignal(signal: string): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = signal;
    this.emit('exit', null, signal);
  }

  exitWith(code: number): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  failWith(error: Error): void {
    this.emit('error', error);
  }
}

/** 假信号源：只记录 handler，测试里手动 send。 */
class FakeSignals {
  private readonly handlers = new Map<string, Set<() => void>>();

  on(name: string, handler: () => void): void {
    const set = this.handlers.get(name) ?? new Set<() => void>();
    set.add(handler);
    this.handlers.set(name, set);
  }

  off(name: string, handler: () => void): void {
    this.handlers.get(name)?.delete(handler);
  }

  send(name: string): void {
    for (const handler of [...(this.handlers.get(name) ?? [])]) handler();
  }

  count(name: string): number {
    return this.handlers.get(name)?.size ?? 0;
  }
}

interface SpawnCall {
  command: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string | undefined> };
  child: FakeChild;
}

interface ProbeCall {
  config: { baseUrl: string; model: string };
  fetchImpl: unknown;
}

interface HarnessOptions {
  env?: Record<string, string | undefined>;
  electronPath?: () => string;
  probe?: boolean;
  probeResult?: { ok: boolean; models?: string[]; error?: string } | (() => never);
  throwOnSpawn?: Error;
}

function createHarness(options: HarnessOptions = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const spawnCalls: SpawnCall[] = [];
  const probeCalls: ProbeCall[] = [];
  const signals = new FakeSignals();
  const child = new FakeChild();
  const env = options.env ?? {};

  const spawn = (command: string, args: string[], spawnOptions: SpawnCall['options']): FakeChild => {
    if (options.throwOnSpawn) throw options.throwOnSpawn;
    spawnCalls.push({ command, args: args.map(String), options: spawnOptions, child });
    return child;
  };

  const probeService = async (config: { baseUrl: string; model: string }, fetchImpl: unknown) => {
    probeCalls.push({ config, fetchImpl });
    if (typeof options.probeResult === 'function') return options.probeResult();
    return options.probeResult ?? { ok: true, models: [config.model] };
  };

  const run = (): Promise<number> =>
    runLocal({
      spawn,
      env,
      signals,
      log: (line: string) => logs.push(line),
      logError: (line: string) => errors.push(line),
      electronPath: options.electronPath ?? (() => '/fake/electron'),
      stopGraceMs: 20,
      probe: options.probe ?? false,
      probeService,
      fetchImpl: async () => ({ status: 200 }),
    });

  return { logs, errors, spawnCalls, probeCalls, signals, env, child, run };
}

/** 让内部 await 链跑完。 */
async function tick(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function records(logs: string[]): Record<string, unknown>[] {
  return logs.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function recordOf(logs: string[], event: string): Record<string, unknown>[] {
  return records(logs).filter((record) => record.event === event);
}

describe('镜像常量与 contracts 一致', () => {
  test('环境变量名与默认值不漂移', () => {
    assert.equal(LOCAL_ENV, CHAT_LOCAL_ENV);
    assert.equal(PREVIEW_ENV, CHAT_PREVIEW_ENV);
    assert.equal(BASE_URL_ENV, QWEN_BASE_URL_ENV);
    assert.equal(MODEL_ENV, QWEN_MODEL_ENV);
    assert.equal(DEFAULT_BASE_URL, QWEN_DEFAULT_BASE_URL);
    assert.equal(DEFAULT_MODEL, QWEN_DEFAULT_MODEL);
  });

  test('resolveLocalConfig 与主进程 resolveQwenConfig 同规则', () => {
    const cases: Record<string, string | undefined>[] = [
      {},
      { [QWEN_BASE_URL_ENV]: 'http://127.0.0.1:19999/v1/', [QWEN_MODEL_ENV]: ' other ' },
      { [QWEN_BASE_URL_ENV]: 'https://localhost:8443/v1' },
      { [QWEN_BASE_URL_ENV]: 'not a url' },
      { [QWEN_BASE_URL_ENV]: 'http://0.0.0.0:18872/v1' },
      { [QWEN_BASE_URL_ENV]: 'ftp://127.0.0.1/v1' },
      { [QWEN_MODEL_ENV]: '  ' },
      { [QWEN_BASE_URL_ENV]: '' },
    ];
    for (const env of cases) {
      assert.deepEqual(resolveLocalConfig(env), resolveQwenConfig(env), JSON.stringify(env));
    }
  });
});

describe('runLocal 启动编排', () => {
  test('只起一个进程（Electron），不启动 fake 服务', async () => {
    const harness = createHarness();
    const running = harness.run();

    assert.equal(harness.spawnCalls.length, 1);
    const call = harness.spawnCalls[0];
    assert.ok(call !== undefined);
    assert.ok(!call.args.some((arg) => arg.includes(FAKE_MARKER)), '不得启动 fake 服务');
    assert.ok(call.args[call.args.length - 1]?.endsWith(MAIN_ENTRY), '必须启动 dist/electron/main.js');
    assert.equal(call.command, '/fake/electron');

    harness.child.exitWith(0);
    assert.equal(await running, 0);
  });

  test('下发 local 开关与最终生效的 QWEN 配置，并透传 userData 与 PET_NEXT_TEST', async () => {
    const harness = createHarness({
      env: {
        [QWEN_BASE_URL_ENV]: 'http://127.0.0.1:19999/v1/',
        [QWEN_MODEL_ENV]: 'qwen-custom',
        PET_NEXT_USER_DATA: '/tmp/pet-user-data',
        PET_NEXT_TEST: '0',
      },
    });
    const running = harness.run();

    const childEnv = harness.spawnCalls[0]?.options.env ?? {};
    assert.equal(childEnv[LOCAL_ENV], '1');
    assert.equal(childEnv[QWEN_BASE_URL_ENV], 'http://127.0.0.1:19999/v1');
    assert.equal(childEnv[QWEN_MODEL_ENV], 'qwen-custom');
    assert.equal(childEnv.PET_NEXT_USER_DATA, '/tmp/pet-user-data');
    assert.equal(childEnv.PET_NEXT_TEST, '0', '显式给的 PET_NEXT_TEST 优先');
    assert.equal(childEnv.PET_NEXT_CHAT_FAKE_URL, undefined, 'local 模式不能带 fake 地址');

    harness.child.exitWith(0);
    assert.equal(await running, 0);
  });

  test('未设置 PET_NEXT_TEST 时按 1 传给 Electron（与 chat:preview 一致）', async () => {
    const harness = createHarness();
    const running = harness.run();
    assert.equal(harness.spawnCalls[0]?.options.env?.PET_NEXT_TEST, '1');
    harness.child.exitWith(0);
    assert.equal(await running, 0);
  });

  test('合法调试端口转成 --remote-debugging-port 参数', async () => {
    const harness = createHarness({ env: { PET_NEXT_CHAT_DEBUG_PORT: '9333' } });
    const running = harness.run();

    const args = harness.spawnCalls[0]?.args ?? [];
    assert.ok(args.includes('--remote-debugging-port=9333'));
    assert.equal(recordOf(harness.logs, 'chat-local-electron-config')[0]?.debugPort, 9333);

    harness.child.exitWith(0);
    assert.equal(await running, 0);
  });

  test('非法调试端口不加参数，但记一条 warn', async () => {
    const harness = createHarness({ env: { PET_NEXT_CHAT_DEBUG_PORT: '99999' } });
    const running = harness.run();

    const args = harness.spawnCalls[0]?.args ?? [];
    assert.ok(!args.some((arg) => arg.startsWith('--remote-debugging-port')));
    assert.equal(recordOf(harness.logs, 'chat-local-warn')[0]?.reason, 'invalid-debug-port');

    harness.child.exitWith(0);
    assert.equal(await running, 0);
  });

  test('Electron 打印 ready 后输出 chat-local-ready（含 baseUrl/model，不含凭据）', async () => {
    const harness = createHarness();
    const running = harness.run();

    harness.child.emitStdout('{"event":"rea');
    await tick();
    assert.deepEqual(recordOf(harness.logs, 'chat-local-ready'), [], '半行不能触发就绪');

    harness.child.emitStdout('dy","bounds":{"x":0,"y":0}}\n');
    await tick();
    const ready = recordOf(harness.logs, 'chat-local-ready');
    assert.equal(ready.length, 1);
    assert.equal(ready[0]?.mode, 'local');
    assert.equal(ready[0]?.baseUrl, QWEN_DEFAULT_BASE_URL);
    assert.equal(ready[0]?.model, QWEN_DEFAULT_MODEL);
    assert.equal(Object.keys(ready[0] ?? {}).includes('token'), false);

    harness.child.emitStdout('{"event":"ready"}\n');
    await tick();
    assert.equal(recordOf(harness.logs, 'chat-local-ready').length, 1, '就绪只报一次');

    harness.child.exitWith(0);
    assert.equal(await running, 0);
    assert.equal(recordOf(harness.logs, 'chat-local-done')[0]?.exit, 0);
  });

  test('页面加载失败立即非零退出', async () => {
    const harness = createHarness();
    const running = harness.run();

    harness.child.emitStdout('{"event":"fail-load","code":-6,"description":"ERR_CONNECTION_REFUSED"}\n');
    const code = await running;

    assert.equal(code, 1);
    const failed = recordOf(harness.logs, 'chat-local-failed');
    assert.equal(failed[0]?.reason, 'page-load-failed');
    assert.equal(harness.errors.length, 1);
  });

  test('Electron 异常退出码非零', async () => {
    const harness = createHarness();
    const running = harness.run();
    harness.child.exitWith(3);
    assert.equal(await running, 1);
  });

  test('Electron 被信号杀掉也算失败', async () => {
    const harness = createHarness();
    const running = harness.run();
    harness.child.exitBySignal('SIGKILL');
    assert.equal(await running, 1);
  });

  test('spawn 抛错：非零退出且不再重试', async () => {
    const harness = createHarness({ throwOnSpawn: new Error('spawn ENOENT') });
    const code = await harness.run();

    assert.equal(code, 1);
    assert.equal(recordOf(harness.logs, 'chat-local-failed')[0]?.reason, 'electron-spawn-error');
    assert.match(harness.errors[0] ?? '', /spawn ENOENT/);
  });

  test('Electron 路径解析失败：非零退出且不起进程', async () => {
    const harness = createHarness({
      electronPath: () => {
        throw new Error("require('electron') 返回 undefined");
      },
    });
    const code = await harness.run();

    assert.equal(code, 1);
    assert.equal(harness.spawnCalls.length, 0);
    assert.equal(recordOf(harness.logs, 'chat-local-failed')[0]?.reason, 'electron-path-error');
  });

  test('子进程 error 事件：非零退出', async () => {
    const harness = createHarness();
    const running = harness.run();
    harness.child.failWith(new Error('EACCES'));
    assert.equal(await running, 1);
    assert.equal(recordOf(harness.logs, 'chat-local-failed')[0]?.reason, 'electron-spawn-error');
  });

  test('SIGINT 清理 Electron 并返回 130', async () => {
    const harness = createHarness();
    const running = harness.run();

    harness.signals.send('SIGINT');
    const code = await running;

    assert.equal(code, 130);
    assert.deepEqual(harness.child.kills, ['SIGTERM'], '只清理本次启动的 Electron');
    assert.equal(harness.signals.count('SIGINT'), 0, '收尾要退订信号');
    assert.equal(harness.signals.count('SIGTERM'), 0);
  });

  test('SIGTERM 返回 143', async () => {
    const harness = createHarness();
    const running = harness.run();
    harness.signals.send('SIGTERM');
    assert.equal(await running, 143);
    assert.deepEqual(harness.child.kills, ['SIGTERM']);
  });

  test('PET_NEXT_CHAT_PREVIEW 同时存在时记 warn（local 优先由主进程判定）', async () => {
    const harness = createHarness({ env: { PET_NEXT_CHAT_PREVIEW: '1' } });
    const running = harness.run();

    const warn = recordOf(harness.logs, 'chat-local-warn').find((item) => item.reason === 'preview-env-ignored');
    assert.ok(warn !== undefined);
    assert.equal(warn.env, CHAT_PREVIEW_ENV);

    harness.child.exitWith(0);
    assert.equal(await running, 0);
  });
});

describe('runLocal 配置错误与 --probe', () => {
  test('配置非法：不起 Electron、非零退出、错误可读', async () => {
    const harness = createHarness({ env: { [QWEN_BASE_URL_ENV]: 'http://example.com/v1' } });
    const code = await harness.run();

    assert.equal(code, 1);
    assert.equal(harness.spawnCalls.length, 0);
    const failed = recordOf(harness.logs, 'chat-local-failed')[0];
    assert.equal(failed?.reason, 'config-invalid');
    assert.match(String(failed?.error), /loopback/);
    assert.match(harness.errors[0] ?? '', /配置无效/);
  });

  test('默认不预检：没给 --probe 就不发任何探测请求', async () => {
    const harness = createHarness();
    const running = harness.run();

    assert.deepEqual(harness.probeCalls, []);
    assert.deepEqual(recordOf(harness.logs, 'chat-local-probe'), []);

    harness.child.exitWith(0);
    assert.equal(await running, 0);
  });

  test('--probe 成功：打印预检记录后照常启动 Electron', async () => {
    const harness = createHarness({ probe: true, probeResult: { ok: true, models: ['qwen3.8-27b'] } });
    const running = harness.run();
    await tick();

    assert.equal(harness.probeCalls.length, 1);
    assert.deepEqual(harness.probeCalls[0]?.config, { baseUrl: QWEN_DEFAULT_BASE_URL, model: QWEN_DEFAULT_MODEL });
    const probed = recordOf(harness.logs, 'chat-local-probe');
    assert.equal(probed[0]?.ok, true);
    assert.deepEqual(probed[0]?.models, ['qwen3.8-27b']);
    assert.equal(harness.spawnCalls.length, 1);

    harness.child.exitWith(0);
    assert.equal(await running, 0);
  });

  test('--probe 失败：非零退出且不起 Electron', async () => {
    const harness = createHarness({
      probe: true,
      probeResult: { ok: false, error: '服务未提供模型 qwen3.8-27b（可用：other）' },
    });
    const code = await harness.run();

    assert.equal(code, 1);
    assert.equal(harness.spawnCalls.length, 0);
    const probed = recordOf(harness.logs, 'chat-local-probe')[0];
    assert.equal(probed?.ok, false);
    assert.match(String(probed?.error), /未提供模型/);
    assert.equal(recordOf(harness.logs, 'chat-local-failed')[0]?.reason, 'probe-failed');
    assert.match(harness.errors[0] ?? '', /预检失败/);
  });

  test('--probe 探测抛错也按失败处理', async () => {
    const harness = createHarness({
      probe: true,
      probeResult: () => {
        throw new Error('boom');
      },
    });
    const code = await harness.run();

    assert.equal(code, 1);
    assert.equal(harness.spawnCalls.length, 0);
  });

  test('probeLocalService 用注入的 fetch 判定，不打真实网络', async () => {
    const config = { baseUrl: 'http://127.0.0.1:18872/v1', model: 'qwen3.8-27b' };
    const urls: string[] = [];
    const okFetch = async (url: string) => {
      urls.push(url);
      return { status: 200, json: async () => ({ data: [{ id: 'qwen3.8-27b' }, { id: 'other' }] }) };
    };
    const ok = await probeLocalService(config, okFetch);
    assert.deepEqual(ok, { ok: true, models: ['qwen3.8-27b', 'other'] });
    assert.deepEqual(urls, ['http://127.0.0.1:18872/v1/models']);

    const missing = await probeLocalService(config, async () => ({ status: 200, json: async () => ({ data: [] }) }));
    assert.equal(missing.ok, false);
    assert.match(missing.error, /未提供模型/);

    const refused = await probeLocalService(config, async () => {
      throw new Error('ECONNREFUSED');
    });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /无法连接/);

    const notFound = await probeLocalService(config, async () => ({ status: 404 }));
    assert.equal(notFound.ok, false);
    assert.match(notFound.error, /404/);
  });
});
