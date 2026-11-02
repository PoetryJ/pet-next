/**
 * 主进程聊天服务单测：注入假 ipcMain / 窗口，不启动 Electron 运行时。两段覆盖：
 * 1) 会话桩：sender 非主窗口被忽略、载荷不合法 bad-request 不透传、send/cancel 正确转发、
 *    dispose 移除通道并取消在途、关窗触发清理、url 演示安全。
 * 2) 真实 core 会话（createChatSession + 受控 completer）：活动请求归属——被 busy/empty/
 *    too-long 拒绝的请求不得覆盖仍在途的请求，dispose/cancel 必须命中真正在途的那个。
 * 措辞边界：chat-service 是“可注入会话模块”，不是无时钟组件；注入真实会话时内部仍有真实
 * timer 驱动总超时，用例统一显式放宽 timeoutMs 并在结束前结算，避免遗留计时器。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CHAT_CANCEL_CHANNEL,
  CHAT_SEND_CHANNEL,
  type ChatSendResult,
} from '../contracts/chat.ts';
import type { ChatServiceEvent, ChatServiceIpc, ChatServiceWindow } from './chat-service.ts';
import { parseChatSendRequest, registerChatService } from './chat-service.ts';
import { createChatSession } from '../core/chat/session.ts';
import type { ChatCompleter, ChatSendRequest, ChatSession } from '../core/chat/types.ts';

class FakeIpc implements ChatServiceIpc {
  readonly handled = new Map<string, (event: ChatServiceEvent, payload: unknown) => unknown>();
  readonly listened = new Map<string, Array<(event: ChatServiceEvent, payload: unknown) => void>>();
  readonly removedHandlers: string[] = [];
  readonly removedListeners: Array<{ channel: string }> = [];

  handle(channel, listener): void {
    this.handled.set(channel, listener);
  }

  on(channel, listener): void {
    this.listened.set(channel, [...(this.listened.get(channel) ?? []), listener]);
  }

  removeHandler(channel): void {
    this.removedHandlers.push(channel);
    this.handled.delete(channel);
  }

  removeListener(channel, _listener): void {
    this.removedListeners.push({ channel });
    this.listened.delete(channel);
  }
}

class FakeWindow implements ChatServiceWindow {
  readonly webContents: { tag: string };
  private readonly closedListeners = new Set<() => void>();

  constructor(tag = 'main') {
    this.webContents = { tag };
  }

  on(_event: 'closed', listener: () => void): unknown {
    this.closedListeners.add(listener);
    return this;
  }

  removeListener(_event: 'closed', listener: () => void): unknown {
    this.closedListeners.delete(listener);
    return this;
  }

  close(): void {
    for (const listener of [...this.closedListeners]) listener();
  }
}

interface SessionStub {
  session: ChatSession;
  sends: ChatSendRequest[];
  cancels: string[];
}

/** 会话桩：默认像真实会话一样维护在途槽位（send 同步占槽、cancel 命中即释放）。 */
function createSessionStub(
  result: ChatSendResult = { id: 'chat-x', status: 'ok', text: 'stub' },
  options: { trackPending?: boolean } = {},
): SessionStub {
  const sends: ChatSendRequest[] = [];
  const cancels: string[] = [];
  const trackPending = options.trackPending ?? true;
  let pendingId: string | null = null;
  const session: ChatSession = {
    async send(request) {
      sends.push(request);
      if (trackPending) {
        if (pendingId !== null) return { id: request.id, status: 'error', code: 'busy' };
        pendingId = request.id;
      }
      return { ...result, id: request.id };
    },
    cancel(id) {
      cancels.push(id);
      if (trackPending && pendingId === id) pendingId = null;
    },
    hasPending() {
      return trackPending && pendingId !== null;
    },
  };
  return { session, sends, cancels };
}

function validEvent(window: FakeWindow): ChatServiceEvent {
  return { sender: window.webContents };
}

