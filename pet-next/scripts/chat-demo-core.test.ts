/**
 * scripts/chat-demo-core.mjs 的行为锁定：全部注入假子进程 / 假 fetch，不启动真 Electron。
 * 覆盖：就绪记录整行解析（半行/多行）、fake 失败、Electron 失败、正常关窗、Ctrl-C、
 * offline_ready 门控、冻结启动参数（debug 端口 / userData 透传）。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePort, resolveElectronPath, runDemo } from './chat-demo-core.mjs';

const FAKE_MARKER = 'fake-server-main.ts';
const READY_LINE = '{"event":"fake-chat-server-ready","port":4517,"url":"http://127.0.0.1:4517"}\n';

/** 假子进程：模拟 stdout/stderr、exit/error 事件和 kill；被 kill 后异步吐 exit，模拟真实信号退出。 */
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

interface HarnessOptions {
  env?: Record<string, string | undefined>;
  health?: () => Promise<unknown>;
  electronPath?: () => string;
}

function createHarness(options: HarnessOptions = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const spawnCalls: SpawnCall[] = [];
  const healthUrls: string[] = [];
  const signals = new FakeSignals();
  const fakeChild = new FakeChild();
  const electronChild = new FakeChild();
  const env = options.env ?? {};

  const spawn = (command: string, args: string[], spawnOptions: SpawnCall['options']): FakeChild => {
    const child = args.some((arg) => String(arg).includes(FAKE_MARKER)) ? fakeChild : electronChild;
    spawnCalls.push({ command, args: args.map(String), options: spawnOptions, child });
    return child;
  };
  const fetchHealth = async (url: string): Promise<unknown> => {
    healthUrls.push(url);
    if (options.health) return options.health();
    return { ok: true, status: 200, json: async () => ({ status: 'offline_ready' }) };
  };

  const electronSpawns = () => spawnCalls.filter((call) => !call.args.some((arg) => arg.includes(FAKE_MARKER)));
  const firstElectron = () => electronSpawns()[0];

  const run = () =>
    runDemo({
      spawn,
      fetchHealth,
      env,
      signals,
      log: (line: string) => logs.push(line),
      logError: (line: string) => errors.push(line),
      electronPath: options.electronPath ?? (() => '/fake/electron'),
      stopGraceMs: 20,
    });

  return {
    logs,
    errors,
    spawnCalls,
    healthUrls,
    signals,
    env,
    fakeChild,
    electronChild,
    electronSpawns,
    firstElectron,
    run,
  };
}

/** 让内部的 await 链跑完（health 检查是异步的）。 */
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

/** 在假 fake 就绪 + 假 health 通过后，把 Electron 推到"面板已渲染"。 */
async function driveToReady(harness: ReturnType<typeof createHarness>): Promise<void> {
  harness.fakeChild.emitStdout(READY_LINE);
  await tick();
  harness.electronChild.emitStdout('{"event":"ready","bounds":{"x":0,"y":0}}\n');
  await tick();
}

