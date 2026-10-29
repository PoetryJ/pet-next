/**
 * 读取 PNG 的 alpha，用来核对透明窗口截图像素。
 * 只接受 8 位、非隔行扫描。
 * @module pet-next/tests/platform/png-alpha
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface PngAlpha {
  width: number;
  height: number;
  colorType: number;
  /** 每个像素 0–255，行优先。 */
  alpha: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 解码 alpha。颜色类型没有 alpha 时每个像素记 255。 */
export function readPngAlpha(bytes: Buffer): PngAlpha {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a png');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`bit depth ${data[8]}`);
      colorType = data[9] ?? 0;
      if (data[12] !== 0) throw new Error('interlaced png');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const channels = channelsOf(colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const alpha = new Uint8Array(width * height);
  let source = 0;
  let previous = Buffer.alloc(width * channels);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source] ?? 0;
    source += 1;
    const row = Buffer.alloc(width * channels);
    for (let index = 0; index < row.length; index += 1) {
      row[index] = unfilter(filter, raw[source] ?? 0, row[index - channels] ?? 0, previous[index] ?? 0, previous[index - channels] ?? 0);
      source += 1;
    }
    for (let x = 0; x < width; x += 1) alpha[y * width + x] = alphaOf(colorType, row, x);
    previous = row;
  }
  return { width, height, colorType, alpha };
}

/** 四角和中心。坐标落在图外时跳过。 */
export function sampleAlpha(image: PngAlpha): Array<{ x: number; y: number; alpha: number }> {
  const points = [
    [0, 0],
    [image.width - 1, 0],
    [0, image.height - 1],
    [image.width - 1, image.height - 1],
    [Math.floor(image.width / 2), Math.floor(image.height / 2)],
  ];
  const samples: Array<{ x: number; y: number; alpha: number }> = [];
  for (const point of points) {
    const x = point[0] ?? 0;
    const y = point[1] ?? 0;
    if (x < 0 || y < 0) continue;
    samples.push({ x, y, alpha: image.alpha[y * image.width + x] ?? 255 });
  }
  return samples;
}

/** 测试夹具用的 RGBA PNG。 */
export function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) throw new Error('rgba length');
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const start = y * (1 + width * 4);
    raw[start] = 0;
    rgba.copy(raw, start + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function channelsOf(colorType: number): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error(`color type ${colorType}`);
}

function alphaOf(colorType: number, row: Buffer, x: number): number {
  if (colorType === 6) return row[x * 4 + 3] ?? 255;
  if (colorType === 4) return row[x * 2 + 1] ?? 255;
  return 255;
}

function unfilter(filter: number, value: number, left: number, up: number, upLeft: number): number {
  if (filter === 0) return value;
  if (filter === 1) return (value + left) & 255;
  if (filter === 2) return (value + up) & 255;
  if (filter === 3) return (value + Math.floor((left + up) / 2)) & 255;
  if (filter === 4) return (value + paeth(left, up, upLeft)) & 255;
  throw new Error(`filter ${filter}`);
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonal = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonal) return left;
  if (upDistance <= diagonal) return up;
  return upLeft;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
