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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WINDOW_WIDTH = 320;
const WINDOW_HEIGHT = 240;

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

function createWindow(): void {
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

  const controller = createWindowController({
    getBounds: () => win.getBounds(),
    setPosition(x, y) {
      win.setPosition(x, y);
      if (process.env.PET_NEXT_TEST === '1') {
        console.log(JSON.stringify({ event: 'bounds', bounds: win.getBounds() }));
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
    const bounds = win.getBounds();
    console.log(
      JSON.stringify({
        event: 'ready',
        alwaysOnTop: win.isAlwaysOnTop(),
        transparent: windowOptions.transparent,
        requestedBackground: windowOptions.backgroundColor,
        background: win.getBackgroundColor(),
        bounds,
        workArea: workAreaFor(bounds),
      }),
    );
  });

  const query: Record<string, string> = {};
  if (process.env.PET_NEXT_IDLE_URL) query.idle = process.env.PET_NEXT_IDLE_URL;
  if (process.env.PET_NEXT_REACTION_URL) query.reaction = process.env.PET_NEXT_REACTION_URL;
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

void app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
