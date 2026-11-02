/**
 * M3-0 会话状态机：至多一在途、按 id 隔离迟到结果、总超时、输入校验与结果截断。
 * 纯状态机：不依赖 Electron、DOM、网络；时间源经 deps.now 注入（默认真实时钟），
 * 超时用 setTimeout 仅作为“检查时钟”的调度时机，判定一律以注入的 now() 对 deadline。
 * @module pet-next/core/chat/session
 */
import {
  CHAT_ID_PATTERN,
  CHAT_MAX_INPUT_CHARS,
  CHAT_MAX_RESULT_CHARS,
  CHAT_TOTAL_TIMEOUT_MS,
  type ChatErrorCode,
  type ChatSendRequest,
  type ChatSendResult,
  type ChatSession,
  type ChatSessionDeps,
} from './types.ts';

/** 在途请求条目：settle 用 once 守卫，迟到结果只可能命中已结算分支而被丢弃。 */
interface PendingEntry {
  id: string;
  controller: AbortController;
  /** 请求级清理：撤计时器并在 entry 仍是当前在途时释放槽位（绝不误清新请求）。 */
  settle(result: ChatSendResult): void;
  /** 外部 cancel 命中本条目时使用：立刻以 cancelled 结算，不等 provider。 */
  settleCancelled(): void;
}

export function createChatSession(deps: ChatSessionDeps): ChatSession {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? CHAT_TOTAL_TIMEOUT_MS;
  const maxInputChars = deps.maxInputChars ?? CHAT_MAX_INPUT_CHARS;
  const maxResultChars = deps.maxResultChars ?? CHAT_MAX_RESULT_CHARS;
  let pending: PendingEntry | null = null;

  function validate(request: ChatSendRequest): ChatErrorCode | null {
    if (request === null || typeof request !== 'object') return 'bad-request';
    if (typeof request.id !== 'string' || !CHAT_ID_PATTERN.test(request.id)) return 'bad-request';
    if (typeof request.text !== 'string') return 'bad-request';
    if (request.text.length === 0) return 'empty';
    if (request.text.length > maxInputChars) return 'too-long';
    return null;
  }

  function clip(text: string): string {
    return text.length > maxResultChars ? text.slice(0, maxResultChars) : text;
  }

  return {
    send(request: ChatSendRequest): Promise<ChatSendResult> {
      const invalid = validate(request);
      const echoId = typeof request?.id === 'string' ? request.id : '';
      if (invalid) return Promise.resolve({ id: echoId, status: 'error', code: invalid });
      if (pending) return Promise.resolve({ id: request.id, status: 'error', code: 'busy' });

      const controller = new AbortController();
      const deadline = now() + timeoutMs;
      let settled = false;
      let timerId: ReturnType<typeof setTimeout> | null = null;

      const outcome = new Promise<ChatSendResult>((resolve) => {
        // entry 先以壳声明、随后回填字段：清理槽位用引用比较而非 id 比较，
        // 这样“取消后立刻用同一个 id 重发”时，旧请求的迟到结算绝不可能清掉新请求。
        const entry: PendingEntry = {
          id: request.id,
          controller,
          settle: () => undefined,
          settleCancelled: () => undefined,
        };
        const settleOnce = (result: ChatSendResult): void => {
          if (settled) return; // 迟到的 provider 结果在此被隔离：只结算一次。
          settled = true;
          if (timerId !== null) clearTimeout(timerId);
          timerId = null;
          if (pending === entry) pending = null; // 不清空后来者。
          resolve(result);
        };
        entry.settle = settleOnce;
        entry.settleCancelled = () => {
          controller.abort();
          settleOnce({ id: request.id, status: 'cancelled' });
        };
        pending = entry;

        // 超时驱动：真实 timer 只负责“醒来看时钟”，判定永远用注入的 now() 对 deadline；
        // 时钟未到点则按剩余量重排（注入慢时钟时可多轮），最终路径仍可被懒检查兜底。
        const armTimeout = (): void => {
          if (settled) return;
          const remaining = deadline - now();
          if (remaining <= 0) {
            controller.abort();
            settleOnce({ id: request.id, status: 'error', code: 'timeout' });
            return;
          }
          timerId = setTimeout(() => {
            timerId = null;
            if (settled) return;
            if (now() >= deadline) {
              controller.abort();
              settleOnce({ id: request.id, status: 'error', code: 'timeout' });
            } else {
              armTimeout();
            }
          }, Math.min(remaining, timeoutMs));
        };

        // 先发起 provider、再装超时：即便 deadline 已到点（如 timeoutMs=0），
        // provider 也已被发起过并可被 abort，而不是从未调用。
        let providerPromise: Promise<string>;
        try {
          providerPromise = deps.complete({ id: request.id, text: request.text, signal: controller.signal });
        } catch (error) {
          providerPromise = Promise.reject(error); // 同步抛出同样映射 provider-error。
        }
        armTimeout();

        providerPromise.then(
            (text) => {
              if (now() >= deadline) {
                // 总超时先于 provider 成功到期：懒检查兜底（signal 可能已被 abort）。
                controller.abort();
                settleOnce({ id: request.id, status: 'error', code: 'timeout' });
                return;
              }
              settleOnce({ id: request.id, status: 'ok', text: clip(text) });
            },
            () => {
              if (controller.signal.aborted && !settled) {
                // cancel 已经由 settleCancelled 即时结算；这里是 abort 后 provider 的
                // reject（或迟到 reject），settleOnce 幂等丢弃。
                settleOnce({ id: request.id, status: 'cancelled' });
                return;
              }
              if (now() >= deadline) {
                controller.abort();
                settleOnce({ id: request.id, status: 'error', code: 'timeout' });
                return;
              }
              settleOnce({ id: request.id, status: 'error', code: 'provider-error' });
            },
          )
          .catch(() => {
            // 理论不可达：then 的两个分支均不抛；防御性吞掉以护住状态机。
          });
      });
      return outcome;
    },

    cancel(id: string): void {
      if (pending && pending.id === id) {
        const entry = pending;
        pending = null; // 立即释放槽位：随后 send 可马上发起新请求。
        entry.settleCancelled();
      }
    },
    hasPending(): boolean {
      return pending !== null;
    },
  };
}
