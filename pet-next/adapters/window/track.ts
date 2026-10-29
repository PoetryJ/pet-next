/**
 * 把一次指针位移累加到尚未回读的窗口原点上。
 * `getBounds` 在缩放不是整数时会对齐到设备像素，回读后再加增量会丢掉余数。
 */
import { clampPosition } from './clamp.ts';
import type { WorkArea } from './types.ts';

export interface TrackedOrigin {
  readonly x: number;
  readonly y: number;
}

/**
 * 前进窗口原点。
 *
 * @param tracked - 已累计的 DIP；第一次移动传 null，用当时的 `reported` 作起点。
 * @param reported - 宿主此刻回读的原点，只在 `tracked` 为空时使用。
 * @returns `tracked` 是夹紧后的 DIP，`position` 是落在工作区内的整数，交给 `setPosition`。
 */
export function advanceOrigin(
  tracked: TrackedOrigin | null,
  reported: { readonly x: number; readonly y: number },
  dx: number,
  dy: number,
  size: { readonly width: number; readonly height: number },
  workArea: WorkArea,
): { tracked: TrackedOrigin; position: { x: number; y: number } } {
  const base = tracked ?? reported;
  const next = clampPosition({ x: base.x + dx, y: base.y + dy }, size, workArea);
  return {
    tracked: next,
    position: {
      x: integerInside(next.x, workArea.x, Math.max(workArea.x, workArea.x + workArea.width - size.width)),
      y: integerInside(next.y, workArea.y, Math.max(workArea.y, workArea.y + workArea.height - size.height)),
    },
  };
}

/** 四舍五入后仍落在闭区间里；区间退成一点时钉在起点。 */
function integerInside(value: number, min: number, max: number): number {
  if (min >= max) return Math.round(min);
  const rounded = Math.round(Math.min(max, Math.max(min, value)));
  if (rounded < min) return Math.ceil(min);
  if (rounded > max) return Math.floor(max);
  return rounded;
}
