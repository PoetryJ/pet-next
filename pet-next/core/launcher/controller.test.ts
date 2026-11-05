/**
 * M3-7 B：launcher 控制器单测（全部注入，不碰真盘/真网络/真 ssh）。
 * 覆盖：配置委托、probe 零 POST 且必收隧道、失败/取消收隧道、busy 防并发、start 保留隧道、stop 幂等。
 * @module pet-next/core/launcher/controller.test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLauncherController,
  type LauncherProbeService,
  type LauncherStartTunnel,
} from './controller.ts';
import type { LauncherConfigIo } from './config.ts';
import type { LauncherConfig, LauncherTunnelSpec } from './types.ts';

const config: LauncherConfig = {
  host: 'fake.example.invalid',
  port: 22,
  user: 'tester',
  localPort: 18873,
  remoteHost: '127.0.0.1',
  remotePort: 18872,
};

const fetchStub = (() => Promise.reject(new Error('测试不得打真网络'))) as unknown as typeof fetch;

const validate = (raw: unknown) => {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false as const, error: { code: 'config-invalid' as const, message: '配置必须是 JSON 对象' } };
  }
  const record = raw as Partial<LauncherConfig>;
  if (typeof record.host !== 'string' || record.host === '') {
    return { ok: false as const, error: { code: 'config-invalid' as const, message: '缺少 SSH 主机' } };
  }
  return { ok: true as const, config: record as LauncherConfig };
};

const resolveTunnel = (value: LauncherConfig): { ok: true; spec: LauncherTunnelSpec } => ({
  ok: true,
  spec: { ...value, connectTimeoutSec: 8, readyTimeoutMs: 20_000 },
});

function memoryIo(initial: string | null): LauncherConfigIo & { text: () => string | null } {
  let stored = initial;
  return {
    async readFile() {
      if (stored === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return stored;
    },
    async writeFileAtomic(_file, text) {
      stored = text;
    },
    async ensureParent() {
      /* 内存实现无需建目录 */
    },
    text: () => stored,
  };
}

interface TunnelControl {
  startTunnel: LauncherStartTunnel;
  stops: () => number;
  lastSpec: () => LauncherTunnelSpec | null;
}

