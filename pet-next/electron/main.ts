/**
 * Electron 主进程：透明置顶窗、工作区夹紧和退出。
 * 页面只通过 preload 的 moveBy / quit 进来，这里不提供通用 IPC。
 * @module pet-next/electron/main
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWindowController } from '../adapters/window/controller.ts';
import type { WindowBounds, WorkArea } from '../adapters/window/types.ts';
import { createQwenChatProvider } from '../adapters/chat/qwen-provider.ts';
import { createChatHistory } from '../core/chat/history.ts';
import { createChatSession } from '../core/chat/session.ts';
import {
  CHAT_CONTEXT_ENV,
  CHAT_EXPERIENCE_ENV,
  CHAT_FAKE_URL_ENV,
  CHAT_INFO_CHANNEL,
  CHAT_LOCAL_ENV,
  CHAT_LOCAL_TOKEN,
  CHAT_PREVIEW_ENV,
  CHAT_PREVIEW_QUERY,
  CHAT_PREVIEW_TOKEN,
  CHAT_TRANSPORT_ENV,
  COMPANION_EXPERIENCE,
  type ChatDisplayInfo,
  type ChatExperience,
  type ChatTransport,
} from '../contracts/chat.ts';
import { parsePreview, PREVIEW_ENV, PREVIEW_QUERY } from '../contracts/preview.ts';
import { IDLE_PAUSE_QUERY, idlePauseEnabled } from '../contracts/idle-suspension.ts';
import { attachWindowVisibility } from './window-visibility.ts';
import {
  LAUNCHER_LOAD_CHANNEL,
  LAUNCHER_MODE_ENV,
  LAUNCHER_PROBE_CHANNEL,
  LAUNCHER_SAVE_CHANNEL,
  LAUNCHER_START_CHANNEL,
  type LauncherConfig,
  type LauncherController,
  type LauncherStartOptions,
} from '../contracts/launcher.ts';
import { createNodeLauncherController } from '../adapters/launcher/node.ts';
import { resolveQwenConfig } from './chat-config.ts';
import { launcherRunOptions } from './launcher-run-options.ts';
import { registerChatService, type ChatServiceHandle } from './chat-service.ts';
import { logReady } from './ready-report.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW_WIDTH = 320;
const WINDOW_HEIGHT = 240;
let chatHandle: ChatServiceHandle | null = null;
/** M3-7：launcher 模式单例（未配置/未启动时为 null）。 */
let launcherController: LauncherController | null = null;
let launcherWindow: BrowserWindow | null = null;
/** 启动页已把用户送进桌宠：阻止重复进入，也用于退出清理只做一次。 */
let launcherQuitting = false;

if (process.env.PET_NEXT_USER_DATA) {
  app.setPath('userData', process.env.PET_NEXT_USER_DATA);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.disableHardwareAcceleration();
}

function workAreaFor(bounds: WindowBounds): WorkArea {
  return screen.getDisplayMatching(bounds).workArea;
}

/** launcher 启动成功后注入的连接（不再从 env 读，避免启动页与进程环境互相污染）。 */
interface LocalChatOverride {
  baseUrl: string;
  model: string;
  experience: ChatExperience | undefined;
  context: boolean;
  /** 本次选择的行为/短片令牌；存在 override 时窗口只认它，绝不读父 env。 */
  preview?: string;
}

interface LocalChatOptions extends LocalChatOverride {
  transport: ChatTransport;
}

/** env local 路径与 launcher 路径共用同一套聊天接线，避免两套逻辑漂移。 */
function setupLocalChat(win: BrowserWindow, options: LocalChatOptions): void {
  const provider = createQwenChatProvider({ baseUrl: options.baseUrl, model: options.model });
  // M3-3：显式开启时才启用有界历史；历史只存在主进程内存。
  const session = options.context
    ? createChatSession({ complete: (input) => provider.complete(input), history: createChatHistory() })
    : undefined;
  const info: ChatDisplayInfo = {
    mode: 'local',
    model: options.model,
    transport: options.transport,
    context: options.context,
    ...(options.experience ? { experience: options.experience } : {}),
  };
  ipcMain.handle(CHAT_INFO_CHANNEL, () => info);
  console.log(
    JSON.stringify({
      event: 'chat-mode',
      mode: 'local',
      model: options.model,
      transport: options.transport,
      context: options.context,
      ...(options.experience ? { experience: options.experience } : {}),
    }),
  );
  void registerChatService({
    getWindow: () => win,
    ...(session ? { session } : { provider }),
    onClose() {
      chatHandle = null;
    },
  }).then((handle) => {
    chatHandle = handle;
  });
}