describe('parseChatSendRequest', () => {
  test('合法载荷通过；形状/形状长度不合法返回 null', () => {
    assert.deepEqual(parseChatSendRequest({ id: 'chat-a', text: 'hi' }), { id: 'chat-a', text: 'hi' });
    assert.equal(parseChatSendRequest(null), null);
    assert.equal(parseChatSendRequest('x'), null);
    assert.equal(parseChatSendRequest({ id: 'bad id', text: 'hi' }), null);
    assert.equal(parseChatSendRequest({ id: 'chat-a', text: 1 }), null);
    assert.equal(parseChatSendRequest({ id: 'chat-a', text: 'a'.repeat(501) }), null);
    assert.deepEqual(parseChatSendRequest({ id: 'chat-a', text: '' }), { id: 'chat-a', text: '' });
  });
});

describe('registerChatService', () => {
  test('sender 非主窗口 webContents -> 忽略，session 不被调用', async () => {
    const ipc = new FakeIpc();
    const window = new FakeWindow();
    const { session, sends } = createSessionStub();
    const handle = await registerChatService({ getWindow: () => window, session, ipcMain: ipc });
    const send = ipc.handled.get(CHAT_SEND_CHANNEL);
    assert.ok(send);
    const result = (await send({ sender: { tag: 'other' } }, { id: 'chat-a', text: 'hi' })) as ChatSendResult;
    assert.deepEqual(result, { id: 'chat-a', status: 'error', code: 'bad-request' });
    assert.equal(sends.length, 0);
    handle.dispose();
  });

  test('载荷不合法 -> bad-request，不透传 session', async () => {
    const ipc = new FakeIpc();
    const window = new FakeWindow();
    const { session, sends } = createSessionStub();
    const handle = await registerChatService({ getWindow: () => window, session, ipcMain: ipc });
    const send = ipc.handled.get(CHAT_SEND_CHANNEL);
    assert.ok(send);
    for (const payload of [null, 'x', { id: 'nope', text: 'hi' }, { id: 'chat-a' }, { id: 'chat-a', text: 7 }, { id: 'chat-a', text: 'a'.repeat(600) }]) {
      const result = (await send(validEvent(window), payload)) as ChatSendResult;
      assert.equal(result.status, 'error');
      assert.equal(result.code, 'bad-request');
    }
    assert.equal(sends.length, 0);
    handle.dispose();
  });

  test('合法 send/cancel 转发到 session；cancel 非法 id 或外来 sender 被忽略', async () => {
    const ipc = new FakeIpc();
    const window = new FakeWindow();
    const { session, sends, cancels } = createSessionStub();
    const handle = await registerChatService({ getWindow: () => window, session, ipcMain: ipc });
    const send = ipc.handled.get(CHAT_SEND_CHANNEL);
    const cancel = ipc.listened.get(CHAT_CANCEL_CHANNEL)?.[0];
    assert.ok(send && cancel);

    const result = (await send(validEvent(window), { id: 'chat-1', text: '你好' })) as ChatSendResult;
    assert.deepEqual(result, { id: 'chat-1', status: 'ok', text: 'stub' });
    assert.deepEqual(sends, [{ id: 'chat-1', text: '你好' }]);

    cancel(validEvent(window), { id: 'chat-1' });
    assert.deepEqual(cancels, ['chat-1']);
    cancel(validEvent(window), { id: 'not-an-id' });
    cancel({ sender: { tag: 'other' } }, { id: 'chat-1' });
    cancel(validEvent(window), 'junk');
    assert.deepEqual(cancels, ['chat-1']);
    handle.dispose();
  });

  test('dispose：移除两个通道、退订 closed、取消最后在途 id、触发 onClose（幂等）', async () => {
    const ipc = new FakeIpc();
    const window = new FakeWindow();
    const { session, cancels } = createSessionStub();
    let closed = 0;
    const handle = await registerChatService({
      getWindow: () => window,
      session,
      ipcMain: ipc,
      onClose: () => {
        closed += 1;
      },
    });
    const send = ipc.handled.get(CHAT_SEND_CHANNEL);
    assert.ok(send);
    void send(validEvent(window), { id: 'chat-last', text: '在途' });
    handle.dispose();
    assert.deepEqual(ipc.removedHandlers, [CHAT_SEND_CHANNEL]);
    assert.deepEqual(ipc.removedListeners.map((entry) => entry.channel), [CHAT_CANCEL_CHANNEL]);
    assert.deepEqual(cancels, ['chat-last']);
    assert.equal(closed, 1);
    handle.dispose();
    assert.equal(closed, 1);
    assert.deepEqual(cancels, ['chat-last']);
  });

  test('窗口 closed -> 自动 dispose（移除通道并触发 onClose）', async () => {
    const ipc = new FakeIpc();
    const window = new FakeWindow();
    const { session } = createSessionStub();
    let closed = 0;
    await registerChatService({
      getWindow: () => window,
      session,
      ipcMain: ipc,
      onClose: () => {
        closed += 1;
      },
    });
    window.close();
    assert.deepEqual(ipc.removedHandlers, [CHAT_SEND_CHANNEL]);
    assert.equal(closed, 1);
  });

  test('url 非回环地址 -> 注册即拒绝（演示安全在主进程构造时生效）', async () => {
    const ipc = new FakeIpc();
    const window = new FakeWindow();
    await assert.rejects(
      registerChatService({ getWindow: () => window, url: 'http://example.com:9000', ipcMain: ipc }),
      /仅允许/,
    );
  });
});

