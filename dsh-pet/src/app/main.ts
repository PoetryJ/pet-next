/**
 * dsh-pet 独立应用主进程 —— 「双击就能跑」的桌宠应用入口（单进程）。
 *
 * 它把三件事装进**同一个 Electron 进程**（不再 spawn 第二个 electron.exe）：
 *   1. 本机 HTTP 服务：插件宿主半边注册的路由 + 独立模式那套「配置页 / 状态页」；
 *   2. 插件宿主半边：`apply()` 跑在 `src/standalone/context.ts` 造的最小伪 ctx 上；
 *   3. 桌面窗口：直接 `require` 现成的 `runtime/electron-helper/main.js`，窗口、托盘、拖拽、碰撞、
 *      DPI 补偿全部沿用桌面模式那一套，没有第二份实现。
 *
 * HTTP 面与 `dsh-pet-standalone`（CLI）保持一致，因为右键「打开 AI 设置」打开的就是这些地址：
 *   GET  /                      落地页（版本、配置路径、宠物清单）
 *   GET  /health                JSON 状态
 *   GET  /standalone-ai/        AI 配置页（HTML，与 CLI 同一份 settingsPage）
 *   GET/POST /standalone-ai/settings   读写配置（需 X-DSH-Pet-Token，令牌在地址的 #token= 里）
 *   POST /standalone-ai/test    连通性测试
 *   *    /dsh-pet-7340/...      插件路由（桌面窗口用，因此额外放行 CORS）
 *
 * 与 CLI 的一处差异：插件路由要服务 `file://` 页面，浏览器请求不带令牌，所以这一组只按
 * Origin 判定（允许空 / null，拒绝网页来源），不套令牌；配置页那组仍然严格校验令牌与 Host。
 *
 * 环境变量（应用自身用，不影响 DSH 内运行）：
 *   DSH_PET_IN_PROCESS=1  交给宿主半边：不 spawn helper、不下载 Electron（见 src/host/index.ts）
 *   DSH_PET_APP_MODE=1    交给 helper：托盘加「退出」、userData 独立
 *   DSH_PET_SITE_URL      交给 helper：右键「打开网站」用它（这里指向带令牌的配置页）
 */
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir } from '../host/helper-process';
import { apply } from '../host/index';
import { createStandaloneAi } from '../standalone/ai-provider';
import { packageVersion } from '../standalone/check';
import { createStandaloneContext, createStandaloneLogger, type RegisteredRoute } from '../standalone/context';
import { configPathsFor } from '../standalone/options';
import { createRequestSecurity, rejectRequest } from '../standalone/request-security';
import type { RequestSecurity } from '../standalone/request-security';
import { settingsHandler, testHandler } from '../standalone/server';
import { settingsPage, settingsScript, settingsStyle } from '../standalone/settings-page';
import type { StandaloneAiService } from '../standalone/ai-provider';

/**
 * `electron` 由 Electron 运行时提供，**不是本包的依赖**。只声明实际用到的成员：
 * 静态 `import 'electron'` 会让 `tsc --noEmit` 找不到类型而整仓变红。
 */
interface WebContentsLike {
  on(
    event: 'console-message',
    listener: (event: unknown, level: number, message: string, line: number, sourceId: string) => void,
  ): void;
}
interface ElectronApp {
  requestSingleInstanceLock(): boolean;
  exit(code?: number): void;
  on(event: 'web-contents-created', listener: (event: unknown, contents: WebContentsLike) => void): void;
  on(event: 'second-instance', listener: () => void): void;
  on(event: 'will-quit', listener: () => void): void;
}
const { app } = createRequire(import.meta.url)('electron') as { app: ElectronApp };

/** lib/app.js → 包根（与 helper-process.ts 的 packageRoot 同一口径：模块所在目录的上一级） */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const helperMain = join(packageRoot, 'runtime', 'electron-helper', 'main.js');

const log = (message: string): void => console.log(`[dsh-pet-app] ${message}`);

/** 单实例：第二次双击直接退出（共用 userData 的 Chromium profile 会互踢） */
const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.exit(0);
} else {
  await boot();
}

/**
 * 启动应用。`await` 在最外层：端口必须在 `require(helperMain)` 之前确定，因为 helper 在
 * `app.whenReady()` 里就要用 `DSH_PET_CONFIG_URL` / `DSH_PET_SITE_URL`；而它又必须在 ready
 * 之前被 require（内部有 `app.commandLine.appendSwitch`，ready 后再加不生效）。
 */
