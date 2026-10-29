/**
 * 对照图 PNG 能被按块读回。
 */
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import { encodeRgbaPng } from './png-rgba.ts';

test('1×1 PNG 的签名、尺寸和像素与输入一致', () => {
  const png = encodeRgbaPng(1, 1, Uint8Array.of(10, 20, 30, 255));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = readChunks(png);
  const ihdr = chunks.get('IHDR');
  assert.ok(ihdr);
  assert.equal(ihdr.readUInt32BE(0), 1);
  assert.equal(ihdr.readUInt32BE(4), 1);
  assert.equal(ihdr[9], 6);
  const idat = chunks.get('IDAT');
  assert.ok(idat);
  const raw = inflateSync(idat);
  assert.deepEqual([...raw], [0, 10, 20, 30, 255]);
});

function readChunks(png: Buffer): Map<string, Buffer> {
  const chunks = new Map<string, Buffer>();
  let offset = 8;
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    chunks.set(type, png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return chunks;
}
