/**
 * 把窗口左上角夹进工作区。窗口大于工作区时钉在工作区原点。
 * @module pet-next/adapters/window/clamp
 */
import type { WorkArea } from './types.ts';

export function clampPosition(
  _next: { x: number; y: number },
  _size: { width: number; height: number },
  _workArea: WorkArea,
): { x: number; y: number } {
  throw new Error('not implemented');
}