function makeTunnel(
  options: { failWith?: { code: 'auth-failed'; message: string }; hangUntilAbort?: boolean } = {},
): TunnelControl {
  let stops = 0;
  let lastSpec: LauncherTunnelSpec | null = null;
  const startTunnel: LauncherStartTunnel = async (spec, deps) => {
    lastSpec = spec;
    if (options.hangUntilAbort) {
      await new Promise<void>((resolve) => {
        if (deps.signal.aborted) return resolve();
        deps.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false, error: { code: 'cancelled', message: '已取消' } };
    }
    if (options.failWith) return { ok: false, error: options.failWith };
    return {
      ok: true,
      handle: {
        localBaseUrl: 'http://127.0.0.1:18873',
        stop: async () => {
          stops += 1;
        },
        isAlive: () => true,
      },
    };
  };
  return { startTunnel, stops: () => stops, lastSpec: () => lastSpec };
}

function makeProbe(result: { ok: boolean; error?: string; models?: string[] }): {
  probeService: LauncherProbeService;
  calls: () => number;
  baseUrls: string[];
} {
  let calls = 0;
  const baseUrls: string[] = [];
  const probeService: LauncherProbeService = async (probeConfig) => {
    calls += 1;
    baseUrls.push(probeConfig.baseUrl);
    return result;
  };
  return { probeService, calls: () => calls, baseUrls };
}

/** 直接注入隧道/探测实现：新回归用例需要可控句柄、可观测存活与迟到返回。 */
function controllerForRun(
  startTunnel: LauncherStartTunnel,
  probeService: LauncherProbeService,
  io: LauncherConfigIo = memoryIo(null),
) {
  return createLauncherController({
    configFile: '/tmp/never-used.json',
    configIo: io,
    validate,
    resolveTunnel,
    startTunnel,
    probeService,
    fetchImpl: fetchStub,
    defaultModel: 'qwen3.8-27b',
  });
}

function controllerOf(
  tunnel: TunnelControl,
  probe: ReturnType<typeof makeProbe>,
  io: LauncherConfigIo = memoryIo(null),
) {
  return controllerForRun(tunnel.startTunnel, probe.probeService, io);
}

interface LiveTunnel extends TunnelControl {
  alive: () => boolean;
}

/** 句柄可观测存活：断言取消/失败路径不留活隧道、也不重复停。 */
function makeLiveTunnel(options: { dead?: boolean } = {}): LiveTunnel {
  let stops = 0;
  let alive = true;
  const startTunnel: LauncherStartTunnel = async () => ({
    ok: true,
    handle: {
      localBaseUrl: 'http://127.0.0.1:18873',
      stop: async () => {
        stops += 1;
        alive = false;
      },
      isAlive: () => (options.dead ? false : alive),
    },
  });
  return { startTunnel, stops: () => stops, lastSpec: () => null, alive: () => alive };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('loadConfig/saveConfig 委托给注入的配置 IO；无效配置不覆盖旧文件', async () => {
  const io = memoryIo(null);
  const controller = controllerOf(makeTunnel(), makeProbe({ ok: true, models: [] }), io);
  assert.deepEqual(await controller.loadConfig(), { ok: true, config: null });

  assert.deepEqual(await controller.saveConfig(config), { ok: true });
  assert.ok(io.text()?.includes('fake.example.invalid'));
  const reloaded = await controller.loadConfig();
  assert.equal(reloaded.ok, true);
  assert.deepEqual(reloaded.ok ? reloaded.config : null, config);

  const before = io.text();
  const invalid = await controller.saveConfig({ ...config, host: '' });
  assert.equal(invalid.ok, false);
  assert.equal(!invalid.ok && invalid.error.code, 'config-invalid');
  assert.equal(io.text(), before, '校验失败不得触碰旧文件');
});

test('probe 成功：只走注入探测（零 POST 语义），成功也收掉本次隧道', async () => {
  const tunnel = makeTunnel();
  const probe = makeProbe({ ok: true, models: ['qwen3.8-27b'] });
  const controller = controllerOf(tunnel, probe);
  const result = await controller.probe(config);
  assert.deepEqual(result, { ok: true, model: 'qwen3.8-27b', models: ['qwen3.8-27b'] });
  assert.equal(probe.calls(), 1);
  assert.equal(probe.baseUrls[0], 'http://127.0.0.1:18873/v1');
  assert.equal(tunnel.stops(), 1, '探测完成必须收隧道');
  assert.equal(controller.state().phase, 'idle');
  assert.equal(tunnel.lastSpec()?.localPort, 18873);
});

test('probe 探测失败：返回 service-unavailable 并收掉隧道', async () => {
  const tunnel = makeTunnel();
  const probe = makeProbe({ ok: false, error: '服务未提供模型 qwen3.8-27b' });
  const controller = controllerOf(tunnel, probe);
  const result = await controller.probe(config);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'service-unavailable');
  assert.match(!result.ok ? result.error.message : '', /未提供模型/);
  assert.equal(tunnel.stops(), 1);
});

test('隧道启动失败：错误码原样透传，不产生多余 stop', async () => {
  const tunnel = makeTunnel({ failWith: { code: 'auth-failed', message: 'SSH 认证失败' } });
  const controller = controllerOf(tunnel, makeProbe({ ok: true, models: [] }));
  const result = await controller.probe(config);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'auth-failed');
  assert.equal(tunnel.stops(), 0);
});

test('操作进行中再次 probe/start 直接 busy，不并发两套资源', async () => {
  let release!: (value: { ok: boolean; models?: string[] }) => void;
  const pending = new Promise<{ ok: boolean; models?: string[] }>((resolve) => {
    release = resolve;
  });
  const probeService: LauncherProbeService = () => pending;
  const tunnel = makeTunnel();
  const controller = createLauncherController({
    configFile: '/tmp/never-used.json',
    configIo: memoryIo(null),
    validate,
    resolveTunnel,
    startTunnel: tunnel.startTunnel,
    probeService,
    fetchImpl: fetchStub,
    defaultModel: 'qwen3.8-27b',
  });
  const first = controller.probe(config);
  const second = await controller.probe(config);
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.error.code, 'busy');
  const startWhileProbing = await controller.start(config, { experience: 'standard', chatContext: false });
  assert.equal(!startWhileProbing.ok && startWhileProbing.error.code, 'busy');
  release({ ok: true, models: ['qwen3.8-27b'] });
  assert.equal((await first).ok, true);
  assert.equal(tunnel.stops(), 1);
});

