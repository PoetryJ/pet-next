/**
 * 媒体适配器的元素、加载器和时钟。测试注入替身，页面注入真实 video。
 * M3-9：元素契约仍只描述播放能力；"隐藏"是适配器输入，不改元素语义。
 * @module pet-next/adapters/media/types
 */
import type { IdleSuspensionDebugState } from '../../contracts/idle-suspension.ts';
import type { SlotClip } from '../../contracts/media-slot.ts';

export interface LoadToken {
  aborted: boolean;
  /** 本次加载被替换或卸载时调用，用来卸下监听并结束 Promise。 */
  onAbort(listener: () => void): void;
}

export interface MediaElement {
  src: string;
  loop: boolean;
  muted: boolean;
  readonly paused: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}

export interface MediaLoader {
  load(url: string, token: LoadToken): Promise<{ src: string }>;
  release(src: string): void;
}

export interface MediaClock {
  set(fn: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface MediaStatusEvent {
  playbackId: string;
  status: 'playing' | 'ended' | 'failed' | 'cancelled';
  reason?: string;
}

export interface MediaClipRequest {
  playbackId: string;
  url: string;
  once: boolean;
  /** M3-9：节能策略只暂停 `idle`，所以片段必须显式传入，不能靠 `once` 反推。 */
  clip: SlotClip;
}

export interface MediaAdapter {
  begin(request: MediaClipRequest): void;
  dispose(): void;
  readonly generation: number;
  readonly phase: string;
  /** M3-9：报告窗口隐藏状态；开关关闭时是 no-op。 */
  setHidden(hidden: boolean): void;
  /** M3-9：只读观测面。 */
  idleSuspensionState(): IdleSuspensionDebugState;
}

export interface MediaAdapterOptions {
  element: MediaElement;
  loader: MediaLoader;
  clock: MediaClock;
  /** 加载阶段超时，单位毫秒。到点由时钟回调发出 failed。 */
  timeoutMs: number;
  onStatus(event: MediaStatusEvent): void;
  /** M3-9：显式节能开关；缺省 false，此时不创建策略状态、setHidden 无副作用。 */
  idlePause?: boolean;
  /** M3-9：元素身份；缺省 `single-primary`（一个适配器只绑定一个元素）。 */
  elementIdentity?: string;
}
