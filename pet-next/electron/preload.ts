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

// M3-9 节能预览通道名与 contracts/idle-suspension.ts 保持一致（同样内联）。
const WINDOW_VISIBILITY_CHANNEL = 'pet:window-visibility';
const WINDOW_VISIBILITY_QUERY_CHANNEL = 'pet:window-visibility:query';
// 仅 PET_NEXT_TEST=1 时主进程才注册该 handler；产品路径不调用。
const TEST_WINDOW_CHANNEL = 'pet:test-window';

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

/**
 * M3-9 节能预览：只转发"当前窗口可见性快照"。
 * 主进程在开关关闭时不注册对应 handler，此时 invoke 会 reject；页面已按
 * `idlePause=1` 门控，不会走到该分支；
 * 页面拿不到 ipcRenderer，也不能自己声明隐藏状态。
 */
contextBridge.exposeInMainWorld('petWindowVisibility', {
  query(): Promise<unknown> {
    return ipcRenderer.invoke(WINDOW_VISIBILITY_QUERY_CHANNEL);
  },
  /** 订阅推送，返回注销函数；页面卸载时必须调用。 */
  subscribe(listener: (snapshot: unknown) => void): () => void {
    const handler = (_event: unknown, snapshot: unknown): void => {
      listener(snapshot);
    };
    ipcRenderer.on(WINDOW_VISIBILITY_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(WINDOW_VISIBILITY_CHANNEL, handler);
    };
  },
});

/**
 * M3-9 测试专用：让 e2e 调用真实的 BrowserWindow 动作。
 * 主进程只在 `PET_NEXT_TEST=1` 注册 handler，产品路径从不调用。
 */
contextBridge.exposeInMainWorld('petTestWindow', {
  act(action: string): Promise<unknown> {
    return ipcRenderer.invoke(TEST_WINDOW_CHANNEL, action);
  },
});

/**
 * final-demo 跟进预览桥（桌宠页面与任务面板共用；主进程按 sender 校验来源）。
 * 只有固定动作：订阅状态、打开面板、回报气泡已显示、选目录、打开/定位受控报告、退出。
 * 主进程只在 PET_FOLLOWUP_PREVIEW=1 时注册这些通道；没有任意 IPC、文件或 shell 入口。
 * 通道名与 contracts/followup.ts 保持一致（preload 独立编译，内联）。
 */
const FOLLOWUP_STATE_CHANNEL = 'followup:state';
const FOLLOWUP_OPEN_PANEL_CHANNEL = 'followup:open-panel';
const FOLLOWUP_SHOWN_CHANNEL = 'followup:shown';
const FOLLOWUP_PICK_DIR_CHANNEL = 'followup:pick-dir';
const FOLLOWUP_OPEN_REPORT_CHANNEL = 'followup:open-report';
const FOLLOWUP_REVEAL_REPORT_CHANNEL = 'followup:reveal-report';
const FOLLOWUP_QUIT_CHANNEL = 'followup:quit';

contextBridge.exposeInMainWorld('petFollowup', {
  onState(listener: (state: unknown) => void): () => void {
    const handler = (_event: unknown, state: unknown): void => {
      listener(state);
    };
    ipcRenderer.on(FOLLOWUP_STATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(FOLLOWUP_STATE_CHANNEL, handler);
    };
  },
  openPanel(ticketId?: string): void {
    ipcRenderer.send(FOLLOWUP_OPEN_PANEL_CHANNEL, typeof ticketId === 'string' ? ticketId : '');
  },
  shown(ticketId: string, decisionId: string): void {
    ipcRenderer.send(FOLLOWUP_SHOWN_CHANNEL, { ticketId: String(ticketId), decisionId: String(decisionId) });
  },
  pickDirectory(): Promise<unknown> {
    return ipcRenderer.invoke(FOLLOWUP_PICK_DIR_CHANNEL);
  },
  openReport(ticketId: string): Promise<unknown> {
    return ipcRenderer.invoke(FOLLOWUP_OPEN_REPORT_CHANNEL, String(ticketId));
  },
  revealReport(ticketId: string): Promise<unknown> {
    return ipcRenderer.invoke(FOLLOWUP_REVEAL_REPORT_CHANNEL, String(ticketId));
  },
  quitApp(): void {
    ipcRenderer.send(FOLLOWUP_QUIT_CHANNEL);
  },
});
