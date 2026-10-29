/**
 * 预加载桥。只转发移动和退出，不暴露 ipcRenderer。
 * @module pet-next/electron/preload
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pet', {
  moveBy(dx: number, dy: number): void {
    ipcRenderer.send('pet:move-by', { dx, dy });
  },
  quit(): void {
    ipcRenderer.send('pet:quit');
  },
});
