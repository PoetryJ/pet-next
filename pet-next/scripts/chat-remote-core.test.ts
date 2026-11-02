/**
 * M3-2 chat:remote 编排：预检、隧道失败分类、/models 校验、收尾、断线、幂等 stop。
 * 全部注入假隧道/假 runner/假探测，不建真实 SSH、不起 Electron、不请求服务器。
 */
import assert from 'node:assert/strict';
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
  return {
    tunnel,
    events,
    logs,
    errors,
    options: {
      spawn: (() => ({ pid: 1 })) as never,
      env: baseEnv(),
      petRoot: '/nonexistent',
      platform: 'linux',
      sshBin: 'ssh',
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
});

describe('runRemote', () => {
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