test('start 成功保留隧道，stop 幂等收尾且状态回 idle', async () => {
  const tunnel = makeTunnel();
  const probe = makeProbe({ ok: true, models: ['qwen3.8-27b'] });
  const controller = controllerOf(tunnel, probe);
  const result = await controller.start(config, { experience: 'companion', chatContext: true });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.baseUrl : '', 'http://127.0.0.1:18873/v1');
  assert.deepEqual(result.ok ? result.options : null, { experience: 'companion', chatContext: true, model: 'qwen3.8-27b' });
  assert.equal(tunnel.stops(), 0, 'start 后隧道必须保留到 stop');
  assert.equal(controller.state().phase, 'running');

  const again = await controller.start(config, { experience: 'standard', chatContext: false });
  assert.equal(!again.ok && again.error.code, 'busy');

  await controller.stop();
  assert.equal(tunnel.stops(), 1);
  assert.equal(controller.state().phase, 'idle');
  await controller.stop();
  assert.equal(tunnel.stops(), 1, 'stop 幂等：第二次不重复停');
});

test('stop 取消进行中的 start：返回 cancelled，隧道无残留', async () => {
  const tunnel = makeTunnel({ hangUntilAbort: true });
  const controller = controllerOf(tunnel, makeProbe({ ok: true, models: [] }));
  const started = controller.start(config, { experience: 'standard', chatContext: false });
  await Promise.resolve();
  assert.equal(controller.state().phase, 'starting');
  await controller.stop();
  const result = await started;
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'cancelled');
  assert.equal(controller.state().phase, 'idle');
  assert.equal(tunnel.stops(), 0, '未拿到句柄时不会多调 stop');
});

test('隧道已成功但 /models 未返回时 stop：取消结果、stop 恰一次、无存活句柄', async () => {
  const tunnel = makeLiveTunnel();
  const gate = deferred<{ ok: boolean; models?: string[] }>();
  const entered = deferred<void>();
  let seenSignal: AbortSignal | undefined;
  const probeService: LauncherProbeService = (_probeConfig, _fetchImpl, signal) => {
    seenSignal = signal;
    entered.resolve();
    return gate.promise;
  };
  const controller = controllerForRun(tunnel.startTunnel, probeService);

  const starting = controller.start(config, { experience: 'companion', chatContext: false });
  await entered.promise;
  assert.equal(controller.state().phase, 'starting');

  const stopping = controller.stop();
  gate.resolve({ ok: true, models: ['qwen3.8-27b'] });
  const started = await starting;
  await stopping;

  assert.equal(started.ok, false);
  assert.equal(!started.ok && started.error.code, 'cancelled');
  assert.equal(seenSignal?.aborted, true, '/models 探测必须收到本次操作的取消信号');
  assert.equal(tunnel.stops(), 1, 'stop 必须恰回收一次已取得的句柄');
  assert.equal(tunnel.alive(), false, '不得留下活句柄');
  assert.equal(controller.state().phase, 'idle');
});

test('隧道已成功但 /models 未返回时 stop：probe 也返回 cancelled 且只停一次', async () => {
  const tunnel = makeLiveTunnel();
  const gate = deferred<{ ok: boolean; models?: string[] }>();
  const entered = deferred<void>();
  const probeService: LauncherProbeService = () => {
    entered.resolve();
    return gate.promise;
  };
  const controller = controllerForRun(tunnel.startTunnel, probeService);

  const probing = controller.probe(config);
  await entered.promise;
  const stopping = controller.stop();
  gate.resolve({ ok: true, models: ['qwen3.8-27b'] });
  const result = await probing;
  await stopping;

  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'cancelled');
  assert.equal(tunnel.stops(), 1);
  assert.equal(tunnel.alive(), false);
  assert.equal(controller.state().phase, 'idle');
});