async function boot(): Promise<void> {
  const logger = createStandaloneLogger();
  const routes: RegisteredRoute[] = [];
  let port = 0;

  // 与 CLI 同一套安全模型：令牌只经「配置页地址的 #token=」递到浏览器，不进日志
  const security = createRequestSecurity();
  const ai = createStandaloneAi(dshHomeDir(), logger);
  const context = createStandaloneContext({
    port: () => port,
    logger,
    routes,
    ai,
    authenticatedUrl: security.authenticatedUrl,
  });

  const server = await startRouter(routes, { security, ai });
  port = server.port;
  const origin = `http://127.0.0.1:${port}`;
  log(`本机服务 ${origin}`);

  // 先把「我自己就是应用」告诉插件，再 apply：apply 内部据此短路 spawn 与下载
  process.env.DSH_PET_IN_PROCESS = '1';
  process.env.DSH_PET_APP_MODE = '1';
  process.env.DSH_PET_OPEN_TARGET = 'site';
  // 不注入宿主 PID：helper 的「宿主没了就退出」只对双进程有意义，同进程里设了会自己杀自己
  delete process.env.DSH_PET_HOST_PID;
  process.env.DSH_PET_CONFIG_URL = `${origin}/dsh-pet-7340/config`;
  // 右键「打开网站」用它：带令牌的配置页（与 CLI 行为一致）。裸 origin 在应用里没有页面可看。
  process.env.DSH_PET_SITE_URL = security.authenticatedUrl(origin);
  if (!process.env.DSH_PET_SCALE) process.env.DSH_PET_SCALE = '1';

  apply(context.ctx);
  log(`apply() 完成：routes=${routes.length} 失败=${context.failures.length}`);

  // helper 读它决定建几个窗口；读不到时它会回落到单个默认窗口，首帧再由渲染端自校正
  process.env.DSH_PET_PETS = JSON.stringify(desktopPets());

  // 同一个进程里跑 helper：建窗、托盘、IPC、碰撞全在它内部完成（CJS，需要 require）
  // 渲染端日志必须转出来：打包后的应用没有控制台，渲染端报错只会表现成「窗口透明」。
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (_e, level, message, line, source) => {
      log(`渲染端[${level}] ${message} (${source}:${line})`);
    });
  });
  createRequire(import.meta.url)(helperMain);

  app.on('second-instance', () => log('已有一个实例在运行，忽略本次启动'));
  app.on('will-quit', () => {
    void ai.dispose();
    void context.dispose().catch(() => undefined);
    void server.close().catch(() => undefined);
  });
}

/**
 * 桌面可见宠物清单（[{id,size}]）。
 * 与 `src/host/index.ts` 的 isDesktopVisible 同口径：display 含 desktop/both 才建窗。
 */
