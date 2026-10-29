/**
 * 区分操作系统缩放和 `--force-device-scale-factor` 模拟缩放。
 */

const FORCED_SCALE_FLAG = '--force-device-scale-factor=';

/** 没写强制缩放时返回 null，表示用操作系统当前的 scaleFactor。 */
export function readForcedDeviceScaleFactor(switchValue: string, argv: readonly string[]): number | null {
  const fromArgv = argv.find((item) => item.startsWith(FORCED_SCALE_FLAG))?.slice(FORCED_SCALE_FLAG.length);
  const text = switchValue || fromArgv;
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** `os` 是系统当前缩放；带强制值时是 Chromium 开关模拟的。 */
export function scaleSourceOf(forced: number | null): 'os' | 'simulated-chromium-flag' {
  return forced === null ? 'os' : 'simulated-chromium-flag';
}
