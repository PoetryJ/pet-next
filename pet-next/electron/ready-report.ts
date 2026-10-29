/**
 * 启动时记下缩放来源和窗口 DIP，供拖动测试区分系统缩放与模拟缩放。
 * @module pet-next/electron/ready-report
 */
import { app, type BrowserWindow, screen } from 'electron';
import { readForcedDeviceScaleFactor, scaleSourceOf } from '../adapters/window/scale-source.ts';

/** 打印 ready。缩放来自 Electron `screen`，不是页面的 devicePixelRatio。 */
export function logReady(
  win: BrowserWindow,
  requestedBackground: string,
  transparent: boolean,
  workArea: { x: number; y: number; width: number; height: number },
): void {
  const bounds = win.getBounds();
  const display = screen.getPrimaryDisplay();
  const forcedDeviceScaleFactor = readForcedDeviceScaleFactor(
    app.commandLine.getSwitchValue('force-device-scale-factor'),
    process.argv,
  );
  console.log(JSON.stringify({
    event: 'ready',
    alwaysOnTop: win.isAlwaysOnTop(),
    transparent,
    requestedBackground,
    background: win.getBackgroundColor(),
    bounds,
    workArea,
    scaleFactor: display.scaleFactor,
    forcedDeviceScaleFactor,
    scaleSource: scaleSourceOf(forcedDeviceScaleFactor),
    displayBounds: display.bounds,
    displayCount: screen.getAllDisplays().length,
    physical: screen.dipToScreenPoint({ x: bounds.x, y: bounds.y }),
  }));
}
