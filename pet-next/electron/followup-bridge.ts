/**
 * final-demo 跟进预览桥（Electron 主进程侧，客户端）。
 *
 * - 启动或复用同一工作区唯一的跟进宿主（Node 24 子进程，IPC 合作停止）；
 * - 轮询宿主概览，把“当前已送达、待用户决定的 decision”推给桌宠页面（角标/气泡）；
 * - 打开任务面板（宿主提供的页面）与受控报告查看窗；目录选择用系统对话框；
 * - 退出整个应用时：自己启动的宿主走 IPC stop 并等回执；复用的宿主走 POST /api/shutdown。
 * 不提供任意 shell/文件入口：打开产物只接受当前任务、经宿主 SHA 核验、位于 artifacts/<ticket>/ 的文件。
 * @module pet-next/electron/followup-bridge
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import {
  FOLLOWUP_RECORDING_ON_TOP_ENV,
  FOLLOWUP_OPEN_PANEL_CHANNEL,
  FOLLOWUP_OPEN_REPORT_CHANNEL,
  FOLLOWUP_PICK_DIR_CHANNEL,
  FOLLOWUP_QUIT_CHANNEL,
  FOLLOWUP_REVEAL_REPORT_CHANNEL,
  FOLLOWUP_SHOWN_CHANNEL,
  FOLLOWUP_STATE_CHANNEL,
  HOST_DUPLICATE_EXIT,
  HOST_READY_MESSAGE,
  HOST_STOP_RECEIPT,
  HOST_STOP_REQUEST,
  HOST_TOKEN_HEADER,
  type HostLock,
  type PetFollowupState,
} from '../contracts/followup.ts';

export interface FollowupBridgeOptions {
  readonly workspace: string;
  readonly nodePath: string;
  readonly experimentRoot: string;
  readonly demoShortWait: boolean;
  readonly preloadPath: string;
  readonly getPetWindow: () => BrowserWindow | null;
  readonly quit: () => void;
}

export interface FollowupBridge {
  stop(): Promise<void>;
}

interface Connection {
  port: number;
  token: string;
  pid: number;
  owned: boolean;
}

function log(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: `followup-${event}`, ...detail }));
}

function readLock(workspace: string): HostLock | null {
  const file = path.join(workspace, 'state', 'host.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HostLock;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function startFollowupBridge(options: FollowupBridgeOptions): FollowupBridge {
  const workspace = path.resolve(options.workspace);
  mkdirSync(path.join(workspace, 'state'), { recursive: true });
  let connection: Connection | null = null;
  let child: ChildProcess | null = null;
  let childLog: WriteStream | null = null;
  let lastError: string | null = null;
  let stopped = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let panel: BrowserWindow | null = null;
  const viewers = new Map<string, BrowserWindow>();
  let lastState = '';

  const call = async (method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    if (!connection) throw new Error('宿主未连接');
    const response = await fetch(`http://127.0.0.1:${connection.port}${route}`, {
      method,
      headers: { [HOST_TOKEN_HEADER]: connection.token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(4000),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };

  const healthy = async (lock: HostLock): Promise<boolean> => {
    try {
      const response = await fetch(`http://127.0.0.1:${lock.port}/api/health`, {
        headers: { [HOST_TOKEN_HEADER]: lock.token },
        signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { pid?: number };
      return body.pid === lock.pid;
    } catch {
      return false;
    }
  };

  const reuseExisting = async (): Promise<boolean> => {
    const lock = readLock(workspace);
    if (!lock || lock.state !== 'ready' || !pidAlive(lock.pid)) return false;
    if (!(await healthy(lock))) return false;
    connection = { port: lock.port, token: lock.token, pid: lock.pid, owned: false };
    log('host-reused', { pid: lock.pid, port: lock.port, workspace });
    return true;
  };

  const spawnHost = (): Promise<boolean> =>
    new Promise((resolve) => {
      const runMjs = path.join(options.experimentRoot, 'run.mjs');
      const args = ['--experimental-transform-types', '--no-warnings', runMjs, 'host', '--workspace', workspace, '--timezone', 'Asia/Shanghai'];
      if (options.demoShortWait) args.push('--demo-short-wait');
      childLog = createWriteStream(path.join(workspace, 'state', 'host-console.log'), { flags: 'a' });
      const proc = spawn(options.nodePath, args, {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      });
      child = proc;
      proc.stdout?.pipe(childLog, { end: false });
      proc.stderr?.pipe(childLog, { end: false });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        lastError = '宿主 20 秒内没有就绪';
        log('host-timeout', {});
        resolve(false);
      }, 20_000);
      proc.on('message', (message: unknown) => {
        const typed = message as { type?: string; port?: number; token?: string; pid?: number };
        if (typed?.type === HOST_READY_MESSAGE && !settled) {
          settled = true;
          clearTimeout(timer);
          connection = { port: Number(typed.port), token: String(typed.token), pid: Number(typed.pid), owned: true };
          log('host-ready', { pid: typed.pid, port: typed.port, workspace, nodePath: options.nodePath, demoShortWait: options.demoShortWait });
          resolve(true);
        }
      });
      proc.on('error', (error) => {
        lastError = `宿主启动失败：${error.message}`;
        log('host-error', { error: error.message });
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
      proc.on('exit', (code, signal) => {
        log('host-exit', { code, signal, owned: true });
        child = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          if (code === HOST_DUPLICATE_EXIT) {
            void reuseExisting().then(resolve);
            return;
          }
          lastError = `宿主退出（code=${String(code)}），见 ${path.join(workspace, 'state', 'host-console.log')}`;
          resolve(false);
          return;
        }
        if (!stopped) {
          lastError = `宿主意外退出（code=${String(code)}）`;
          connection = null;
        }
      });
    });

  const pushState = (state: PetFollowupState): void => {
    const text = JSON.stringify(state);
    if (text === lastState) return;
    lastState = text;
    const win = options.getPetWindow();
    if (win && !win.isDestroyed()) win.webContents.send(FOLLOWUP_STATE_CHANNEL, state);
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    if (!connection) {
      pushState({ connected: false, error: lastError ?? '正在连接跟进宿主…', pendingCount: 0, activeCount: 0, top: null });
      return;
    }
    try {
      const { json } = await call('GET', '/api/overview');
      const pending = (json.pending as { ticketId: string; title: string; decision: { decisionId: string; question: string } }[]) ?? [];
      const tasks = (json.tasks as { status: string }[]) ?? [];
      const top = pending[0];
      pushState({
        connected: true,
        error: null,
        pendingCount: pending.length,
        activeCount: tasks.filter((task) => task.status === 'active').length,
        top: top ? { ticketId: top.ticketId, title: top.title, decisionId: top.decision.decisionId, question: top.decision.question } : null,
      });
    } catch (error) {
      pushState({ connected: false, error: `宿主无响应：${(error as Error).message}`, pendingCount: 0, activeCount: 0, top: null });
    }
  };

  const hostOrigin = (): string => (connection ? `http://127.0.0.1:${connection.port}` : '');

  const lockNavigation = (win: BrowserWindow): void => {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${hostOrigin()}/`)) event.preventDefault();
    });
  };

  /** 录制辅助（仅 PET_FOLLOWUP_RECORDING_ON_TOP=1，默认关闭）：面板/报告窗置顶，避免录屏时被其他桌面窗口遮挡；不改变任何跟进语义。 */
  const recordingOnTop = process.env[FOLLOWUP_RECORDING_ON_TOP_ENV] === '1';
  const openPanel = (ticketId?: string): void => {
    if (!connection) return;
    const query = new URLSearchParams({ token: connection.token, ...(ticketId ? { ticket: ticketId } : {}) });
    const url = `${hostOrigin()}/panel?${query.toString()}`;
    if (panel && !panel.isDestroyed()) {
      void panel.loadURL(url);
      panel.show();
      panel.focus();
      log('panel-focus', { ticketId: ticketId ?? null });
      return;
    }
    panel = new BrowserWindow({
      width: 1180,
      height: 800,
      x: 420,
      y: 60,
      title: '跟进任务',
      alwaysOnTop: recordingOnTop,
      autoHideMenuBar: true,
      backgroundColor: '#0f1217',
      webPreferences: { preload: options.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    lockNavigation(panel);
    panel.on('closed', () => {
      panel = null;
      log('panel-closed', {});
    });
    void panel.loadURL(url);
    log('panel-open', { ticketId: ticketId ?? null });
  };

  const fromPanel = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    Boolean(panel && !panel.isDestroyed() && event.sender === panel.webContents);
  const fromPet = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean => {
    const win = options.getPetWindow();
    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents);
  };

  const verifiedReport = async (ticketId: string): Promise<{ ok: boolean; error?: string; abs?: string; path?: string; sha256?: string }> => {
    const { status, json } = await call('GET', `/api/report?ticket=${encodeURIComponent(ticketId)}`);
    if (status !== 200 || json.ok !== true) return { ok: false, error: String(json.error ?? `HTTP ${status}`) };
    const abs = path.resolve(String(json.abs));
    const allowed = path.join(workspace, 'artifacts', ticketId);
    const rel = path.relative(allowed, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !existsSync(abs)) return { ok: false, error: '产物不在当前任务的受控目录' };
    return { ok: true, abs, path: String(json.path), sha256: String(json.sha256) };
  };

  ipcMain.removeHandler(FOLLOWUP_PICK_DIR_CHANNEL);
  ipcMain.removeHandler(FOLLOWUP_OPEN_REPORT_CHANNEL);
  ipcMain.removeHandler(FOLLOWUP_REVEAL_REPORT_CHANNEL);
  ipcMain.on(FOLLOWUP_OPEN_PANEL_CHANNEL, (event, ticketId: unknown) => {
    if (!fromPet(event) && !fromPanel(event)) return;
    openPanel(typeof ticketId === 'string' && ticketId ? ticketId : undefined);
  });
  ipcMain.on(FOLLOWUP_SHOWN_CHANNEL, (event, payload: unknown) => {
    if (!fromPet(event) || !connection) return;
    const record = payload as { ticketId?: unknown; decisionId?: unknown };
    if (typeof record?.ticketId !== 'string' || typeof record.decisionId !== 'string') return;
    void call('POST', '/api/pet-shown', { ticketId: record.ticketId, decisionId: record.decisionId })
      .then(({ status }) => log('pet-shown', { ticketId: record.ticketId, decisionId: record.decisionId, status }))
      .catch(() => undefined);
  });
  ipcMain.handle(FOLLOWUP_PICK_DIR_CHANNEL, async (event) => {
    if (!fromPanel(event) || !panel) return null;
    const defaultPath = path.join(workspace, 'results');
    mkdirSync(defaultPath, { recursive: true });
    const picked = await dialog.showOpenDialog(panel, {
      title: '选择要跟进的结果目录（须在工作区内）',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    log('pick-dir', { canceled: picked.canceled, path: picked.filePaths[0] ?? null });
    return picked.canceled ? null : picked.filePaths[0] ?? null;
  });
  ipcMain.handle(FOLLOWUP_OPEN_REPORT_CHANNEL, async (event, ticketId: unknown) => {
    if (!fromPanel(event) || typeof ticketId !== 'string' || !connection) return { ok: false, error: '无效请求' };
    const report = await verifiedReport(ticketId);
    if (!report.ok) return report;
    const existing = viewers.get(ticketId);
    if (existing && !existing.isDestroyed()) existing.close();
    const viewer = new BrowserWindow({
      width: 860,
      height: 760,
      x: 1000,
      y: 140,
      alwaysOnTop: recordingOnTop,
      title: `分析报告 · ${report.path ?? ''}`,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    lockNavigation(viewer);
    viewers.set(ticketId, viewer);
    viewer.on('closed', () => viewers.delete(ticketId));
    const query = new URLSearchParams({ token: connection.token, ticket: ticketId });
    void viewer.loadURL(`${hostOrigin()}/report-view?${query.toString()}`);
    log('report-open', { ticketId, path: report.path, sha256: report.sha256 });
    return { ok: true, path: report.path, sha256: report.sha256 };
  });
  ipcMain.handle(FOLLOWUP_REVEAL_REPORT_CHANNEL, async (event, ticketId: unknown) => {
    if (!fromPanel(event) || typeof ticketId !== 'string') return { ok: false, error: '无效请求' };
    const report = await verifiedReport(ticketId);
    if (!report.ok || !report.abs) return report;
    shell.showItemInFolder(report.abs);
    log('report-reveal', { ticketId, path: report.path });
    return { ok: true, path: report.path };
  });
  ipcMain.on(FOLLOWUP_QUIT_CHANNEL, (event) => {
    if (!fromPanel(event) && !fromPet(event)) return;
    log('quit-requested', {});
    options.quit();
  });

  void (async () => {
    const ok = (await reuseExisting()) || (await spawnHost());
    if (!ok) log('host-unavailable', { error: lastError });
    await poll();
    pollTimer = setInterval(() => void poll(), 1000);
  })();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      for (const viewer of viewers.values()) if (!viewer.isDestroyed()) viewer.destroy();
      if (panel && !panel.isDestroyed()) panel.destroy();
      const proc = child as ChildProcess | null;
      if (proc && proc.connected) {
        const requestId = `quit-${Date.now()}`;
        const receipt = await new Promise<unknown>((resolve) => {
          const timer = setTimeout(() => resolve(null), 8000);
          proc.on('message', (message: unknown) => {
            if ((message as { type?: string })?.type === HOST_STOP_RECEIPT) {
              clearTimeout(timer);
              resolve(message);
            }
          });
          proc.on('exit', () => {
            clearTimeout(timer);
            resolve(null);
          });
          proc.send({ type: HOST_STOP_REQUEST, requestId });
        });
        log('host-stopped', { receipt: receipt ?? null, cooperative: receipt !== null });
        if (receipt === null && proc.exitCode === null) proc.kill();
      } else if (connection && !connection.owned) {
        try {
          await call('POST', '/api/shutdown', {});
          log('host-shutdown-requested', { pid: connection.pid });
        } catch (error) {
          log('host-shutdown-failed', { error: (error as Error).message });
        }
      }
      childLog?.end();
    },
  };
}
