// Electron 沙箱预加载只能使用 CommonJS。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('benchHost', {
  send(message) {
    ipcRenderer.send('bench', message);
  },
  onCommand(listener) {
    ipcRenderer.on('bench-command', (_event, command) => listener(command));
  },
});
