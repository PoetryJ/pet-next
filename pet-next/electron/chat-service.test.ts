/**
 * 主进程聊天服务单测：注入假 ipcMain / 窗口 / 会话桩，不启动 Electron。
 * 锁定：sender 非主窗口被忽略、载荷不合法 bad-request 不透传、send/cancel 正确转发、
 * dispose 移除通道并取消在途、关窗触发清理、url 演示安全。
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
import type { ChatSendRequest, ChatSession } from '../core/chat/types.ts';

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

function createSessionStub(result: ChatSendResult = { id: 'chat-x', status: 'ok', text: 'stub' }): {
  session: ChatSession;
  sends: ChatSendRequest[];
  cancels: string[];
} {
  const sends: ChatSendRequest[] = [];
  const cancels: string[] = [];
  const session: ChatSession = {
    async send(request) {
      sends.push(request);
      return { ...result, id: request.id };
    },
    cancel(id) {
      cancels.push(id);
    },
    hasPending() {
      return false;
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
