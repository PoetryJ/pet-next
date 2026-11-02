/**
 * M3-0 会话状态机骨架：冻结公共 API 形状，语义实现由 core/chat 负责人完成。
 * 骨架仅保证可编译与最小直通行为（TODO 标注处为必须补全的语义）：
 * 至多一在途、重复提交不新增调用、取消后迟到结果按 id 隔离、超时、输入校验、结果截断。
 * 不依赖 Electron、DOM、网络、系统时钟（时钟经 deps.now 注入）。
 * @module pet-next/core/chat/session
 */
import {
  CHAT_ID_PATTERN,
  CHAT_MAX_INPUT_CHARS,
  CHAT_MAX_RESULT_CHARS,
  CHAT_TOTAL_TIMEOUT_MS,
  type ChatSendRequest,
  type ChatSendResult,
  type ChatSession,
  type ChatSessionDeps,
} from './types.ts';

export function createChatSession(deps: ChatSessionDeps): ChatSession {
  const timeoutMs = deps.timeoutMs ?? CHAT_TOTAL_TIMEOUT_MS;
  const maxInputChars = deps.maxInputChars ?? CHAT_MAX_INPUT_CHARS;
  const maxResultChars = deps.maxResultChars ?? CHAT_MAX_RESULT_CHARS;
  let pending: { id: string; controller: AbortController } | null = null;

  function validate(request: ChatSendRequest): ChatErrorCode | null {
    // TODO(A): 按 ChatSendRequest 校验 id 形状、空输入、超长。
    if (typeof request.id !== 'string' || !CHAT_ID_PATTERN.test(request.id)) return 'bad-request';
    if (typeof request.text !== 'string') return 'bad-request';
    if (request.text.length === 0) return 'empty';
    if (request.text.length > maxInputChars) return 'too-long';
    return null;
  }

  return {
    async send(request) {
      const invalid = validate(request);
      if (invalid) return { id: request.id, status: 'error', code: invalid };
      // TODO(A): busy 语义——已有在途时返回 error/busy，不新增 complete 调用。
      if (pending) return { id: request.id, status: 'error', code: 'busy' };
      const controller = new AbortController();
      pending = { id: request.id, controller };
      // TODO(A): 超时计时、取消后迟到结果隔离（按 id 匹配才采纳）、结果截断到 maxResultChars、provider 异常映射 provider-error。
      try {
        const text = await deps.complete({ id: request.id, text: request.text, signal: controller.signal });
        const clipped = text.length > maxResultChars ? text.slice(0, maxResultChars) : text;
        return { id: request.id, status: 'ok', text: clipped };
      } catch (error) {
        if (controller.signal.aborted) return { id: request.id, status: 'cancelled' };
        return { id: request.id, status: 'error', code: 'provider-error' };
      } finally {
        pending = null;
      }
      void timeoutMs;
    },
    cancel(id) {
      // TODO(A): 仅当 id 匹配在途请求才取消；随后 send 可立即新请求。
      if (pending && pending.id === id) {
        pending.controller.abort();
        pending = null;
      }
    },
    hasPending() {
      return pending !== null;
    },
  };
}