describe('runDemo 启动编排', () => {
  test('半行到达的就绪记录也要等整行才启动 Electron', async () => {
    const harness = createHarness();
    const running = harness.run();

    harness.fakeChild.emitStdout('{"event":"fake-chat-');
    await tick();
    assert.equal(harness.spawnCalls.length, 1, '半行记录不能触发 Electron');
    assert.deepEqual(harness.healthUrls, []);

    harness.fakeChild.emitStdout('server-ready","port":4517,"url":"http://127.0.0.1:4517"}\n');
    await tick();
    assert.deepEqual(harness.healthUrls, ['http://127.0.0.1:4517/healthz']);
    assert.equal(harness.electronSpawns().length, 1);

    harness.electronChild.emitStdout('{"event":"ready"}\n');
    await tick();
    assert.equal(recordOf(harness.logs, 'chat-demo-ready').length, 1);

    harness.electronChild.exitWith(0);
    assert.equal(await running, 0);
  });

  test('一个 chunk 里多行时按行解析，重复就绪不重复启动 Electron', async () => {
    const harness = createHarness();
    const running = harness.run();

    harness.fakeChild.emitStdout(`fake boot noise\n${READY_LINE}{"event":"unrelated"}\n`);
    await tick();
    assert.equal(harness.electronSpawns().length, 1);
    assert.equal(harness.healthUrls.length, 1);
    assert.equal(recordOf(harness.logs, 'fake-chat-server-ready').length, 1);

    harness.fakeChild.emitStdout(READY_LINE);
    await tick();
    assert.equal(harness.electronSpawns().length, 1);
    assert.equal(harness.healthUrls.length, 1);

    await driveToReady(harness);
    harness.electronChild.exitWith(0);
    assert.equal(await running, 0);
  });

  test('fake 启动失败：非零退出、不起 Electron、不报 offline_ready:true', async () => {
    const harness = createHarness();
    const running = harness.run();

    harness.fakeChild.failWith(new Error('spawn fake ENOENT'));
    const code = await running;

    assert.equal(code, 1);
    assert.equal(harness.electronSpawns().length, 0);
    assert.equal(harness.errors.length, 1);
    assert.match(harness.errors[0] ?? '', /fake-spawn-error/);
    const done = recordOf(harness.logs, 'chat-demo-done');
    assert.equal(done.length, 1);
    assert.equal(done[0]?.offline_ready, false);
    assert.ok(!records(harness.logs).some((record) => record.offline_ready === true));
  });

  test('fake 非零退出：先报错再清理，退出码非零', async () => {
    const harness = createHarness();
    const running = harness.run();

    harness.fakeChild.exitWith(3);
    const code = await running;

    assert.equal(code, 1);
    assert.equal(harness.electronSpawns().length, 0);
    assert.equal(recordOf(harness.logs, 'chat-demo-failed')[0]?.reason, 'fake-exit');
    assert.equal(recordOf(harness.logs, 'chat-demo-done')[0]?.offline_ready, false);
  });

  test('Electron 启动失败：非零退出并清掉 fake', async () => {
    const harness = createHarness();
    const running = harness.run();

    harness.fakeChild.emitStdout(READY_LINE);
    await tick();
    assert.equal(harness.electronSpawns().length, 1);

    harness.electronChild.failWith(new Error('spawn electron EACCES'));
    const code = await running;

    assert.equal(code, 1);
    assert.equal(recordOf(harness.logs, 'chat-demo-failed')[0]?.reason, 'electron-spawn-error');
    assert.deepEqual(harness.fakeChild.kills, ['SIGTERM']);
    assert.equal(recordOf(harness.logs, 'chat-demo-done')[0]?.offline_ready, false);
  });

  test('正常关窗（Electron 退出码 0）：退出码 0，offline_ready 为 true，fake 收尾', async () => {
    const harness = createHarness();
    const running = harness.run();
    await driveToReady(harness);

    harness.electronChild.exitWith(0);
    const code = await running;

    assert.equal(code, 0);
    assert.deepEqual(harness.fakeChild.kills, ['SIGTERM']);
    assert.equal(recordOf(harness.logs, 'electron-exit')[0]?.code, 0);
    const done = recordOf(harness.logs, 'chat-demo-done');
    assert.equal(done.length, 1);
    assert.equal(done[0]?.offline_ready, true);
    assert.equal(done[0]?.exit, 0);
  });

  test('Ctrl-C：两个子进程都清理、退出码 130、信号 handler 被移除', async () => {
    const harness = createHarness();
    const running = harness.run();
    await driveToReady(harness);

    harness.signals.send('SIGINT');
    const code = await running;

    assert.equal(code, 130);
    assert.deepEqual(harness.fakeChild.kills, ['SIGTERM']);
    assert.deepEqual(harness.electronChild.kills, ['SIGTERM']);
    assert.equal(harness.signals.count('SIGINT'), 0);
    assert.equal(harness.signals.count('SIGTERM'), 0);
    assert.equal(recordOf(harness.logs, 'chat-demo-done').length, 1);
  });

  test('SIGTERM：退出码 143 且收尾干净', async () => {
    const harness = createHarness();
    const running = harness.run();
    await driveToReady(harness);

    harness.signals.send('SIGTERM');
    const code = await running;

    assert.equal(code, 143);
    assert.deepEqual(harness.electronChild.kills, ['SIGTERM']);
    assert.deepEqual(harness.fakeChild.kills, ['SIGTERM']);
  });

  test('/healthz 不是 offline_ready：不起 Electron、不报 offline_ready:true', async () => {
    const harness = createHarness({ health: async () => ({ ok: true, status: 200, json: async () => ({ status: 'degraded' }) }) });
    const running = harness.run();

    harness.fakeChild.emitStdout(READY_LINE);
    const code = await running;

    assert.equal(code, 1);
    assert.equal(harness.electronSpawns().length, 0);
    assert.equal(recordOf(harness.logs, 'chat-demo-failed')[0]?.reason, 'fake-health-not-ready');
    assert.ok(!records(harness.logs).some((record) => record.offline_ready === true));
  });

  test('health 请求抛错：非零退出并清理 fake', async () => {
    const harness = createHarness({
      health: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const running = harness.run();

    harness.fakeChild.emitStdout(READY_LINE);
    const code = await running;

    assert.equal(code, 1);
    assert.equal(recordOf(harness.logs, 'chat-demo-failed')[0]?.reason, 'fake-health-failed');
    assert.deepEqual(harness.fakeChild.kills, ['SIGTERM']);
  });

  test('面板加载失败（fail-load）：非零退出且 offline_ready 不为 true', async () => {
    const harness = createHarness();
    const running = harness.run();
    harness.fakeChild.emitStdout(READY_LINE);
    await tick();

    harness.electronChild.emitStdout('{"event":"fail-load","code":-6,"description":"ERR_FILE_NOT_FOUND"}\n');
    const code = await running;

    assert.equal(code, 1);
    assert.equal(recordOf(harness.logs, 'chat-demo-failed')[0]?.reason, 'page-load-failed');
    assert.ok(!records(harness.logs).some((record) => record.offline_ready === true));
  });

  test('面板没渲染前不报 offline_ready:true（即使 Electron 已起）', async () => {
    const harness = createHarness();
    const running = harness.run();
    harness.fakeChild.emitStdout(READY_LINE);
    await tick();
    assert.equal(harness.electronSpawns().length, 1);

    harness.electronChild.emitStdout('{"event":"console","message":"hello"}\n');
    await tick();
    assert.ok(!records(harness.logs).some((record) => record.offline_ready === true));

    harness.electronChild.emitStdout('{"event":"ready"}\n');
    await tick();
    assert.equal(recordOf(harness.logs, 'chat-demo-ready').length, 1);

    harness.electronChild.exitWith(0);
    assert.equal(await running, 0);
  });
});

describe('runDemo 冻结启动参数', () => {
  test('PET_NEXT_CHAT_DEBUG_PORT 合法时传 --remote-debugging-port，userData 原样透传', async () => {
    const harness = createHarness({
      env: { PET_NEXT_CHAT_DEBUG_PORT: '9333', PET_NEXT_USER_DATA: '/tmp/pet-user-data', PET_NEXT_EXTRA: 'kept' },
    });
    const running = harness.run();
    await driveToReady(harness);

    const electron = harness.firstElectron();
    assert.ok(electron, '应当启动 Electron');
    assert.ok(electron.args.includes('--remote-debugging-port=9333'));
    assert.equal(electron.options.env?.PET_NEXT_USER_DATA, '/tmp/pet-user-data');
    assert.equal(electron.options.env?.PET_NEXT_EXTRA, 'kept');
    assert.equal(electron.options.env?.PET_NEXT_CHAT_PREVIEW, '1');
    assert.equal(electron.options.env?.PET_NEXT_CHAT_FAKE_URL, 'http://127.0.0.1:4517');
    assert.equal(electron.options.env?.PET_NEXT_TEST, '1');
    assert.ok(electron.args.some((arg) => arg.endsWith(path.join('dist', 'electron', 'main.js'))));

    harness.electronChild.exitWith(0);
    assert.equal(await running, 0);
  });

  test('未设 debug 端口不加参数；非法端口忽略并记 warn', async () => {
    const withoutPort = createHarness();
    const first = withoutPort.run();
    await driveToReady(withoutPort);
    const plain = withoutPort.firstElectron();
    assert.ok(plain);
    assert.ok(!plain.args.some((arg) => arg.startsWith('--remote-debugging-port=')));
    withoutPort.electronChild.exitWith(0);
    assert.equal(await first, 0);

    const invalid = createHarness({ env: { PET_NEXT_CHAT_DEBUG_PORT: 'abc' } });
    const second = invalid.run();
    await driveToReady(invalid);
    const electron = invalid.firstElectron();
    assert.ok(electron);
    assert.ok(!electron.args.some((arg) => arg.startsWith('--remote-debugging-port=')));
    assert.equal(recordOf(invalid.logs, 'chat-demo-warn')[0]?.reason, 'invalid-debug-port');
    invalid.electronChild.exitWith(0);
    assert.equal(await second, 0);
  });

  test('Electron 路径解析不出来：非零退出，不 spawn 空命令', async () => {
    const harness = createHarness({ electronPath: () => '' });
    const running = harness.run();
    harness.fakeChild.emitStdout(READY_LINE);
    const code = await running;

    assert.equal(code, 1);
    assert.equal(harness.electronSpawns().length, 0);
    assert.equal(recordOf(harness.logs, 'chat-demo-failed')[0]?.reason, 'electron-path-invalid');
  });
});

describe('依赖解析', () => {
  test('resolveElectronPath 取到真实可执行文件路径（回归 require(...).electron 拿到 undefined）', (t) => {
    const petRoot = fileURLToPath(new URL('..', import.meta.url));
    let resolved: string;
    try {
      resolved = resolveElectronPath(petRoot);
    } catch (error) {
      t.skip(`electron 依赖不可用：${String(error)}`);
      return;
    }
    assert.equal(typeof resolved, 'string');
    assert.ok(resolved.length > 0);
    assert.ok(path.isAbsolute(resolved));
  });

  test('parsePort 只接受 1..65535 的整数', () => {
    assert.equal(parsePort('9222'), 9222);
    assert.equal(parsePort(' 1 '), 1);
    assert.equal(parsePort('65535'), 65535);
    for (const invalid of ['', '   ', '0', '65536', '-1', 'abc', '12.5', undefined, null]) {
      assert.equal(parsePort(invalid as unknown as string), null, `应拒绝：${String(invalid)}`);
    }
  });
});
