/**
 * M3-2 chat:remote 编排：预检、隧道失败分类、/models 校验、收尾、断线、幂等 stop。
 * 全部使用假子进程/假 runner/假探测，不建真实 SSH、不起 Electron、不请求服务器。
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { describe, test } from 'node:test';
import { runRemote } from './chat-remote-core.mjs';

interface FakeTunnel {
  localBaseUrl: string;
  stopped: number;
  alive: boolean;
  isAlive: () => boolean;
  stop: () => Promise<void>;
}

function fakeTunnel(alive = true): FakeTunnel {
  const handle: FakeTunnel = {
    localBaseUrl: 'http://127.0.0.1:18873',
    stopped: 0,
    alive,
    isAlive: () => handle.alive,
    stop: async () => {
      handle.stopped += 1;
      handle.alive = false;
    },
  };
  return handle;
}

function baseEnv(): Record<string, string> {
  return {
    PET_NEXT_SSH_HOST: 'ssh.example',
    PET_NEXT_SSH_PORT: '10977',
    PET_NEXT_SSH_USER: 'tester',
  };
}

function options(overrides: Record<string, unknown> = {}) {
  const events: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const tunnel = fakeTunnel();
  const signals = new EventEmitter();
  return {
    tunnel,
    events,
    logs,
    errors,
    signals,
    options: {
      spawn: (() => ({ pid: 1 })) as never,
      env: baseEnv(),
      petRoot: '/nonexistent',
      platform: 'linux',
      sshBin: 'ssh',
      signals,
      startTunnelFn: (async () => ({ ok: true, handle: tunnel })) as never,
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
      probeService: async () => ({ ok: true, models: ['qwen3.8-27b'] }),
      localRunner: async () => 0,
      electronExists: () => true,
      log: (line: string) => {
        logs.push(line);
        events.push(JSON.parse(line));
      },
      logError: (line: string) => {
        errors.push(line);
      },
      ...overrides,
    },
  };
}

describe('precheckRemote（经 runRemote 观察）', () => {
  test('缺构建产物 → 非零退出且给出可读中文错误', async () => {
    const ctx = options();
    const code = await runRemote({
      ...ctx.options,
      petRoot: '/definitely-missing',
      electronExists: () => false,
    });
    assert.equal(code, 1);
    assert.ok(ctx.errors.some((line) => line.includes('pnpm build')));
    assert.equal(ctx.events.at(-1)?.event, 'chat-remote-failed');
    assert.equal(ctx.tunnel.stopped, 0);
  });

  test('Node 版本要求与 engines 对齐：22.11 不足、22.12 通过、20 被拒', async () => {
    const cases: Array<{ version: string; ok: boolean }> = [
      { version: '22.11.0', ok: false },
      { version: '22.12.0', ok: true },
      { version: '20.19.0', ok: false },
    ];
    for (const item of cases) {
      const ctx = options();
      let runnerStarted = false;
      const code = await runRemote({
        ...ctx.options,
        nodeVersion: item.version,
        localRunner: async () => {
          runnerStarted = true;
          return 0;
        },
      });
      if (item.ok) {
        assert.equal(code, 0, `${item.version} 应通过预检`);
        assert.equal(runnerStarted, true);
      } else {
        assert.equal(code, 1, `${item.version} 应被预检拒绝`);
        assert.equal(runnerStarted, false);
        const failed = ctx.events.find((e) => e.event === 'chat-remote-failed');
        assert.equal(failed?.reason, 'precheck-failed');
        assert.match(String((failed?.problems as string[]).join(' ')), /22\.12\+/);
      }
    }
  });
});

describe('runRemote', () => {
  test('Windows Node shim 前缀经过真实 startTunnel 到达 spawn，不能把 -N 直接传给 Node', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.ok(address !== null && typeof address === 'object');

    const ctx = options();
    const child = new EventEmitter();
    const kills: string[] = [];
    const spawnedChild = Object.assign(child, {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: (signal: string) => {
        kills.push(signal);
        setImmediate(() => child.emit('exit', 0, null));
        return true;
      },
    });
    const calls: Array<{ bin: string; args: string[] }> = [];
    const shimPath = 'C:/fixture with spaces/fake-ssh.mjs';
    const code = await runRemote({
      ...ctx.options,
      // 不替换 startTunnel：断言生产编排与隧道层连接后的真实 spawn 参数。
      startTunnelFn: undefined,
      fileConfig: { localPort: address.port },
      sshBin: process.execPath,
      sshArgsPrefix: [shimPath],
      spawn: ((bin: string, args: string[]) => {
        calls.push({ bin, args });
        return spawnedChild;
      }) as never,
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.bin, process.execPath);
    assert.deepEqual(calls[0]?.args.slice(0, 2), [shimPath, '-N']);
    assert.ok(calls[0]?.args.includes(`127.0.0.1:${address.port}:127.0.0.1:18872`));
    assert.deepEqual(kills, ['SIGTERM']);
  });

  test('配置缺失 → config-invalid 非零，不建隧道', async () => {
    const ctx = options();
    let started = false;
    const code = await runRemote({
      ...ctx.options,
      env: {},
      startTunnelFn: (async () => {
        started = true;
        return { ok: true, handle: fakeTunnel() };
      }) as never,
    });
    assert.equal(code, 1);
    assert.equal(started, false);
    const failed = ctx.events.find((e) => e.event === 'chat-remote-failed');
    assert.equal(failed?.reason, 'config-invalid');
  });

  test('隧道认证失败 → auth-failed 非零', async () => {
    const ctx = options();
    const code = await runRemote({
      ...ctx.options,
      startTunnelFn: (async () => ({
        ok: false,
        error: { code: 'auth-failed', message: 'SSH 认证失败：请确认密钥已加载' },
      })) as never,
    });
    assert.equal(code, 1);
    assert.ok(ctx.errors.some((line) => line.includes('认证失败')));
    assert.equal(ctx.events.find((e) => e.event === 'chat-remote-failed')?.reason, 'auth-failed');
  });

  test('转发端 /models 缺模型 → probe-failed 非零，且隧道被关闭', async () => {
    const ctx = options();
    const code = await runRemote({
      ...ctx.options,
      probeService: async () => ({ ok: false, error: '缺少模型 qwen3.8-27b' }),
    });
    assert.equal(code, 1);
    assert.equal(ctx.tunnel.stopped, 1);
    assert.equal(ctx.events.find((e) => e.event === 'chat-remote-failed')?.reason, 'probe-failed');
  });

  test('probe-failed 的 done 事件退出码必须与返回码一致（1，而不是 0）', async () => {
    const ctx = options();
    const code = await runRemote({
      ...ctx.options,
      probeService: async () => ({ ok: false, error: '缺少模型 qwen3.8-27b' }),
    });
    assert.equal(code, 1);
    const done = ctx.events.find((e) => e.event === 'chat-remote-done');
    assert.equal(done?.exit, 1, 'done.exit 必须等于真实退出码');
  });

  test('探测阶段 Ctrl-C：返回 130、不启动 runner、隧道关闭、记录 cancelled', async () => {
    const ctx = options();
    let runnerStarted = false;
    const code = await runRemote({
      ...ctx.options,
      probeService: async () => {
        ctx.signals.emit('SIGINT'); // 模拟探测期间用户按 Ctrl-C
        return { ok: true, models: ['qwen3.8-27b'] };
      },
      localRunner: async () => {
        runnerStarted = true;
        return 0;
      },
    });
    assert.equal(code, 130);
    assert.equal(runnerStarted, false, '取消后不得进入 Electron');
    assert.equal(ctx.tunnel.stopped, 1);
    assert.ok(ctx.events.some((e) => e.event === 'chat-remote-cancelled' && e.code === 130));
    assert.ok(!ctx.events.some((e) => e.event === 'chat-remote-ready'), '取消后不得报就绪');
  });

  test('隧道启动阶段 Ctrl-C：返回 130、不启动 runner、隧道关闭', async () => {
    const ctx = options();
    let runnerStarted = false;
    const code = await runRemote({
      ...ctx.options,
      startTunnelFn: (async (_config: unknown, deps: { signal?: AbortSignal }) => {
        ctx.signals.emit('SIGINT'); // 隧道建立过程中被中断
        assert.equal(deps.signal?.aborted, true, '取消信号必须传给隧道层');
        return { ok: true, handle: ctx.tunnel };
      }) as never,
      localRunner: async () => {
        runnerStarted = true;
        return 0;
      },
    });
    assert.equal(code, 130);
    assert.equal(runnerStarted, false);
    assert.equal(ctx.tunnel.stopped, 1);
    assert.ok(ctx.events.some((e) => e.event === 'chat-remote-cancelled' && e.stage === 'tunnel'));
  });

  test('隧道层返回 cancelled：入口退出码 130（而非 1）', async () => {
    const ctx = options();
    const code = await runRemote({
      ...ctx.options,
      startTunnelFn: (async () => ({ ok: false, error: { code: 'cancelled', message: '已取消' } })) as never,
    });
    assert.equal(code, 130);
    assert.ok(ctx.events.some((e) => e.event === 'chat-remote-cancelled'));
  });

  test('运行期 SIGINT 由 runLocal 处理：退出码取 runner 的 130，隧道仍关闭', async () => {
    const ctx = options();
    const code = await runRemote({
      ...ctx.options,
      localRunner: async () => {
        ctx.signals.emit('SIGINT');
        return 130;
      },
    });
    assert.equal(code, 130);
    assert.equal(ctx.tunnel.stopped, 1);
    assert.equal(ctx.events.find((e) => e.event === 'chat-remote-done')?.exit, 130);
  });

  test('成功全链路：事件顺序、model/baseUrl 注入、退出码透传、隧道只停一次', async () => {
    const ctx = options();
    let runnerEnv: Record<string, string> | null = null;
    const code = await runRemote({
      ...ctx.options,
      probeService: async (config: { baseUrl: string; model: string }) => {
        assert.equal(config.baseUrl, 'http://127.0.0.1:18873/v1');
        assert.equal(config.model, 'qwen3.8-27b');
        return { ok: true, models: ['qwen3.8-27b'] };
      },
      localRunner: async (opts: { env: Record<string, string> }) => {
        runnerEnv = opts.env;
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.equal(runnerEnv?.['PET_NEXT_QWEN_BASE_URL'], 'http://127.0.0.1:18873/v1');
    assert.equal(runnerEnv?.['PET_NEXT_QWEN_MODEL'], 'qwen3.8-27b');
    assert.equal(runnerEnv?.['PET_NEXT_CHAT_TRANSPORT'], 'tunnel');
    assert.equal(runnerEnv?.['PET_NEXT_CHAT_LOCAL'], '1');
    const names = ctx.events.map((e) => e.event as string);
    const iConfig = names.indexOf('chat-remote-config');
    const iTunnel = names.indexOf('chat-remote-tunnel');
    const iProbe = names.indexOf('chat-remote-probe');
    const iElectron = names.indexOf('chat-remote-electron-config');
    const iDone = names.indexOf('chat-remote-done');
    assert.ok(iConfig >= 0 && iTunnel > iConfig && iProbe > iTunnel && iElectron > iProbe && iDone > iElectron, names.join(','));
    assert.equal(ctx.tunnel.stopped, 1);
  });

  test('隧道断线：监控触发杀 Electron 且退出码非零、隧道仍被关闭', async () => {
    const ctx = options();
    const tunnel = ctx.tunnel;
    let childKilled = false;
    const code = await runRemote({
      ...ctx.options,
      monitorIntervalMs: 10,
      startTunnelFn: (async () => ({ ok: true, handle: tunnel })) as never,
      localRunner: async (opts: { onChild: (child: { kill: (sig: string) => void }) => void }) => {
        opts.onChild({
          kill: () => {
            childKilled = true;
          },
        });
        tunnel.alive = false;
        await new Promise((r) => setTimeout(r, 80));
        return 0;
      },
    });
    assert.equal(code, 1);
    assert.equal(childKilled, true);
    assert.equal(tunnel.stopped, 1);
    assert.ok(ctx.events.some((e) => e.event === 'chat-remote-tunnel-lost'));
  });

  test('Ctrl-C 退出码透传（130）且隧道关闭', async () => {
    const ctx = options();
    const code = await runRemote({ ...ctx.options, localRunner: async () => 130 });
    assert.equal(code, 130);
    assert.equal(ctx.tunnel.stopped, 1);
  });
});