/** 受控 completer：每次调用都挂起，signal 与 resolve/reject 交给用例掌握。 */
interface ControlledCall {
  id: string;
  text: string;
  signal: AbortSignal;
  resolve(text: string): void;
  reject(error: unknown): void;
}

function createControlledCompleter(): { complete: ChatCompleter['complete']; calls: ControlledCall[] } {
  const calls: ControlledCall[] = [];
  return {
    calls,
    complete(input) {
      return new Promise<string>((resolve, reject) => {
        calls.push({ id: input.id, text: input.text, signal: input.signal, resolve, reject });
        input.signal.addEventListener('abort', () => reject(new Error(`aborted:${input.id}`)), { once: true });
      });
    },
  };
}

/** 断言 Promise 在限定时间内结算：漏 cancel 时用例失败，而不是整个套件挂死。 */
async function settleWithin<T>(promise: Promise<T>, label: string, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 未在 ${ms}ms 内结算（在途归属错误导致漏 cancel）`)), ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 真实 core 会话 + 假 ipcMain/窗口：timeoutMs 放宽，避免用例期间被总超时抢先。 */
async function registerWithRealSession(options: { maxInputChars?: number } = {}) {
  const completer = createControlledCompleter();
  const session = createChatSession(
    options.maxInputChars === undefined
      ? { complete: completer.complete, timeoutMs: 60_000 }
      : { complete: completer.complete, timeoutMs: 60_000, maxInputChars: options.maxInputChars },
  );
  const ipc = new FakeIpc();
  const window = new FakeWindow();
  const handle = await registerChatService({ getWindow: () => window, session, ipcMain: ipc });
  const send = ipc.handled.get(CHAT_SEND_CHANNEL);
  const cancel = ipc.listened.get(CHAT_CANCEL_CHANNEL)?.[0];
  assert.ok(send && cancel, 'send/cancel 两个通道都应注册');
  return { completer, session, ipc, window, handle, send, cancel };
}

describe('registerChatService + 真实会话：活动请求归属', () => {
  test('busy 拒绝不覆盖在途 id：dispose 后原请求 signal abort 且 Promise 结算 cancelled', async () => {
    const { completer, session, handle, window, send } = await registerWithRealSession();
    const aSettlement = send(validEvent(window), { id: 'chat-a', text: '第一句' }) as Promise<ChatSendResult>;
    assert.equal(session.hasPending(), true);
    assert.equal(completer.calls.length, 1);

    const busyResult = (await send(validEvent(window), { id: 'chat-b', text: '第二句' })) as ChatSendResult;
    assert.deepEqual(busyResult, { id: 'chat-b', status: 'error', code: 'busy' });
    assert.equal(completer.calls.length, 1, 'busy 拒绝不应发起 provider');

    handle.dispose();

    const aCall = completer.calls[0];
    assert.ok(aCall);
    assert.equal(aCall.id, 'chat-a');
    assert.equal(aCall.signal.aborted, true, 'dispose 应 abort 真正在途的 A');
    assert.deepEqual(await settleWithin(aSettlement, 'A 的 send Promise'), { id: 'chat-a', status: 'cancelled' });
    assert.equal(session.hasPending(), false);
  });

  test('被 empty 拒绝的输入不覆盖在途 id：dispose 后原请求确实 abort', async () => {
    const { completer, handle, window, send } = await registerWithRealSession();
    const aSettlement = send(validEvent(window), { id: 'chat-a', text: '在途' }) as Promise<ChatSendResult>;

    const emptyResult = (await send(validEvent(window), { id: 'chat-b', text: '' })) as ChatSendResult;
    assert.deepEqual(emptyResult, { id: 'chat-b', status: 'error', code: 'empty' });

    handle.dispose();

    const aCall = completer.calls[0];
    assert.ok(aCall);
    assert.equal(aCall.id, 'chat-a');
    assert.equal(aCall.signal.aborted, true);
    assert.deepEqual(await settleWithin(aSettlement, 'A 的 send Promise'), { id: 'chat-a', status: 'cancelled' });
  });

  test('被 too-long 拒绝的输入不覆盖在途 id：dispose 后原请求确实 abort', async () => {
    const { completer, handle, window, send } = await registerWithRealSession({ maxInputChars: 3 });
    const aSettlement = send(validEvent(window), { id: 'chat-a', text: '在途' }) as Promise<ChatSendResult>;

    const tooLongResult = (await send(validEvent(window), { id: 'chat-b', text: '四个字符' })) as ChatSendResult;
    assert.deepEqual(tooLongResult, { id: 'chat-b', status: 'error', code: 'too-long' });

    handle.dispose();

    const aCall = completer.calls[0];
    assert.ok(aCall);
    assert.equal(aCall.id, 'chat-a');
    assert.equal(aCall.signal.aborted, true);
    assert.deepEqual(await settleWithin(aSettlement, 'A 的 send Promise'), { id: 'chat-a', status: 'cancelled' });
  });

  test('取消后发新请求：dispose abort 的是新请求，旧请求已按 cancelled 结算', async () => {
    const { completer, session, handle, window, send, cancel } = await registerWithRealSession();
    const aSettlement = send(validEvent(window), { id: 'chat-a', text: '第一句' }) as Promise<ChatSendResult>;

    cancel(validEvent(window), { id: 'chat-a' });
    assert.deepEqual(await settleWithin(aSettlement, 'A 的 send Promise'), { id: 'chat-a', status: 'cancelled' });
    assert.equal(session.hasPending(), false);

    const cSettlement = send(validEvent(window), { id: 'chat-c', text: '第三句' }) as Promise<ChatSendResult>;
    assert.equal(session.hasPending(), true);
    assert.equal(completer.calls.length, 2);

    handle.dispose();

    const aCall = completer.calls[0];
    const cCall = completer.calls[1];
    assert.ok(aCall && cCall);
    assert.equal(aCall.signal.aborted, true);
    assert.equal(cCall.id, 'chat-c');
    assert.equal(cCall.signal.aborted, true, 'dispose 应 abort 新的在途请求 C');
    assert.deepEqual(await settleWithin(cSettlement, 'C 的 send Promise'), { id: 'chat-c', status: 'cancelled' });
  });

  test('同 id 取消后重发：dispose 结算重发的在途请求，迟到的旧结果被隔离', async () => {
    const { completer, handle, window, send, cancel } = await registerWithRealSession();
    const firstSettlement = send(validEvent(window), { id: 'chat-a', text: '旧' }) as Promise<ChatSendResult>;
    cancel(validEvent(window), { id: 'chat-a' });
    assert.deepEqual(await settleWithin(firstSettlement, '旧 chat-a 的 send Promise'), { id: 'chat-a', status: 'cancelled' });

    const secondSettlement = send(validEvent(window), { id: 'chat-a', text: '新' }) as Promise<ChatSendResult>;
    assert.equal(completer.calls.length, 2);

    handle.dispose();

    const secondCall = completer.calls[1];
    assert.ok(secondCall);
    assert.equal(secondCall.signal.aborted, true, '重发的同 id 请求同样应被 dispose abort');
    assert.deepEqual(await settleWithin(secondSettlement, '重发 chat-a 的 send Promise'), { id: 'chat-a', status: 'cancelled' });

    // 迟到的旧 provider 成功结果不得改写重发请求的终态（引用隔离由 core 保证）。
    const staleCall = completer.calls[0];
    assert.ok(staleCall);
    staleCall.resolve('迟到的旧回复');
    assert.deepEqual(await settleWithin(secondSettlement, '重发 chat-a 的终态'), { id: 'chat-a', status: 'cancelled' });
  });
});
