/**
 * DOM `screenX`/`screenY` 到窗口 DIP。
 *
 * Electron 43 在 Linux X11 上，这两套坐标已经相同：物理像素位移除以
 * `Display.scaleFactor` 才等于 `screen` 增量。窗口位置也是 DIP。
 * 再除以 scaleFactor，或把 DOM 点送进 `screen.screenToDipPoint`，拖动会慢于光标。
 */

/** 保持 DOM screen 点的数值。调用方不要再乘除 `devicePixelRatio`。 */
export function domScreenPointToDip(point: { readonly x: number; readonly y: number }): { x: number; y: number } {
  return { x: point.x, y: point.y };
}
