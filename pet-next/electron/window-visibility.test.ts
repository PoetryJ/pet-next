/**
 * M3-9 窗口可见性发布器的纯 node 单测：不启动 Electron，窗口与 ipcMain 都是替身。
 * @module pet-next/electron/window-visibility.test
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { WINDOW_VISIBILITY_CHANNEL } from '../contracts/idle-suspension.ts';
import { attachWindowVisibility, snapshotFor, type WindowVisibilityIpc } from './window-visibility.ts';

interface FakeWindow {
  visible: boolean;
  minimized: boolean;
  destroyed: boolean;
  webContentsDestroyed: boolean;
  sent: Array<{ channel: string; payload: unknown }>;
  handlers: Map<string, () => void>;
  isVisible(): boolean;
  isMinimized(): boolean;
  isDestroyed(): boolean;
  on(event: string, listener: () => void): void;
  removeListener(event: string, listener: () => void): void;
  webContents: { isDestroyed(): boolean; send(channel: string, payload: unknown): void };
  emit(event: string): void;
}

function fakeWindow(options: { visible?: boolean; minimized?: boolean } = {}): FakeWindow {
  const handlers = new Map<string, Set<() => void>>();
  const win: FakeWindow = {
    visible: options.visible ?? true,
    minimized: options.minimized ?? false,
    destroyed: false,
    webContentsDestroyed: false,
    sent: [],
    handlers: new Map(),
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    isDestroyed: () => win.destroyed,
    on(event, listener) {
      const set = handlers.get(event) ?? new Set();
      set.add(listener);
      handlers.set(event, set);
    },
    removeListener(event, listener) {
      handlers.get(event)?.delete(listener);
    },
    webContents: {
      isDestroyed: () => win.webContentsDestroyed,
      send(channel, payload) {
        win.sent.push({ channel, payload });
      },
    },
    emit(event) {
      for (const listener of handlers.get(event) ?? []) listener();
    },
  };
  return win;
}

function fakeIpc(): WindowVisibilityIpc & { handlers: Map<string, (event: { sender: unknown }) => unknown>; removed: string[] } {
  const handlers = new Map<string, (event: { sender: unknown }) => unknown>();
  const removed: string[] = [];
  return {
    handlers,
    removed,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      removed.push(channel);
      handlers.delete(channel);
    },
  };
}

test('初始快照 revision=1，可见', () => {
  const win = fakeWindow();
  const ipc = fakeIpc();
  const publisher = attachWindowVisibility(win, { ipcMain: ipc, log: () => {} });
  assert.deepEqual(publisher.snapshot(), { revision: 1, hidden: false, reason: 'visible' });
  assert.equal(win.sent.length, 0);
  publisher.dispose();
});

test('hide/show 推送并递增修订号', () => {
  const win = fakeWindow();
  const ipc = fakeIpc();
  const publisher = attachWindowVisibility(win, { ipcMain: ipc, log: () => {} });
  win.visible = false;
  win.emit('hide');
  assert.deepEqual(win.sent.at(-1)?.payload, { revision: 2, hidden: true, reason: 'hidden' });
  win.visible = true;
  win.emit('show');
  assert.deepEqual(win.sent.at(-1)?.payload, { revision: 3, hidden: false, reason: 'visible' });
  assert.equal(win.sent[0]?.channel, WINDOW_VISIBILITY_CHANNEL);
  publisher.dispose();
});

test('最小化原因优先于不可见；restore 回到可见', () => {
  const win = fakeWindow();
  const publisher = attachWindowVisibility(win, { ipcMain: fakeIpc(), log: () => {} });
  win.visible = false;
  win.minimized = true;
  win.emit('minimize');
  assert.equal((publisher.snapshot() as { reason: string }).reason, 'minimized');
  win.minimized = false;
  win.visible = true;
  win.emit('restore');
  assert.deepEqual(publisher.snapshot(), { revision: 3, hidden: false, reason: 'visible' });
  publisher.dispose();
});

test('查询只回应本窗口', () => {
  const win = fakeWindow();
  const ipc = fakeIpc();
  const publisher = attachWindowVisibility(win, { ipcMain: ipc, log: () => {} });
  const handler = ipc.handlers.get('pet:window-visibility:query');
  assert.ok(handler);
  assert.deepEqual(handler({ sender: win.webContents }), { revision: 1, hidden: false, reason: 'visible' });
  assert.equal(handler({ sender: {} }), null);
  publisher.dispose();
  assert.equal(ipc.handlers.has('pet:window-visibility:query'), false);
});

test('dispose 幂等：不再推送、摘掉监听', () => {
  const win = fakeWindow();
  const publisher = attachWindowVisibility(win, { ipcMain: fakeIpc(), log: () => {} });
  publisher.dispose();
  publisher.dispose();
  const before = win.sent.length;
  win.visible = false;
  win.emit('hide');
  assert.equal(win.sent.length, before);
  assert.equal(win.handlers.get('hide')?.size ?? 0, 0);
});

test('webContents 已销毁时推送不抛错', () => {
  const win = fakeWindow();
  const publisher = attachWindowVisibility(win, { ipcMain: fakeIpc(), log: () => {} });
  win.webContentsDestroyed = true;
  assert.doesNotThrow(() => win.emit('hide'));
  assert.equal(win.sent.length, 0);
  publisher.dispose();
});

test('窗口关闭自动 dispose', () => {
  const win = fakeWindow();
  const ipc = fakeIpc();
  attachWindowVisibility(win, { ipcMain: ipc, log: () => {} });
  win.emit('closed');
  assert.equal(ipc.handlers.has('pet:window-visibility:query'), false);
});

test('snapshotFor 组合与优先级', () => {
  assert.deepEqual(snapshotFor({ visible: true, minimized: false }, 7), { revision: 7, hidden: false, reason: 'visible' });
  assert.deepEqual(snapshotFor({ visible: false, minimized: false }, 8), { revision: 8, hidden: true, reason: 'hidden' });
  assert.deepEqual(snapshotFor({ visible: true, minimized: true }, 9), { revision: 9, hidden: true, reason: 'minimized' });
});
