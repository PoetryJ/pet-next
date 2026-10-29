/**
 * 窗口移动与退出。位移在宿主读取的工作区内夹紧后写回。
 * @module pet-next/adapters/window/controller
 */
import { clampPosition } from './clamp.ts';
import type { WindowController, WindowHost } from './types.ts';

/** 把平移和退出接到宿主。非有限位移直接忽略。 */
export function createWindowController(host: WindowHost): WindowController {
  return {
    moveBy(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const bounds = host.getBounds();
      const area = host.workAreaFor(bounds);
      const next = clampPosition(
        { x: bounds.x + dx, y: bounds.y + dy },
        { width: bounds.width, height: bounds.height },
        area,
      );
      host.setPosition(Math.round(next.x), Math.round(next.y));
    },
    quit() {
      host.quit();
    },
  };
}
