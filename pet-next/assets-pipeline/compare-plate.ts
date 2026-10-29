/**
 * 把同一帧合成到浅色、深色和棋盘底上。
 */
import type { QualityBackground } from '../contracts/assets.ts';
import {
  blendChannel,
  CHECKER_CELL_PX,
  CHECKER_DARK,
  CHECKER_LIGHT,
  DARK_PLATE,
  LIGHT_PLATE,
  type RgbaFrame,
  type Rgb,
} from './frame-metrics.ts';

/** 对照图是不透明的，方便直接打开看，不靠播放器的透明底。 */
export function compositePlate(frame: RgbaFrame, background: QualityBackground): Uint8Array {
  const plate = new Uint8Array(frame.rgba.length);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      writePixel(plate, frame, background, x, y);
    }
  }
  return plate;
}

function writePixel(plate: Uint8Array, frame: RgbaFrame, background: QualityBackground, x: number, y: number): void {
  const offset = (y * frame.width + x) * 4;
  const color = plateColor(background, x, y);
  const alpha = frame.rgba[offset + 3] ?? 0;
  plate[offset] = blendChannel(frame.rgba[offset] ?? 0, alpha, color.red);
  plate[offset + 1] = blendChannel(frame.rgba[offset + 1] ?? 0, alpha, color.green);
  plate[offset + 2] = blendChannel(frame.rgba[offset + 2] ?? 0, alpha, color.blue);
  plate[offset + 3] = 255;
}

function plateColor(background: QualityBackground, x: number, y: number): Rgb {
  if (background === 'light') return LIGHT_PLATE;
  if (background === 'dark') return DARK_PLATE;
  if (background === 'checker') return checkerColor(x, y);
  return assertNever(background);
}

function checkerColor(x: number, y: number): Rgb {
  const cell = (Math.floor(x / CHECKER_CELL_PX) + Math.floor(y / CHECKER_CELL_PX)) % 2;
  return cell === 0 ? CHECKER_LIGHT : CHECKER_DARK;
}

function assertNever(value: never): never {
  throw new Error(`未处理的背景 ${String(value)}`);
}
