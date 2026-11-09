/**
 * M3-10 打包入口 E2E：直接以 dist/electron/packaged-main.js 启动 Electron，
 * 证明打包入口自己把进程送进 launcher 配置页（而不是桌宠页），并能走完一次保存+启动。
 *
 * 只由负责人串行运行（真 Electron + Xvfb，默认 :132）：
 *   PET_NEXT_PACKAGED_E2E=1 node --experimental-strip-types --test --test-concurrency=1 \
 *     --test-reporter spec tests/packaged-main.e2e.test.ts
 *
 * 与 tests/launcher/first-run.e2e.test.ts 的差别（那是 launch-trial 入口）：
 * - 这里不许测试代设 PET_NEXT_LAUNCHER：env 里显式删掉，launcher 模式只能由打包入口设置；
 * - HOME 指向临时目录，配置必须落在 $HOME/.pet-next/qwen-remote.json（既有路径，
 *   不得写进应用包），因此不设 PET_NEXT_REMOTE_CONFIG；
 * - 必须是自然退出（关窗 → code 0），失败清理才用进程组 kill。
 * 门：PET_NEXT_PACKAGED_E2E=1 + dist 产物存在 + 显示环境，否则立即 return（skip 不阻断执行）。
 * @module pet-next/tests/packaged-main.e2e
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const bundlePath = path.join(petRoot, 'dist/electron/packaged-main.js');
const fakeSsh = path.join(petRoot, 'tests/support/fake-ssh.mjs');
const fakeModel = path.join(petRoot, 'tests/support/fake-model-service.mjs');
const display = process.env.PET_NEXT_E2E_DISPLAY ?? ':132';
const displaySocket = `/tmp/.X11-unix/X${display.replace(/^:/, '')}`;
const LAUNCHER_URL = 'app/launcher.html';
const PET_URL = 'app/page.html';
const LAUNCHER_TITLE = 'pet-next 首次启动配置';
const CONFIG_RELATIVE = path.join('.pet-next', 'qwen-remote.json');
const enabled = process.env.PET_NEXT_PACKAGED_E2E === '1';
const buildReady = existsSync(bundlePath);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let xvfb: ChildProcess | undefined;
let ownsXvfb = false;
let displayReady = false;

before(async () => {
  if (!enabled || !buildReady) return;
  if (process.platform === 'win32' || existsSync(displaySocket)) {
    displayReady = true;
    return;
  }
  xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  ownsXvfb = true;
  const deadline = Date.now() + 8000;
  while (!existsSync(displaySocket) && Date.now() < deadline) await delay(100);
  displayReady = existsSync(displaySocket);
});

after(async () => {
  if (xvfb === undefined || !ownsXvfb) return;
  xvfb.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    xvfb?.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
});

/** 统一 skip 门槛：返回 false 时必须 return（t.skip 只标注不阻断）。 */
function gate(t: TestContext): boolean {
  if (!enabled) {
    t.skip('not-run: 未显式开启 PET_NEXT_PACKAGED_E2E=1（默认不启 GUI/替身/Xvfb）');
    return false;
  }
  if (!buildReady) {
    t.skip('not-run: 缺少 dist/electron/packaged-main.js（先 pnpm build）');
    return false;
  }
  if (!displayReady) {
    t.skip('not-run: 无显示环境（Xvfb / X11 socket 不可用）');
    return false;
  }
  return true;
}

/* ------------------------------- CDP 最小实现 ------------------------------- */

interface Cdp {
  send(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

async function connectCdp(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  let next = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`cdp connect timeout: ${url}`)), 15000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`cdp connect failed: ${url}`));
    });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message?: string } };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? 'cdp error'));
    else waiter.resolve(message.result);
  });
  ws.addEventListener('close', () => {
    const error = new Error('cdp closed');
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  return {
    send(method, params, timeoutMs = 20000) {
      const id = next + 1;
      next = id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`cdp ${method} timeout`));
        }, timeoutMs);
        pending.set(id, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const result = (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: T };
    exceptionDetails?: { exception?: { description?: string } };
  };
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result?.value as T;
}

interface Target {
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

const targetUrl = (target: Target): string => String(target.url ?? '');
const isLauncherPage = (target: Target): boolean =>
  target.type === 'page' && targetUrl(target).includes(LAUNCHER_URL);
const isPetPage = (target: Target): boolean =>
  target.type === 'page' && targetUrl(target).includes(PET_URL) && !targetUrl(target).startsWith('about:');

async function listTargets(debugPort: number): Promise<Target[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(2000) });
    const list = (await response.json()) as Target[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function waitTarget(
  debugPort: number,
  child: ChildProcess,
  ok: (targets: Target[]) => boolean,
  label: string,
  timeoutMs: number,
): Promise<Target[]> {
  const deadline = Date.now() + timeoutMs;
  let last: Target[] = [];
  while (Date.now() < deadline) {
    last = await listTargets(debugPort);
    if (ok(last)) return last;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`进程提前退出（code=${String(child.exitCode)} signal=${String(child.signalCode)}）：${label}`);
    }
    await delay(150);
  }
  throw new Error(`${label}（${timeoutMs}ms 超时）targets=${JSON.stringify(last.map((item) => item.url))}`);
}