test('忽略 abort 的迟到成功：start/probe 仍返回 cancelled 且句柄已关闭', async () => {
  const startTunnel = makeLiveTunnel();
  const startGate = deferred<void>();
  const startEntered = deferred<void>();
  const ignoringProbe: LauncherProbeService = async () => {
    startEntered.resolve();
    await startGate.promise; // 完全无视 signal，迟到返回 ok
    return { ok: true, models: ['qwen3.8-27b'] };
  };
  const startController = controllerForRun(startTunnel.startTunnel, ignoringProbe);
  const starting = startController.start(config, { experience: 'companion', chatContext: false });
  await startEntered.promise;
  const stoppingStart = startController.stop();
  startGate.resolve();
  const started = await starting;
  await stoppingStart;
  assert.equal(started.ok, false, '取消后不得把存活句柄交给 start');
  assert.equal(!started.ok && started.error.code, 'cancelled');
  assert.equal(startTunnel.stops(), 1);
  assert.equal(startTunnel.alive(), false);
  assert.equal(startController.state().phase, 'idle');

  const probeTunnel = makeLiveTunnel();
  const probeGate = deferred<void>();
  const probeEntered = deferred<void>();
  const lateProbe: LauncherProbeService = async () => {
    probeEntered.resolve();
    await probeGate.promise;
    return { ok: true, models: ['qwen3.8-27b'] };
  };
  const probeController = controllerForRun(probeTunnel.startTunnel, lateProbe);
  const probing = probeController.probe(config);
  await probeEntered.promise;
  const stoppingProbe = probeController.stop();
  probeGate.resolve();
  const probed = await probing;
  await stoppingProbe;
  assert.equal(probed.ok, false, '取消后 probe 不得返回 ok');
  assert.equal(!probed.ok && probed.error.code, 'cancelled');
  assert.equal(probeTunnel.stops(), 1);
  assert.equal(probeTunnel.alive(), false);
});

test('probeService 抛错：返回 service-unavailable、句柄已关闭不泄漏', async () => {
  const tunnel = makeLiveTunnel();
  const probeService: LauncherProbeService = () => {
    throw new Error('探测炸了');
  };
  const controller = controllerForRun(tunnel.startTunnel, probeService);

  const result = await controller.probe(config);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'service-unavailable');
  assert.match(!result.ok ? result.error.message : '', /探测炸了/);
  assert.equal(tunnel.stops(), 1);
  assert.equal(tunnel.alive(), false);
  assert.equal(controller.state().phase, 'idle');
  assert.deepEqual(await controller.probe(config), {
    ok: false,
    error: { code: 'service-unavailable', message: '探测 http://127.0.0.1:18873/v1/models 失败：探测炸了' },
  });
});

test('探测成功但句柄已死：返回 not-ready 并回收句柄', async () => {
  const tunnel = makeLiveTunnel({ dead: true });
  const controller = controllerForRun(tunnel.startTunnel, makeProbe({ ok: true, models: ['qwen3.8-27b'] }).probeService);

  const result = await controller.start(config, { experience: 'standard', chatContext: false });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.error.code, 'not-ready');
  assert.equal(tunnel.stops(), 1);
  assert.equal(controller.state().phase, 'idle');
});

test('取消中并发双 stop：两个 stop 都 resolve，句柄只停一次', async () => {
  const tunnel = makeLiveTunnel();
  const gate = deferred<{ ok: boolean; models?: string[] }>();
  const entered = deferred<void>();
  const probeService: LauncherProbeService = () => {
    entered.resolve();
    return gate.promise;
  };
  const controller = controllerForRun(tunnel.startTunnel, probeService);

  const starting = controller.start(config, { experience: 'standard', chatContext: false });
  await entered.promise;
  const first = controller.stop();
  const second = controller.stop();
  gate.resolve({ ok: true, models: ['qwen3.8-27b'] });
  await Promise.all([first, second]);
  const started = await starting;

  assert.equal(started.ok, false);
  assert.equal(!started.ok && started.error.code, 'cancelled');
  assert.equal(tunnel.stops(), 1, '并发 stop 也只停一次');
  assert.equal(tunnel.alive(), false);
  assert.equal(controller.state().phase, 'idle');
});
