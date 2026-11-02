/**
 * M3-0 主进程聊天服务：把冻结的 chat:send / chat:cancel IPC 接到 core 会话与可注入 Provider。
 * 安全边界：只注册这两个通道；sender 必须是主窗口 webContents，否则忽略；载荷形状/长度不合法直接
 * bad-request，不透传 session；url 只在主进程构造 Provider，页面拿不到服务地址。
 * @module pet-next/electron/chat-service
 */
import { createHttpChatProvider } from '../adapters/chat/http-provider.ts';
import {
  CHAT_CANCEL_CHANNEL,
  CHAT_ID_PATTERN,
  CHAT_MAX_INPUT_CHARS,
  CHAT_SEND_CHANNEL,
  type ChatSendRequest,
  type ChatSendResult,
} from '../contracts/chat.ts';
import { createChatSession } from '../core/chat/session.ts';
import type { ChatCompleter, ChatSession } from '../core/chat/types.ts';

/** 主进程 IPC 事件的最小形状（与 electron IpcMainInvokeEvent 结构兼容）。 */
export interface ChatServiceEvent {
  sender: unknown;
}

/** 主窗口的最小形状：webContents 用于 sender 身份判定，closed 用于关窗取消。 */
export interface ChatServiceWindow {
  readonly webContents: unknown;
  on(event: 'closed', listener: () => void): unknown;
  removeListener(event: 'closed', listener: () => void): unknown;
}

/** ipcMain 的最小形状（electron ipcMain 结构满足；单测注入假实现）。 */
export interface ChatServiceIpc {
  handle(channel: string, listener: (event: ChatServiceEvent, payload: unknown) => unknown): void;
  on(channel: string, listener: (event: ChatServiceEvent, payload: unknown) => void): void;
  removeHandler(channel: string): void;
  removeListener(channel: string, listener: (...args: never[]) => unknown): void;
}

export interface RegisterChatServiceOptions {
  /** 返回主窗口（或 null）。sender 身份判定与 closed 订阅都用它。 */
  getWindow(): ChatServiceWindow | null;
  /** 直接注入会话（单测桩，优先级最高）。 */
  session?: ChatSession;
  /** 注入 Provider：给出则用 core createChatSession 包装。 */
  provider?: ChatCompleter;
  /** 演示服务地址（http://127.0.0.1:port）：给出则内部创建 http provider。 */
  url?: string;
  /** 注入假 ipcMain 用于单测；缺省动态加载 electron 的 ipcMain。 */
  ipcMain?: ChatServiceIpc;
  /** 关窗或 dispose() 时回调（接线方做后续清理）。 */
  onClose?: () => void;
}

export interface ChatServiceHandle {
  /** 暴露给接线方的会话（诊断/复用）；页面不接触。 */
  readonly session: ChatSession;
  /** 取消在途请求、移除两个通道的 handler、退订 closed、触发 onClose（幂等）。 */
  dispose(): void;
}

function offlineProvider(): ChatCompleter {
  return {
    async complete() {
      throw new Error('chat provider 未配置（PET_NEXT_CHAT_FAKE_URL 未设置）');
    },
  };
}

function resolveSession(options: RegisterChatServiceOptions): ChatSession {
  if (options.session) return options.session;
  const provider: ChatCompleter =
    options.provider ?? (options.url ? createHttpChatProvider({ url: options.url }) : offlineProvider());
  return createChatSession({ complete: (input) => provider.complete(input) });
}

/** IPC 载荷校验：id 形状 + text 类型 + 长度上限；不合法返回 null（bad-request，不透传）。 */
export function parseChatSendRequest(payload: unknown): ChatSendRequest | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as { id?: unknown; text?: unknown };
  if (typeof record.id !== 'string' || !CHAT_ID_PATTERN.test(record.id)) return null;
  if (typeof record.text !== 'string' || record.text.length > CHAT_MAX_INPUT_CHARS) return null;
  return { id: record.id, text: record.text };
}

function payloadId(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object' && payload !== null) {
    const id = (payload as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return '';
}

function badRequest(payload: unknown): ChatSendResult {
  return { id: payloadId(payload), status: 'error', code: 'bad-request' };
}

export async function registerChatService(options: RegisterChatServiceOptions): Promise<ChatServiceHandle> {
  const ipc = options.ipcMain ?? ((await import('electron')) as unknown as { ipcMain: ChatServiceIpc }).ipcMain;
  const session = resolveSession(options);
  // 只记录“真正被会话接受”的请求 id：被 busy/empty/too-long 同步拒绝的请求不会建立 pending，
  // 若也写进这里就会覆盖仍在途的请求，导致 dispose/cancel 取消错对象、原请求永不结算。
  let activeRequestId = '';
  let disposed = false;

  const isFromMainWindow = (event: ChatServiceEvent): boolean => {
    const win = options.getWindow();
    return win !== null && event.sender === win.webContents;
  };

  const sendListener = (event: ChatServiceEvent, payload: unknown): Promise<ChatSendResult> | ChatSendResult => {
    if (!isFromMainWindow(event)) return badRequest(payload);
    const request = parseChatSendRequest(payload);
    if (request === null) return badRequest(payload);
    // 只在“无在途 -> 有在途”的接受瞬间记录归属；busy/empty/too-long 的即时拒绝不改写归属。
    const hadPending = session.hasPending();
    const outcome = session.send(request);
    if (!hadPending && session.hasPending()) activeRequestId = request.id;
    return outcome;
  };

  const cancelListener = (event: ChatServiceEvent, payload: unknown): void => {
    if (!isFromMainWindow(event)) return;
    const id = payloadId(payload);
    if (!CHAT_ID_PATTERN.test(id)) return;
    session.cancel(id);
  };

  let closedListener: (() => void) | null = null;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (activeRequestId !== '') session.cancel(activeRequestId);
    ipc.removeHandler(CHAT_SEND_CHANNEL);
    ipc.removeListener(CHAT_CANCEL_CHANNEL, cancelListener as unknown as (...args: never[]) => unknown);
    const win = options.getWindow();
    if (win && closedListener) win.removeListener('closed', closedListener);
    options.onClose?.();
  };

  ipc.handle(CHAT_SEND_CHANNEL, sendListener);
  ipc.on(CHAT_CANCEL_CHANNEL, cancelListener);

  closedListener = () => dispose();
  const win = options.getWindow();
  win?.on('closed', closedListener);

  return { session, dispose };
}