/* ------------------------------- launcher 页面 ------------------------------ */

interface LauncherDom {
  title: string;
  hasForm: boolean;
  phase: string;
  startDisabled: boolean | null;
  host: string;
  user: string;
  localPort: string;
  remotePort: string;
}

const DOM_EXPRESSION = `(() => {
  const read = (selector) => {
    const el = document.querySelector(selector);
    return el instanceof HTMLInputElement ? el.value : '';
  };
  const start = document.querySelector('[data-testid="launcher-start"]');
  return {
    title: document.title,
    hasForm: document.querySelector('[data-testid="launcher"]') !== null,
    phase: document.querySelector('[data-testid="launcher"]')?.dataset.state ?? '',
    startDisabled: start instanceof HTMLButtonElement ? start.disabled : null,
    host: read('[data-testid="launcher-field-host"]'),
    user: read('[data-testid="launcher-field-user"]'),
    localPort: read('[data-testid="launcher-field-localPort"]'),
    remotePort: read('[data-testid="launcher-field-remotePort"]'),
  };
})()`;

async function waitLauncherDom(cdp: Cdp, label: string, ok: (dom: LauncherDom) => boolean, timeoutMs: number): Promise<LauncherDom> {
  const deadline = Date.now() + timeoutMs;
  let last: LauncherDom | undefined;
  while (Date.now() < deadline) {
    try {
      last = await evaluate<LauncherDom>(cdp, DOM_EXPRESSION);
      if (ok(last)) return last;
    } catch {
      /* 页面导航/重绘瞬间，继续轮询 */
    }
    await delay(50);
  }
  throw new Error(`${label}（${timeoutMs}ms 超时）last=${JSON.stringify(last)}`);
}

/** 按 data-testid 填一个文本框：focus + select → Input.insertText → 立刻读回校验。 */
async function fillField(cdp: Cdp, selector: string, text: string): Promise<void> {
  const ok = await evaluate<boolean>(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLInputElement)) return false;
      el.focus();
      el.select();
      return document.activeElement === el;
    })()`,
  );
  if (!ok) throw new Error(`字段 ${selector} 无法聚焦`);
  await cdp.send('Input.insertText', { text });
  const value = await evaluate<string>(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el instanceof HTMLInputElement ? el.value : '';
    })()`,
  );
  assert.equal(value, text, `字段 ${selector} 输入未生效`);
}

