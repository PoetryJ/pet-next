/**
 * 窗口位置与工作区。纯计算不读取屏幕，宿主由 Electron 主进程提供。
 * @module pet-next/adapters/window/types
 */

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type WindowBounds = WorkArea;

export interface WindowHost {
  getBounds(): WindowBounds;
  setPosition(x: number, y: number): void;
  /** 窗口当前所在显示器的工作区，不含任务栏。 */
  workAreaFor(bounds: WindowBounds): WorkArea;
  quit(): void;
}

export interface WindowController {
  moveBy(dx: number, dy: number): void;
  quit(): void;
}
