/**
 * M3-0 文字对话预览的冻结接口：IPC 协议、Provider 形状与全队共用常量。
 * 由集成负责人冻结；改动需全员同步。core/chat 按边界规则自含同形状类型，不引用本文件。
 * 原理：纯状态机会话；Provider 是可替换适配器；请求 id 隔离取消后的迟到结果。
 * @module pet-next/contracts/chat
 */

/** 单条输入上限（字符）。所有层共用，超出即拒，不截断。 */
export const CHAT_MAX_INPUT_CHARS = 500;
/** 单次请求总超时（毫秒）。主进程计时，到点取消 Provider 并按 timeout 报告。 */
export const CHAT_TOTAL_TIMEOUT_MS = 15_000;
/** 回复文本上限（字符）。Provider 返回超出时截断到该长度。 */
export const CHAT_MAX_RESULT_CHARS = 2_000;
/** 请求 id 形状。渲染层生成，主进程校验。 */
export const CHAT_ID_PATTERN = /^chat-[a-z0-9-]{1,48}$/;

/** IPC：invoke 通道，页面 -> 主进程发送一条消息。 */
export const CHAT_SEND_CHANNEL = 'chat:send';
/** IPC：单向通道，页面 -> 主进程取消在途请求。 */
export const CHAT_CANCEL_CHANNEL = 'chat:cancel';

/** 预览开关：主进程环境变量存在且非空时，页面查询带 chat=preview 并挂载面板。 */
export const CHAT_PREVIEW_ENV = 'PET_NEXT_CHAT_PREVIEW';
/** 页面查询参数名。 */
export const CHAT_PREVIEW_QUERY = 'chat';
/** 预览令牌值。 */
export const CHAT_PREVIEW_TOKEN = 'preview';
/** 主进程环境变量：本地假服务地址（http://127.0.0.1:port）。未设置时面板发送立即报 provider-error。 */
export const CHAT_FAKE_URL_ENV = 'PET_NEXT_CHAT_FAKE_URL';

/** 错误码。empty/too-long 为输入校验；busy 为已有在途；timeout/provider-error 为链路；bad-request 为 IPC 载荷不合法。 */
export type ChatErrorCode = 'empty' | 'too-long' | 'busy' | 'timeout' | 'provider-error' | 'bad-request';

/** 页面提交的载荷。 */
export interface ChatSendRequest {
  id: string;
  text: string;
}

/** 发送结果。ok/cancelled/error 三态；text 仅 ok 时给出；code 仅 error 时给出。 */
export interface ChatSendResult {
  id: string;
  status: 'ok' | 'cancelled' | 'error';
  text?: string;
  code?: ChatErrorCode;
}

/** 可替换模型适配器。signal 触发后必须停止并 reject/短返回，不得继续占用。 */
export interface ChatProvider {
  complete(input: { id: string; text: string; signal: AbortSignal }): Promise<string>;
}
