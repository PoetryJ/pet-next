/**
 * 把窗口左上角夹进工作区。窗口大于工作区时钉在工作区原点。
 * @module pet-next/adapters/window/clamp
 */
import type { WorkArea } from './types.ts';

/** 夹紧后的左上角，单位与工作区相同。 */
export function clampPosition(
  next: { x: number; y: number },
  size: { width: number; height: number },
  workArea: WorkArea,
): { x: number; y: number } {
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = Math.max(minX, workArea.x + workArea.width - size.width);
  const maxY = Math.max(minY, workArea.y + workArea.height - size.height);
  return {
    x: Math.min(maxX, Math.max(minX, next.x)),
    y: Math.min(maxY, Math.max(minY, next.y)),
  };
}
