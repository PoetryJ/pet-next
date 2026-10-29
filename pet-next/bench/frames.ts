/**
 * 把点击之后的画面分类收成空白时间。
 * 不读取播放器内部状态，也不把 play() 兑现当成首帧。
 */

export type FrameKind = 'empty' | 'held' | 'reaction';

export interface TimedFrame {
  /** 相对点击的毫秒。点击当时记为 0。 */
  tMs: number;
  kind: FrameKind;
}

export interface LatencyMarks {
  clickAt: number;
  /** 目标画面第一次真正呈现的时刻。没有则为 null。 */
  presentedAt: number | null;
  /** play() 兑现的时刻。没有则为 null。 */
  playResolvedAt: number | null;
  frames: readonly TimedFrame[];
  /** 采样窗口已经结束。没有可见反应画面时，空白仍可结算。 */
  closed?: boolean;
}

export interface LatencyFields {
  clickToFirstFrameMs: number | null;
  playResolvedMs: number | null;
  blankMs: number | null;
}

/**
 * 点击时屏幕上仍是上一段画面（held）。
 * 新采样到来之前，按上一个种类计时。
 * 空白只累计屏幕处于 empty 的时间，见到可见的反应画面就停止。
 * 窗口没有收束、也没有可见反应画面时返回 null，不能写成 0。
 * `closed` 表示这段采样已经收到结束或超时；这时即使角色没出现，也返回看到的空白。
 * 采样间隔最多把一段空白少算一帧。三种模式用同一种算法。
 */
export function blankDurationMs(frames: readonly TimedFrame[], closed = false): number | null {
  let reactionAt: number | null = null;
  for (const frame of frames) {
    if (frame.tMs >= 0 && frame.kind === 'reaction') {
      reactionAt = frame.tMs;
      break;
    }
  }
  if (reactionAt === null && !closed) return null;
  const endAt = reactionAt ?? Number.POSITIVE_INFINITY;
  let blank = 0;
  let prevT = 0;
  let prevKind: FrameKind = 'held';
  for (const frame of frames) {
    if (frame.tMs < 0) continue;
    if (frame.tMs > endAt) break;
    if (prevKind === 'empty') blank += frame.tMs - prevT;
    prevT = frame.tMs;
    prevKind = frame.kind;
    if (frame.kind === 'reaction') break;
  }
  return blank;
}

/** 舞台上有没有可算作宠物的像素。 */
export function stageKind(targetPresented: boolean, stageOpaque: number, emptyOpaque: number): FrameKind {
  if (targetPresented) return 'reaction';
  if (stageOpaque < emptyOpaque) return 'empty';
  return 'held';
}

/**
 * 首帧和 play() 兑现各自用自己的时刻。
 * 缺了哪一个就留 null，不用另一个去补。
 */
export function assembleLatency(marks: LatencyMarks): LatencyFields {
  const clickToFirstFrameMs = marks.presentedAt === null ? null : marks.presentedAt - marks.clickAt;
  const playResolvedMs = marks.playResolvedAt === null ? null : marks.playResolvedAt - marks.clickAt;
  return {
    clickToFirstFrameMs,
    playResolvedMs,
    blankMs: blankDurationMs(marks.frames, marks.closed === true),
  };
}
