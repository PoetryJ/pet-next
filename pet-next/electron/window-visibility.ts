/**
 * M3-9 窗口可见性发布器：主进程是隐藏状态的唯一权威。
 *
 * 判定口径：`!win.isVisible() || win.isMinimized()`。`blur` 不是隐藏，遮挡识别本轮不做；
 * 也不改 `setBackgroundThrottling(false)` 这个全局设置。每次状态变化递增 `revision`
 * 并推送完整快照；页面只接受更新的修订号，因此迟到的消息不会覆盖新状态。
 *
 * 本模块不 import electron 运行时值：`ipcMain` 由调用方注入，便于纯 node 单测。
 * @module pet-next/electron/window-visibility
 */
import {
  WINDOW_VISIBILITY_CHANNEL,
  WINDOW_VISIBILITY_QUERY_CHANNEL,
  type WindowVisibilityReason,
  type WindowVisibilitySnapshot,
} from '../contracts/idle-suspension.ts';

const EVENTS = ['hide', 'show', 'minimize', 'restore'] as const;
type VisibilityEvent = (typeof EVENTS)[number];

/** 只依赖真正用到的成员，测试可传替身。 */
export interface WindowVisibilityTarget {
  isVisible(): boolean;
  isMinimized(): boolean;
  isDestroyed?(): boolean;
  on(event: VisibilityEvent | 'closed', listener: () => void): unknown;
  removeListener(event: VisibilityEvent | 'closed', listener: () => void): unknown;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

/** 主进程 ipcMain 的最小面。 */
export interface WindowVisibilityIpc {
  handle(channel: string, listener: (event: { sender: unknown }) => unknown): void;
  removeHandler(channel: string): void;
}

export interface WindowVisibilityDeps {
  ipcMain: WindowVisibilityIpc;
  /** 观测日志（默认 stdout 单行 JSON）；测试可静音。 */
  log?: (payload: Record<string, unknown>) => void;
}

export interface WindowVisibilityPublisher {
  /** 当前快照（读活值，不缓存）。 */
  snapshot(): WindowVisibilitySnapshot;
  /** 幂等：摘监听、注销 handler、停止推送。 */
  dispose(): void;
}

/**
 * 纯函数：把窗口的两个布尔量归一成快照。`minimized` 优先于 `hidden`。
 *
 * @param state - `isVisible()` / `isMinimized()` 的取值。
 * @param revision - 本次修订号。
 * @returns 快照。
 */
export function snapshotFor(
  state: { visible: boolean; minimized: boolean },
  revision: number,
): WindowVisibilitySnapshot {
  const reason: WindowVisibilityReason = state.minimized ? 'minimized' : state.visible ? 'visible' : 'hidden';
  return { revision, hidden: reason !== 'visible', reason };
}

/**
 * 绑定一个窗口的可见性发布。
 *
 * @param win - 目标窗口（本应用只有桌宠窗会调用）。
 * @param deps - 注入的 ipcMain 与日志。
 * @returns 发布器。
 */
export function attachWindowVisibility(
  win: WindowVisibilityTarget,
  deps: WindowVisibilityDeps,
): WindowVisibilityPublisher {
  const log = deps.log ?? ((payload: Record<string, unknown>) => console.log(JSON.stringify(payload)));
  let revision = 1;
  let disposed = false;

  const snapshot = (): WindowVisibilitySnapshot =>
    snapshotFor({ visible: win.isVisible(), minimized: win.isMinimized() }, revision);

  const publish = (): void => {
    if (disposed) return;
    if (win.isDestroyed?.() === true) return;
    if (win.webContents.isDestroyed()) return;
    revision += 1;
    const next = snapshot();
    win.webContents.send(WINDOW_VISIBILITY_CHANNEL, next);
    log({ event: 'window-visibility', revision: next.revision, hidden: next.hidden, reason: next.reason });
  };

  const listeners = new Map<VisibilityEvent, () => void>();
  for (const event of EVENTS) {
    const listener = (): void => publish();
    listeners.set(event, listener);
    win.on(event, listener);
  }

  // 关闭即注销：不给已销毁的 webContents 继续推送。
  const onClosed = (): void => {
    dispose();
  };
  win.on('closed', onClosed);

  // 同一进程内重复装配（理论上不会）也不抛“第二次注册”：先摘后挂。
  deps.ipcMain.removeHandler(WINDOW_VISIBILITY_QUERY_CHANNEL);
  deps.ipcMain.handle(WINDOW_VISIBILITY_QUERY_CHANNEL, (event) => {
    if (disposed) return null;
    if (event.sender !== win.webContents) return null;
    return snapshot();
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const [event, listener] of listeners) win.removeListener(event, listener);
    listeners.clear();
    win.removeListener('closed', onClosed);
    deps.ipcMain.removeHandler(WINDOW_VISIBILITY_QUERY_CHANNEL);
  }

  return { snapshot, dispose };
}