function desktopPets(): Array<{ id: string; size: number }> {
  try {
    const pets = flattenPetList(readAllConfig(configPathsFor(packageRoot, dshHomeDir())));
    const desktop = pets
      .filter((pet) => pet.display === 'desktop' || pet.display === 'both')
      .map((pet) => ({ id: String(pet.id), size: Number(pet.size) }));
    log(`桌面宠物 ${JSON.stringify(desktop)}`);
    return desktop;
  } catch (error) {
    log(`读配置失败（回落单窗）：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

interface RouterDeps {
  security: RequestSecurity;
  ai: StandaloneAiService;
}

/**
 * 本机 HTTP 面：插件路由 + 独立模式那套「状态 / 配置页」。
 *
 * 为什么不能直接把 `listenStandaloneServer` 搬来用：它的 `authorize()` 要求请求带 Host 校验
 * 与同源 Origin，而桌面窗口是 `file://` 页面（Origin 为 `null`、Sec-Fetch-Site 为 cross-site），
 * 会被它整组拒掉。所以这里按**两类请求分开**处理：配置页走完整的安全模型，插件路由只做
 * 「拒绝网页来源」这一条（否则本机任意网页都能调 /whisper、/chat 花掉模型额度）。
 */
function startRouter(
  routes: RegisteredRoute[],
  deps: RouterDeps,
): Promise<{ port: number; close: () => Promise<void> }> {
  const settings = settingsHandler(deps.ai);
  const tester = testHandler(deps.ai);
  /** 监听后才知道端口：落地页/状态页要显示它 */
  let boundPort = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // ---- 配置页：与 CLI 完全一致（静态资源公开，读写接口要令牌）----
    if (url.pathname === '/standalone-ai/') {
      sendText(res, 200, 'text/html', settingsPage);
      return;
    }
    if (url.pathname === '/standalone-ai/settings.js') {
      sendText(res, 200, 'text/javascript', settingsScript);
      return;
    }
    if (url.pathname === '/standalone-ai/settings.css') {
      sendText(res, 200, 'text/css', settingsStyle);
      return;
    }
    if (url.pathname === '/standalone-ai/settings' || url.pathname === '/standalone-ai/test') {
      if (!deps.security.authorize(req, res)) return;
      const handler = url.pathname === '/standalone-ai/test' ? tester : settings;
      void handler(req, res).catch((error: unknown) => {
        log(`配置页接口失败 ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) rejectRequest(res, 500, '配置页暂时无法处理请求');
        else res.end();
      });
      return;
    }

    // ---- 状态与落地页 ----
    if (url.pathname === '/health') {
      sendJson(res, status(boundPort));
      return;
    }
    if (url.pathname === '/') {
      sendText(res, 200, 'text/html', landingPage(boundPort));
      return;
    }

    // ---- 插件路由（桌面窗口）----
    const route = routes.find((candidate) =>
      candidate.kind === 'exact'
        ? url.pathname === candidate.path
        : url.pathname === candidate.path || url.pathname.startsWith(`${candidate.path}/`),
    );
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null') {
      // 来自网页的跨站请求：本机任意网站都能打这几个端点（含 /chat、/whisper 会花钱）
      rejectRequest(res, 403, '不允许网页来源访问');
      return;
    }
    // 窗口是 file:// 页面，属于跨源请求：插件 handler 不写 CORS，这里统一补
    res.setHeader('access-control-allow-origin', '*');
    Promise.resolve(route.handler(req, res)).catch((error: unknown) => {
      log(`路由失败 ${url.pathname}: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      boundPort = address.port;
      resolvePromise({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function status(port: number): Record<string, unknown> {
  const paths = configPathsFor(packageRoot, dshHomeDir());
  let pets: Array<Record<string, unknown>> = [];
  try {
    pets = flattenPetList(readAllConfig(paths));
  } catch {
    /* 落地页/状态接口不该因配置坏掉而 500：下面如实显示 0 只 */
  }
  return {
    name: 'dsh-pet-app',
    version: packageVersion(packageRoot),
    pid: process.pid,
    port,
    pluginRoot: packageRoot,
    configFile: paths.userFile,
    pets: pets.map((pet) => ({ id: pet.id, name: pet.name, display: pet.display })),
  };
}

/** 落地页：取代以前的 `not found`。配置项只能改文件，真正的可视化配置在 /standalone-ai/。 */
function landingPage(port: number): string {
  const info = status(port);
  const pets = (info.pets as Array<Record<string, unknown>>) ?? [];
  const petLines = pets.length
    ? pets.map((pet) => `<li>${escapeHtml(String(pet.name ?? pet.id))}（${escapeHtml(String(pet.display))}）</li>`).join('')
    : '<li>（未读到宠物，检查配置文件）</li>';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>dsh-pet</title>
<style>
  body{font:14px/1.7 "Segoe UI",system-ui,sans-serif;margin:0;padding:32px;background:#f6f8fa;color:#1f2328}
  main{max-width:720px;margin:0 auto;background:#fff;border:1px solid #d0d7de;border-radius:12px;padding:28px 32px}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#656d76;margin-bottom:20px}
  h2{font-size:14px;margin:22px 0 6px} code{background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:1px 6px;font-size:12px}
  ul{margin:6px 0;padding-left:20px} a{color:#0969da}
</style></head>
<body><main>
  <h1>dsh-pet 桌宠</h1>
  <div class="sub">版本 ${escapeHtml(String(info.version))} · 端口 ${port}</div>
  <h2>宠物</h2><ul>${petLines}</ul>
  <h2>配置文件</h2>
  <p><code>${escapeHtml(String(info.configFile))}</code></p>
  <p>改完配置后从托盘退出、重新打开应用即可生效（本模式没有「重载配置」菜单）。</p>
  <h2>AI 设置</h2>
  <p>AI 模型与密钥的配置页需要令牌，请<strong>右键桌宠 →「打开 AI 设置」</strong>，会直接打开已授权的页面。</p>
  <h2>状态</h2>
  <p><a href="/health">/health</a> · <a href="/standalone-ai/">配置页（未授权时读写会返回 403）</a></p>
</main></body></html>`;
}

function sendText(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function sendJson(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );
}
