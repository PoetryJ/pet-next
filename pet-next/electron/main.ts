/**
 * Electron 主进程骨架。窗口参数和两条 IPC 在这里固定，页面装配随后接入。
 * @module pet-next/electron/main
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.env.PET_NEXT_USER_DATA) {
  app.setPath('userData', process.env.PET_NEXT_USER_DATA);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.disableHardwareAcceleration();
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(root, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  ipcMain.on('pet:quit', () => {
    app.quit();
  });
  win.once('ready-to-show', () => {
    win.show();
  });
  void win.loadFile(path.join(root, 'app/page.html'));
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
