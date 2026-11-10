/**
 * 报告落盘：`quality-report.json` 带逐帧数值，关键帧只交小 PNG。
 *
 * 整幅 640×360 的对照图不入库，最多 3 张小图，而且只裁 crop 区域。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { encodeRgbaPng } from '../../../assets-pipeline/png-rgba.ts';
import { compositeFrame, type PlateId, type Rect } from './pixels.ts';

export function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** 合成到指定底后，只写 `crop` 区域的 PNG。 */
export function writeCroppedCompositePng(file: string, rgba: Uint8Array, width: number, height: number, crop: Rect, plate: PlateId): void {
  const rgb = Buffer.alloc(width * height * 3);
  compositeFrame(rgba, width, height, plate, rgb);
  const out = Buffer.alloc(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const source = ((crop.y + y) * width + crop.x + x) * 3;
      const target = (y * crop.width + x) * 4;
      out[target] = rgb[source] ?? 0;
      out[target + 1] = rgb[source + 1] ?? 0;
      out[target + 2] = rgb[source + 2] ?? 0;
      out[target + 3] = 255;
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encodeRgbaPng(crop.width, crop.height, out));
}

/**
 * 误差放大图：`abs(left-right)` 取三通道最大值乘以 `amplify`，灰阶显示。
 * 这样 1–2 LSB 的差异也肉眼可见，而判据没有因此松动。
 */
export function writeErrorMapPng(file: string, left: Uint8Array, right: Uint8Array, width: number, height: number, crop: Rect, amplify: number): void {
  const out = Buffer.alloc(crop.width * crop.height * 4);
  for (let y = 0; y < crop.height; y += 1) {
    for (let x = 0; x < crop.width; x += 1) {
      const source = ((crop.y + y) * width + crop.x + x) * 3;
      const target = (y * crop.width + x) * 4;
      let max = 0;
      for (let channel = 0; channel < 3; channel += 1) {
        const delta = Math.abs((left[source + channel] ?? 0) - (right[source + channel] ?? 0)) * amplify;
        if (delta > max) max = delta;
      }
      const value = max > 255 ? 255 : max;
      out[target] = value;
      out[target + 1] = value;
      out[target + 2] = value;
      out[target + 3] = 255;
    }
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, encodeRgbaPng(crop.width, crop.height, out));
}
