/**
 * M3-0 会话核心的自含类型（core 边界：不引用 core 目录外任何模块）。
 * 形状与 contracts/chat.ts 冻结协议保持一致；由集成负责人冻结，实现归 core/chat。
 * @module pet-next/core/chat/types
 */

/** 请求 id 形状。 */
export const CHAT_ID_PATTERN = /^chat-[a-z0-9-]{1,48}$/;
/** 单条输入上限（字符）。 */
export const CHAT_MAX_INPUT_CHARS = 500;
/** 单次请求总超时（毫秒）。 */
export const CHAT_TOTAL_TIMEOUT_MS = 15_000;
/** 回复文本上限（字符），超出截断。 */
export const CHAT_MAX_RESULT_CHARS = 2_000;

export type ChatErrorCode = 'empty' | 'too-long' | 'busy' | 'timeout' | 'provider-error' | 'bad-request';

export interface ChatSendRequest {
  id: string;
  text: string;
}

export interface ChatSendResult {
  id: string;
  status: 'ok' | 'cancelled' | 'error';
  text?: string;
  code?: ChatErrorCode;
}

/** 一轮成功对话的不可变记录（M3-3 有界历史；形状与 contracts/chat.ts 冻结一致）。 */
export interface ChatHistoryEntry {
  readonly user: string;
  readonly assistant: string;
}

/** 可注入模型适配器：signal 触发后必须尽快停止。history 为请求接受时的只读快照（缺省＝旧单轮行为）。 */
export interface ChatCompleter {
  complete(input: { id: string; text: string; signal: AbortSignal; history?: readonly ChatHistoryEntry[] }): Promise<string>;
}

/** 有界历史仓库形状（实现见 core/chat/history.ts；接口放此处供 deps 注入）。 */
export interface ChatHistoryStore {
  push(user: string, assistant: string): void;
  snapshot(): readonly ChatHistoryEntry[];
  clear(): void;
  turns(): number;
  chars(): number;
}

/** 会话依赖：complete 必填；now/timeoutMs 可注入便于测试（默认真实时钟与冻结常量）；
 * history 可选（M3-3 上下文预览）：提供时成功轮入史并在请求接受时注入快照，缺省完全旧行为。 */
export interface ChatSessionDeps {
  complete: ChatCompleter['complete'];
  now?(): number;
  timeoutMs?: number;
  maxInputChars?: number;
  maxResultChars?: number;
  history?: ChatHistoryStore;
}

/** 冻结的会话公共 API：send 返回终态 Promise；cancel 立即返回；
 * reset 取消在途、清空历史并隔离旧结果（M3-3“新对话”）。 */
export interface ChatSession {
  send(request: ChatSendRequest): Promise<ChatSendResult>;
  cancel(id: string): void;
  /** 是否有在途请求（测试/诊断用）。 */
  hasPending(): boolean;
  /** 重置当前会话：先取消在途（旧结果按既有引用隔离，绝不入史），再清空历史。 */
  reset(): void;
}