async function clickTestId(cdp: Cdp, selector: string): Promise<void> {
  const clicked = await evaluate<boolean>(
    cdp,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!(el instanceof HTMLElement)) return false;
      el.click();
      return true;
    })()`,
  );
  if (!clicked) throw new Error(`目标元素不存在：${selector}`);
}

/* ------------------------------- 进程/端口工具 ------------------------------ */

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      const { port } = address as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
}

function resolveElectron(): string {
  const require = createRequire(path.join(petRoot, 'package.json'));
  const resolved = require('electron') as unknown;
  if (typeof resolved !== 'string' || resolved === '') throw new Error('electron 可执行文件解析失败');
  return resolved;
}

interface PackagedRun {
  child: ChildProcess;
  debugPort: number;
  userData: string;
  home: string;
  output(): string;
  stop(): Promise<void>;
}

interface PackagedOptions {
  /** 预写 $HOME/.pet-next/qwen-remote.json（null = 首次启动）。 */
  config: Record<string, unknown> | null;
  extraEnv?: NodeJS.ProcessEnv;
}

/** 直接以打包入口启动 Electron（不经 launch-trial）：launcher 模式只能由入口自己设置。 */
async function startPackaged(options: PackagedOptions): Promise<PackagedRun> {
  const userData = await mkdtemp(path.join(tmpdir(), 'pet-packaged-userdata-'));
  const home = await mkdtemp(path.join(tmpdir(), 'pet-packaged-home-'));
  if (options.config !== null) {
    const configPath = path.join(home, CONFIG_RELATIVE);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify(options.config, null, 2)}\n`, 'utf8');
  }
  const debugPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PET_NEXT_TEST: '1',
    PET_NEXT_USER_DATA: userData,
    HOME: home,
    USERPROFILE: home,
    ...options.extraEnv,
  };
  // 打包入口必须自己开 launcher；父环境残留的开关/配置/预览一律清掉，否则用例就白跑了。
  delete env.PET_NEXT_LAUNCHER;
  delete env.PET_NEXT_REMOTE_CONFIG;
  delete env.PET_NEXT_CHAT_LOCAL;
  delete env.PET_NEXT_CHAT_PREVIEW;
  delete env.PET_NEXT_EXPERIENCE;
  delete env.PET_NEXT_PREVIEW;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  if (process.platform !== 'win32') env.DISPLAY = display;

  const args = [];
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
  args.push(`--remote-debugging-port=${debugPort}`, bundlePath);
  const child = spawn(resolveElectron(), args, {
    cwd: petRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let out = '';
  child.stdout?.on('data', (chunk) => (out += String(chunk)));
  child.stderr?.on('data', (chunk) => (out += String(chunk)));
  let stopped = false;
  return {
    child,
    debugPort,
    userData,
    home,
    output: () => out,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* 组已退出 */
        }
      }
      if (child.exitCode === null) child.kill('SIGKILL');
      await rm(userData, { recursive: true, force: true }).catch(() => undefined);
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** 关窗 → 自然退出：断言退出码 0，且失败时输出尾部带进错误信息。 */
async function closeAndAssertExitZero(run: PackagedRun, cdp: Cdp): Promise<void> {
  void cdp.send('Browser.close', {}).catch(() => undefined);
  const code = await waitExit(run.child, 90000);
  assert.equal(code, 0, `打包入口必须自然退出 0；实际 ${String(code)}；stdout=${run.output().slice(-1200)}`);
}

/* ---------------------------------- 用例 ---------------------------------- */

test('打包入口 · 直接启动即 launcher 配置页（URL/标题/表单/既有 ~/.pet-next 回填），非桌宠页，关窗退出 0', { timeout: 300000 }, async (t) => {
  if (!gate(t)) return;
  let run: PackagedRun | undefined;
  let cdp: Cdp | undefined;
  try {
    run = await startPackaged({
      config: {
        host: 'refill.example.invalid',
        port: 10977,
        user: 'refiller',
        identityFile: '/tmp/refill-key',
        localPort: 18874,
        remoteHost: '127.0.0.1',
        remotePort: 18872,
      },
    });
    await waitTarget(run.debugPort, run.child, (list) => list.some(isLauncherPage), '未出现 launcher 窗口', 90000);
    const launcher = (await listTargets(run.debugPort)).find(isLauncherPage);
    assert.ok(launcher !== undefined, '必须找到 launcher 页 target');
    assert.ok(targetUrl(launcher).includes(LAUNCHER_URL), `必须加载 ${LAUNCHER_URL}，实际 ${targetUrl(launcher)}`);
    // 硬门：打包入口绝不能先出桌宠页。
    assert.equal(
      (await listTargets(run.debugPort)).filter(isPetPage).length,
      0,
      '打包入口不得创建桌宠窗口（app/page.html）',
    );
    cdp = await connectCdp(launcher.webSocketDebuggerUrl ?? '');
    const dom = await waitLauncherDom(cdp, 'launcher 表单未挂载', (state) => state.hasForm && state.host !== '', 30000);
    assert.equal(dom.title, LAUNCHER_TITLE, 'launcher 页面标题必须正确');
    assert.equal(dom.host, 'refill.example.invalid', '必须回填 $HOME/.pet-next/qwen-remote.json 的 host');
    assert.equal(dom.user, 'refiller', '必须回填既有配置的 user');
    assert.equal(dom.remotePort, '18872', '必须回填既有配置的 remotePort');
    assert.ok(run.output().includes('"event":"launcher-open"'), 'main 必须走到 launcher 分支并记录 launcher-open');
    assert.equal(run.output().includes('"event":"launcher-started"'), false, '未点启动不得进入桌宠流程');
    // 只读路径：回填不得改写配置文件。
    const configPath = path.join(run.home, CONFIG_RELATIVE);
    const raw = readFileSync(configPath, 'utf8');
    assert.equal((JSON.parse(raw) as { host?: string }).host, 'refill.example.invalid');
    assert.equal(
      (await listTargets(run.debugPort)).filter(isPetPage).length,
      0,
      '关窗前仍不得出现桌宠窗口',
    );
    await closeAndAssertExitZero(run, cdp);
    console.log('[packaged-e2e] PASS launcher-page-only exit=0');
  } finally {
    cdp?.close();
    if (run) await run.stop();
  }
});

test('打包入口 · 填表点启动：配置落到 $HOME/.pet-next、进入 app/page.html 桌宠、launcher 销毁、退出 0、零 POST', { timeout: 300000 }, async (t) => {
  if (!gate(t)) return;
  let run: PackagedRun | undefined;
  let cdp: Cdp | undefined;
  let petCdp: Cdp | undefined;
  let fake: ChildProcess | undefined;
  const tempDirs: string[] = [];
  try {
    // fake 模型 + fake ssh：不碰真实 SSH/模型（零 POST 由 fake 日志证实）。
    const fakeDir = await mkdtemp(path.join(tmpdir(), 'pet-packaged-fake-'));
    tempDirs.push(fakeDir);
    const modelLog = path.join(fakeDir, 'requests.ndjson');
    const sshLog = path.join(fakeDir, 'ssh.ndjson');
    let fakeOut = '';
    fake = spawn(process.execPath, [fakeModel], {
      env: { ...process.env, FAKE_MODEL_LOG: modelLog, FAKE_MODEL_MODE: 'ok', FAKE_MODEL_DELAY_MS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const fakePort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake 模型未就绪：${fakeOut}`)), 15000);
      fake?.stdout?.on('data', (chunk) => {
        fakeOut += String(chunk);
        const line = fakeOut.split('\n').find((item) => item.includes('fake-model-ready'));
        if (line === undefined) return;
        clearTimeout(timer);
        resolve((JSON.parse(line.slice(line.indexOf('{'))) as { port: number }).port);
      });
    });
    run = await startPackaged({
      config: null,
      extraEnv: {
        PET_NEXT_SSH_BIN: fakeSsh,
        FAKE_SSH_TARGET_PORT: String(fakePort),
        FAKE_SSH_LOG: sshLog,
        FAKE_MODEL_LOG: modelLog,
      },
    });
    await waitTarget(run.debugPort, run.child, (list) => list.some(isLauncherPage), '未出现 launcher 窗口', 90000);
    const launcher = (await listTargets(run.debugPort)).find(isLauncherPage);
    assert.ok(launcher !== undefined, '必须找到 launcher 页 target');
    cdp = await connectCdp(launcher.webSocketDebuggerUrl ?? '');
    await waitLauncherDom(cdp, 'launcher 表单未挂载', (state) => state.hasForm && state.phase === 'editing', 30000);

    const tunnelPort = await freePort();
    await fillField(cdp, '[data-testid="launcher-field-host"]', 'fake.example.invalid');
    await fillField(cdp, '[data-testid="launcher-field-port"]', '10977');
    await fillField(cdp, '[data-testid="launcher-field-user"]', 'tester');
    await fillField(cdp, '[data-testid="launcher-field-localPort"]', String(tunnelPort));
    await fillField(cdp, '[data-testid="launcher-field-remoteHost"]', '127.0.0.1');
    await fillField(cdp, '[data-testid="launcher-field-remotePort"]', '18872');
    const ready = await waitLauncherDom(cdp, '启动按钮未就绪', (state) => state.startDisabled === false, 30000);
    assert.equal(ready.localPort, String(tunnelPort), 'localPort 必须回显输入值');

    await clickTestId(cdp, '[data-testid="launcher-start"]');
    // 启动前先落盘：配置必须写到 $HOME/.pet-next/qwen-remote.json（既有路径，不写进应用包）。
    const configPath = path.join(run.home, CONFIG_RELATIVE);
    const deadline = Date.now() + 30000;
    while (!existsSync(configPath) && Date.now() < deadline) await delay(100);
    assert.ok(existsSync(configPath), `配置必须落在 ${CONFIG_RELATIVE}；stdout=${run.output().slice(-1200)}`);
    const saved = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    assert.equal(saved.host, 'fake.example.invalid');
    assert.equal(saved.user, 'tester');
    assert.equal(saved.remotePort, 18872);

    const pet = (
      await waitTarget(run.debugPort, run.child, (list) => list.some(isPetPage), '启动后未出现桌宠窗口', 90000)
    ).find(isPetPage);
    assert.ok(pet !== undefined, '启动后必须有 app/page.html 桌宠 target');
    assert.ok(!targetUrl(pet).startsWith('about:'), 'about:blank 不算桌宠窗口');
    petCdp = await connectCdp(pet.webSocketDebuggerUrl ?? '');
    await waitTarget(
      run.debugPort,
      run.child,
      (list) => !list.some(isLauncherPage) && list.some(isPetPage),
      'launcher 窗口未销毁',
      30000,
    );
    assert.ok(run.output().includes('"event":"launcher-started"'), '必须记录 launcher-started');
    const posts = existsSync(modelLog)
      ? readFileSync(modelLog, 'utf8').split('\n').filter((line) => line.includes('"event":"chat-request"')).length
      : 0;
    assert.equal(posts, 0, 'launcher 全链不得发出模型 POST');
    await closeAndAssertExitZero(run, petCdp);
    console.log('[packaged-e2e] PASS launcher-start-to-pet exit=0 POST=0');
  } finally {
    petCdp?.close();
    cdp?.close();
    fake?.kill('SIGTERM');
    if (run) await run.stop();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