function createWindow(chatOverride?: LocalChatOverride): void {
  const area = screen.getPrimaryDisplay().workArea;
  const windowOptions = {
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: Math.round(area.x + 80),
    y: Math.round(area.y + 80),
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
  } as const;
  const win = new BrowserWindow({
    ...windowOptions,
    webPreferences: {
      preload: path.join(root, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // M3-9：显式节能预览（默认关闭）。preview 只取本次 override，和下方 loadFile 用同一份。
  const preview = chatOverride ? chatOverride.preview : process.env[PREVIEW_ENV];
  const idlePauseRequested = idlePauseEnabled();
  const idlePauseApplies = idlePauseRequested && parsePreview(preview).playback === 'single';
  if (idlePauseRequested && !idlePauseApplies) {
    // 双槽模式不启用该预览：明确记录原因，不静默降级。
    console.log(JSON.stringify({ event: 'idle-pause-skip', reason: 'two-slot' }));
  }
  // 开关关闭时这里为 null：不注册任何窗口监听、不开 IPC handler。
  const idleVisibility = idlePauseApplies ? attachWindowVisibility(win, { ipcMain }) : null;
  win.on('closed', () => {
    idleVisibility?.dispose();
  });

  const controller = createWindowController({
    getBounds: () => win.getBounds(),
    setPosition(x, y) {
      win.setPosition(x, y);
      if (process.env.PET_NEXT_TEST === '1') {
        console.log(JSON.stringify({
          event: 'bounds',
          bounds: win.getBounds(),
          requested: { x, y },
          physical: screen.dipToScreenPoint({ x, y }),
        }));
      }
    },
    workAreaFor,
    quit() {
      app.quit();
    },
  });

  ipcMain.on('pet:move-by', (_event, payload: unknown) => {
    if (!isMove(payload)) return;
    controller.moveBy(payload.dx, payload.dy);
  });
  ipcMain.on('pet:quit', () => {
    controller.quit();
  });

  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.log(JSON.stringify({ event: 'fail-load', code, description }));
  });
  win.webContents.on('console-message', (...args: unknown[]) => {
    const message = args
      .map((arg) => {
        if (typeof arg === 'string') return arg;
        if (typeof arg === 'object' && arg !== null && 'message' in arg) {
          return String((arg as { message: unknown }).message);
        }
        return '';
      })
      .find((value) => value.length > 0);
    if (message) console.log(JSON.stringify({ event: 'console', message }));
  });

  win.once('ready-to-show', () => {
    win.show();
    logReady(win, windowOptions.backgroundColor, windowOptions.transparent, workAreaFor(win.getBounds()));
  });

  const query: Record<string, string> = {};
  if (process.env.PET_NEXT_IDLE_URL) query.idle = process.env.PET_NEXT_IDLE_URL;
  if (process.env.PET_NEXT_REACTION_URL) query.reaction = process.env.PET_NEXT_REACTION_URL;
  // M3-7：launcher 启动时 preview/experience 都只取本次 override，
  // 否则父进程残留的 PET_NEXT_PREVIEW / PET_NEXT_EXPERIENCE 会把上一轮的选择带进来。
  if (preview !== undefined && preview !== '') query[PREVIEW_QUERY] = preview;
  // M3-9：只有单槽且开关打开才通知页面订阅窗口快照（页面据此决定是否创建节能对象）。
  if (idlePauseApplies) query[IDLE_PAUSE_QUERY] = '1';
  // M3-6：体验预览缺省 undefined（页面不创建反馈对象，原路径不变）。
  // M3-7：launcher 启动时以用户显式选择为准（standard 显式为 undefined）；否则仍只由 env 决定。
  const experience: ChatExperience | undefined = chatOverride
    ? chatOverride.experience
    : process.env[CHAT_EXPERIENCE_ENV] === COMPANION_EXPERIENCE
      ? COMPANION_EXPERIENCE
      : undefined;
  const chatLocal = process.env[CHAT_LOCAL_ENV];
  const chatPreview = process.env[CHAT_PREVIEW_ENV];
  const localMode = chatLocal !== undefined && chatLocal !== '';
  // M3-1：local 模式连接现有 Qwen 服务；preview 模式仍是 fake 对照。两者互斥，同时设置时 local 优先并告警。
  if (localMode && chatPreview !== undefined && chatPreview !== '') {
    console.log(JSON.stringify({ event: 'chat-mode-warn', reason: 'both-local-and-preview-set', using: 'local' }));
  }
  if (chatOverride) {
    // M3-7 launcher：连接来自启动页用户输入（已探测通过），transport 固定 tunnel。
    query[CHAT_PREVIEW_QUERY] = CHAT_LOCAL_TOKEN;
    setupLocalChat(win, { ...chatOverride, transport: 'tunnel' });
  } else if (localMode) {
    query[CHAT_PREVIEW_QUERY] = CHAT_LOCAL_TOKEN;
    const resolved = resolveQwenConfig(process.env);
    if (!resolved.ok) {
      console.log(JSON.stringify({ event: 'chat-config-error', error: resolved.error }));
      process.exitCode = 1;
      app.quit();
      return;
    }
    // M3-3：显式预览开关（PET_NEXT_CHAT_CONTEXT 非空）时启用当前会话有界历史；
    // 缺省关闭——不创建历史，provider 载荷与 M3-1 完全一致。历史只存在主进程内存。
    const contextEnabled = process.env[CHAT_CONTEXT_ENV] !== undefined && process.env[CHAT_CONTEXT_ENV] !== '';
    // M3-2：chat:remote 编排会设置 transport=tunnel；页面只读展示，拿不到 SSH 配置。
    const transport: ChatTransport = process.env[CHAT_TRANSPORT_ENV] === 'tunnel' ? 'tunnel' : 'direct';
    setupLocalChat(win, {
      baseUrl: resolved.config.baseUrl,
      model: resolved.config.model,
      experience,
      context: contextEnabled,
      transport,
    });
  } else if (chatPreview !== undefined && chatPreview !== '') {
    query[CHAT_PREVIEW_QUERY] = CHAT_PREVIEW_TOKEN;
    const info: ChatDisplayInfo = { mode: 'demo', ...(experience ? { experience } : {}) };
    ipcMain.handle(CHAT_INFO_CHANNEL, () => info);
    console.log(JSON.stringify({ event: 'chat-mode', mode: 'demo', ...(experience ? { experience } : {}) }));
    // M3-0：聊天预览开启时注册受限聊天服务；服务地址只留在主进程，页面只拿到 send/cancel。
    void registerChatService({
      getWindow: () => win,
      ...(process.env[CHAT_FAKE_URL_ENV] ? { url: process.env[CHAT_FAKE_URL_ENV] } : {}),
      onClose() {
        chatHandle = null;
      },
    }).then((handle) => {
      chatHandle = handle;
    });
  }
  void win.loadFile(path.join(root, 'app/page.html'), { query });
}

function isMove(payload: unknown): payload is { dx: number; dy: number } {
  if (typeof payload !== 'object' || payload === null) return false;
  const record = payload as { dx?: unknown; dy?: unknown };
  return (
    typeof record.dx === 'number' &&
    typeof record.dy === 'number' &&
    Number.isFinite(record.dx) &&
    Number.isFinite(record.dy)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** launcher IPC 载荷只做形状校验；字段级合法性由 core/launcher 的白名单校验负责。 */
function parseConfigPayload(payload: unknown): LauncherConfig | null {
  if (!isRecord(payload) || !isRecord(payload.config)) return null;
  return payload.config as unknown as LauncherConfig;
}

function parseProbePayload(payload: unknown): { config: LauncherConfig; model?: string } | null {
  const config = parseConfigPayload(payload);
  if (config === null) return null;
  const rawModel = isRecord(payload) ? payload.model : undefined;
  if (typeof rawModel !== 'string' || rawModel.trim() === '') return { config };
  return { config, model: rawModel.trim() };
}

function parseStartPayload(payload: unknown): { config: LauncherConfig; options: LauncherStartOptions } | null {
  const config = parseConfigPayload(payload);
  const rawOptions = isRecord(payload) ? payload.options : undefined;
  if (config === null || !isRecord(rawOptions)) return null;
  const { experience, chatContext } = rawOptions;
  if (experience !== 'standard' && experience !== 'companion') return null;
  if (typeof chatContext !== 'boolean') return null;
  const rawModel = rawOptions.model;
  const model = typeof rawModel === 'string' && rawModel.trim() !== '' ? rawModel.trim() : undefined;
  return {
    config,
    options: { experience, chatContext, ...(model ? { model } : {}) },
  };
}

/** M3-7 首次启动配置窗口：普通有边框窗口（不是桌宠的透明置顶窗）。 */
function createLauncherWindow(): void {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 560;
  const height = Math.min(760, area.height - 40);
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + Math.max(0, (area.height - height) / 2)),
    show: false,
    frame: true,
    resizable: true,
    alwaysOnTop: false,
    skipTaskbar: false,
    backgroundColor: '#f4f5f7',
    title: 'pet-next 首次启动',
    webPreferences: {
      preload: path.join(root, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  launcherWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.log(JSON.stringify({ event: 'launcher-fail-load', code, description }));
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    launcherWindow = null;
  });
  void win.loadFile(path.join(root, 'app/launcher.html'));
  console.log(JSON.stringify({ event: 'launcher-open' }));
}

/** 四个受限 IPC：load/save/probe/start，其余能力不暴露给启动页。 */
function registerLauncherIpc(): void {
  launcherController ??= createNodeLauncherController();
  const controller = launcherController;

  ipcMain.handle(LAUNCHER_LOAD_CHANNEL, () => controller.loadConfig());
  ipcMain.handle(LAUNCHER_SAVE_CHANNEL, (_event, payload: unknown) => {
    const config = parseConfigPayload(payload);
    if (config === null) {
      return { ok: false, error: { code: 'config-invalid', message: '保存载荷格式错误' } };
    }
    return controller.saveConfig(config);
  });
  ipcMain.handle(LAUNCHER_PROBE_CHANNEL, (_event, payload: unknown) => {
    const parsed = parseProbePayload(payload);
    if (parsed === null) {
      return { ok: false, error: { code: 'config-invalid', message: '测试连接载荷格式错误' } };
    }
    return controller.probe(parsed.config, parsed.model);
  });
  ipcMain.handle(LAUNCHER_START_CHANNEL, async (_event, payload: unknown) => {
    const parsed = parseStartPayload(payload);
    if (parsed === null) {
      return { ok: false, error: { code: 'config-invalid', message: '启动载荷格式错误' } };
    }
    // 启动前再落一次配置：保存失败就不启动，避免"用着旧配置却以为已保存"。
    const saved = await controller.saveConfig(parsed.config);
    if (!saved.ok) return saved;
    const started = await controller.start(parsed.config, parsed.options);
    if (!started.ok) return started;
    // 资源归属：隧道由 controller 持有到退出；启动页销毁，桌宠窗口接管。
    // M3-7：窗口配置由本次选择翻译而来（companion 必须带上 short,behavior，否则页面无 holder.behavior）。
    const run = launcherRunOptions(started.options);
    createWindow({
      baseUrl: started.baseUrl,
      model: started.model,
      experience: run.experience,
      context: run.contextEnabled,
      preview: run.preview,
    });
    console.log(
      JSON.stringify({
        event: 'launcher-started',
        model: started.model,
        experience: started.options.experience,
        context: started.options.chatContext,
        preview: run.preview ?? '',
      }),
    );
    const launcher = launcherWindow;
    launcherWindow = null;
    launcher?.destroy();
    return started;
  });
}

void app.whenReady().then(() => {
  if (process.env[LAUNCHER_MODE_ENV] === '1') {
    registerLauncherIpc();
    createLauncherWindow();
    return;
  }
  createWindow();
});

app.on('before-quit', (event) => {
  chatHandle?.dispose();
  chatHandle = null;
  // M3-7：launcher 模式下隧道由 controller 持有；退出前等它真正收掉本次 ssh 再退。
  if (launcherQuitting || launcherController === null) return;
  launcherQuitting = true;
  event.preventDefault();
  void launcherController.stop().finally(() => {
    app.quit();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
