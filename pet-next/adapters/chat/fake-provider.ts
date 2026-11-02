/**
 * M3-0 受控假 Provider：手动 resolve/reject/观察 abort，供单测竞态使用。
 * 不引入延时：complete 挂起直到测试方显式驱动，竞态顺序完全由测试控制。
 * @module pet-next/adapters/chat/fake-provider
 */
import type { ChatProvider } from '../../contracts/chat.ts';

export interface FakeProviderCall {
  id: string;
  text: string;
  signal: AbortSignal;
}

export interface FakeChatProvider extends ChatProvider {
  /** 已收到的调用。 */
  readonly calls: FakeProviderCall[];
  /** 等待下一次 complete 被调用。 */
  nextCall(): Promise<FakeProviderCall>;
  /** 手动成功：驱动最早一个未决调用。 */
  resolve(text: string): void;
  /** 手动失败：驱动最早一个未决调用。 */
  reject(error: unknown): void;
  /** signal 被触发的调用次数。 */
  abortedCount(): number;
}

export function createFakeChatProvider(): FakeChatProvider {
  const calls: FakeProviderCall[] = [];
  const waiters: Array<(call: FakeProviderCall) => void> = [];
  const pending: Array<{ resolve: (text: string) => void; reject: (error: unknown) => void }> = [];
  let consumed = 0;
  let aborted = 0;

  return {
    calls,
    complete(input) {
      input.signal.addEventListener('abort', () => {
        aborted += 1;
      });
      const call: FakeProviderCall = { id: input.id, text: input.text, signal: input.signal };
      calls.push(call);
      for (const notify of waiters.splice(0)) notify(call);
      return new Promise<string>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    nextCall() {
      if (consumed < calls.length) {
        const call = calls[consumed] as FakeProviderCall;
        consumed += 1;
        return Promise.resolve(call);
      }
      return new Promise((resolve) => {
        waiters.push((call) => {
          consumed += 1;
          resolve(call);
        });
      });
    },
    resolve(text) {
      pending.shift()?.resolve(text);
    },
    reject(error) {
      pending.shift()?.reject(error);
    },
    abortedCount() {
      return aborted;
    },
  };
}
