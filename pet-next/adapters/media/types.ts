/**
 * 媒体适配器的元素、加载器和时钟。测试注入替身，页面注入真实 video。
 * @module pet-next/adapters/media/types
 */

export interface LoadToken {
  aborted: boolean;
}

export interface MediaElement {
  src: string;
  loop: boolean;
  muted: boolean;
  paused: boolean;
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
}

export interface MediaAdapter {
  begin(request: MediaClipRequest): void;
  dispose(): void;
  readonly generation: number;
  readonly phase: string;
}

export interface MediaAdapterOptions {
  element: MediaElement;
  loader: MediaLoader;
  clock: MediaClock;
  /** 加载阶段超时，单位毫秒。到点由时钟回调发出 failed。 */
  timeoutMs: number;
  onStatus(event: MediaStatusEvent): void;
}
