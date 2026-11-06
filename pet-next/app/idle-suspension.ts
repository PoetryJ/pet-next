/**
 * M3-9 待机节能预览的页面接线：接收主进程窗口快照，按修订号丢弃旧消息，
 * 把"隐藏"这一呈现输入交给媒体适配器，并暴露只读观测面。
 *
 * 本文件不做暂停决策（策略在 core/idle-suspension 与单槽适配器里），
 * 也不上报页面自己的隐藏判断——隐藏的唯一权威是主进程。
 * @module pet-next/app/idle-suspension
 */
import {
  IDLE_SUSPENSION_DEBUG_KEY,
  shouldApplySnapshot,
  type IdleSuspensionDebugState,
} from '../contracts/idle-suspension.ts';
import type { PetWindowVisibilityBridge } from './bridge.ts';
import type { PetMedia } from './pet-media.ts';

export interface IdleSuspensionHandle {
  /** 当前已应用的修订号；未收到任何快照时为 0。 */
  revision(): number;
  dispose(): void;
}

/**
 * 订阅窗口快照并驱动媒体适配器。
 *
 * @param options.media - 页面媒体装配（单槽才真正暂停）。
 * @param options.bridge - 预加载桥；缺失说明装配不完整，只记录不行为。
 * @returns 句柄，页面卸载时调用 `dispose`。
 */
export function attachIdleSuspension(options: {
  media: PetMedia;
  bridge: PetWindowVisibilityBridge | undefined;
}): IdleSuspensionHandle {
  const { media, bridge } = options;
  let revision = 0;
  let hidden = false;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;

  const log = (payload: Record<string, unknown>): void => {
    console.log(JSON.stringify({ event: 'idle-suspension', ...payload }));
  };

  // 观测面用 getter 直读适配器，避免两次事件之间读到陈旧计数。
  const surface = {
    get enabled() {
      return !disposed;
    },
    get revision() {
      return revision === 0 ? null : revision;
    },
    get hidden() {
      return hidden;
    },
    get generation() {
      return media.idleSuspensionState().generation;
    },
    get phase() {
      return media.idleSuspensionState().phase;
    },
    get clip() {
      return media.idleSuspensionState().clip;
    },
    get lease() {
      return media.idleSuspensionState().lease;
    },
    get pauseCount() {
      return media.idleSuspensionState().pauseCount;
    },
    get resumeCount() {
      return media.idleSuspensionState().resumeCount;
    },
    get lastAction() {
      return media.idleSuspensionState().lastAction;
    },
    get lastSkipReason() {
      return media.idleSuspensionState().lastSkipReason;
    },
  } satisfies IdleSuspensionDebugState;

  const apply = (snapshot: unknown): void => {
    if (disposed) return;
    if (!shouldApplySnapshot(revision, snapshot)) {
      const incoming = (snapshot as { revision?: unknown } | null)?.revision;
      if (incoming !== undefined) log({ event: 'stale-snapshot', revision, incoming });
      return;
    }
    revision = snapshot.revision;
    hidden = snapshot.hidden;
    media.setHidden(snapshot.hidden);
    log({ event: 'applied', revision, hidden, reason: snapshot.reason });
  };

  if (bridge === undefined) {
    log({ event: 'skip', reason: 'bridge-missing' });
    return {
      revision: () => revision,
      dispose() {},
    };
  }

  (window as unknown as Record<string, unknown>)[IDLE_SUSPENSION_DEBUG_KEY] = surface;
  // 先订阅再取初始快照：两步都可能晚到，修订号比较保证不会被旧值覆盖。
  unsubscribe = bridge.subscribe(apply);
  void bridge.query().then(apply, (error: unknown) => {
    log({ event: 'query-failed', error: String(error) });
  });

  return {
    revision: () => revision,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      delete (window as unknown as Record<string, unknown>)[IDLE_SUSPENSION_DEBUG_KEY];
    },
  };
}
