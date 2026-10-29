/**
 * 窗口移动与退出。DIP 位移累加在回读之前，再夹进工作区写回。
 * 不读取 devicePixelRatio；DOM screen 增量与窗口原点已经同单位。
 * @module pet-next/adapters/window/controller
 */
import { advanceOrigin, type TrackedOrigin } from './track.ts';
import type { WindowController, WindowHost } from './types.ts';

/** 把平移和退出接到宿主。非有限位移直接忽略。 */
export function createWindowController(host: WindowHost): WindowController {
  let tracked: TrackedOrigin | null = null;
  return {
    moveBy(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const bounds = host.getBounds();
      const step = advanceOrigin(
        tracked,
        bounds,
        dx,
        dy,
        { width: bounds.width, height: bounds.height },
        host.workAreaFor(bounds),
      );
      tracked = step.tracked;
      host.setPosition(step.position.x, step.position.y);
    },
    quit() {
      host.quit();
    },
  };
}
