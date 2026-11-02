/**
 * 预加载桥。只转发移动和退出，不暴露 ipcRenderer。
 * M3-0 聊天预览：额外暴露 petChat 的 send/cancel 两个受限入口，不暴露任意 IPC。
 * @module pet-next/electron/preload
 */
import { contextBridge, ipcRenderer } from 'electron';

// 通道名与 core/chat 契约（contracts/chat.ts）保持一致；preload 是独立编译入口，内联避免运行时依赖。
const CHAT_SEND_CHANNEL = 'chat:send';
const CHAT_CANCEL_CHANNEL = 'chat:cancel';

contextBridge.exposeInMainWorld('pet', {
  moveBy(dx: number, dy: number): void {
    ipcRenderer.send('pet:move-by', { dx, dy });
  },
  quit(): void {
    ipcRenderer.send('pet:quit');
  },
});

contextBridge.exposeInMainWorld('petChat', {
  send(payload: { id: string; text: string }): Promise<unknown> {
    return ipcRenderer.invoke(CHAT_SEND_CHANNEL, payload);
  },
  cancel(id: string): void {
    ipcRenderer.send(CHAT_CANCEL_CHANNEL, { id });
  },
});
