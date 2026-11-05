/**
 * 预加载桥。只转发移动和退出，不暴露 ipcRenderer。
 * M3-0/M3-1 聊天：额外暴露 petChat 的 send/cancel/info 受限入口，不暴露任意 IPC 与服务配置。
 * M3-3：新增 reset（新对话：取消在途＋清空主进程历史）；渲染层仍不能提交任何历史/system。
 * @module pet-next/electron/preload
 */
import { contextBridge, ipcRenderer } from 'electron';

// 通道名与 core/chat 契约（contracts/chat.ts）保持一致；preload 是独立编译入口，内联避免运行时依赖。
const CHAT_SEND_CHANNEL = 'chat:send';
const CHAT_CANCEL_CHANNEL = 'chat:cancel';
const CHAT_INFO_CHANNEL = 'chat:info';
const CHAT_RESET_CHANNEL = 'chat:reset';

// M3-7 launcher 通道名与 contracts/launcher.ts 保持一致（同样内联）。
const LAUNCHER_LOAD_CHANNEL = 'launcher:load';
const LAUNCHER_SAVE_CHANNEL = 'launcher:save';
const LAUNCHER_PROBE_CHANNEL = 'launcher:probe';
const LAUNCHER_START_CHANNEL = 'launcher:start';

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
  /** M3-3“新对话”：无载荷单向消息；历史只存在主进程，页面不带任何状态。 */
  reset(): void {
    ipcRenderer.send(CHAT_RESET_CHANNEL);
  },
  /** 只读展示信息（mode/model）；不含服务地址与凭据。 */
  info(): Promise<unknown> {
    return ipcRenderer.invoke(CHAT_INFO_CHANNEL);
  },
});

/**
 * M3-7 首次启动页桥：只转发 load/save/probe/start 四个受限调用。
 * 载荷形状见 contracts/launcher.ts；页面拿不到 ipcRenderer，也读不到配置文件本身。
 */
contextBridge.exposeInMainWorld('petLauncher', {
  loadConfig(): Promise<unknown> {
    return ipcRenderer.invoke(LAUNCHER_LOAD_CHANNEL);
  },
  saveConfig(config: unknown): Promise<unknown> {
    return ipcRenderer.invoke(LAUNCHER_SAVE_CHANNEL, { config });
  },
  probe(config: unknown, model?: string): Promise<unknown> {
    return ipcRenderer.invoke(LAUNCHER_PROBE_CHANNEL, { config, model });
  },
  start(config: unknown, options: unknown): Promise<unknown> {
    return ipcRenderer.invoke(LAUNCHER_START_CHANNEL, { config, options });
  },
});
