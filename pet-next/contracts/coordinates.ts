/**
 * 指针、窗口和缩放的单位。换算实现放在 `adapters/pointer`，由 Agent B 编写。
 * 默认启动仍由页面把 `screenX` / `screenY` 交给手势核心，本模块未被装配。
 * `moveBy` 与 `BrowserWindow` 的位置使用 DIP。生产换算集中在指针适配器。
 * @module pet-next/contracts/coordinates
 */

export type ScaleOrigin = 'default' | 'simulated' | 'system';

export interface ScaleCaseSpec {
  id:
    | 'default'
    | 'simulated-100'
    | 'simulated-125'
    | 'simulated-150'
    | 'system-100'
    | 'system-125'
    | 'system-150';
  origin: ScaleOrigin;
  /** `default` 时为 null，表示记录实测 `scaleFactor`，不断言等于某个常数。 */
  scaleFactor: number | null;
}

/** 验收矩阵的行。1 倍模拟缩放是对照，不能作为唯一验收。 */
export const REQUIRED_SCALE_CASES = [
  { id: 'default', origin: 'default', scaleFactor: null },
  { id: 'simulated-100', origin: 'simulated', scaleFactor: 1 },
  { id: 'simulated-125', origin: 'simulated', scaleFactor: 1.25 },
  { id: 'simulated-150', origin: 'simulated', scaleFactor: 1.5 },
  { id: 'system-100', origin: 'system', scaleFactor: 1 },
  { id: 'system-125', origin: 'system', scaleFactor: 1.25 },
  { id: 'system-150', origin: 'system', scaleFactor: 1.5 },
] as const satisfies readonly ScaleCaseSpec[];

export interface ViewportCssPoint {
  space: 'viewport-css';
  x: number;
  y: number;
}

export interface ScreenCssPoint {
  space: 'screen-css';
  x: number;
  y: number;
}

export interface DipBounds {
  space: 'dip';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PointerObservation {
  /** `PointerEvent.clientX` / `clientY`，相对视口的 CSS 像素。 */
  client: ViewportCssPoint;
  /** `PointerEvent.screenX` / `screenY`，相对屏幕原点的 CSS 像素。 */
  screen: ScreenCssPoint;
  /** `BrowserWindow.getBounds()`，DIP。 */
  window: DipBounds;
  /** `screen.getDisplayMatching(bounds).scaleFactor`。 */
  scaleFactor: number;
  /** 随观察记下来。适配器之外的生产代码不拿它做乘除。 */
  devicePixelRatio: number;
  scaleOrigin: ScaleOrigin;
}

export interface DipPoint {
  space: 'dip';
  x: number;
  y: number;
  /** 这次有没有按缩放改写坐标。测量证明无需改写时为 `identity`。 */
  conversion: 'identity' | 'scaled';
}

export interface PointerAdapter {
  /**
   * 把一次指针观察换成与窗口 bounds 相同的 DIP。
   *
   * @param observation - 同一次采样的 DOM 坐标、窗口 bounds 和 `scaleFactor`。
   * @returns 供手势核心使用的点。手势核心继续只做位移，不读取缩放。
   */
  toDip(observation: PointerObservation): DipPoint;
}

export interface ScaleMatrixEntry {
  id: (typeof REQUIRED_SCALE_CASES)[number]['id'];
  status: 'passed' | 'failed' | 'not-run';
  /** `passed` 时为 null。`not-run` 时写明没有该执行条件。 */
  reason: string | null;
  /** 实测 `Display.scaleFactor`。`not-run` 时为 null。 */
  observedScaleFactor: number | null;
  /** 相对 `pet-next` 的样本或日志。`not-run` 时为 null。 */
  evidencePath: string | null;
}
