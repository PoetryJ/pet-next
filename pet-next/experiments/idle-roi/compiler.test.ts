/**
 * 离线编译器的纯函数与错误处理单测。不跑真实编码（慢），编码路径用注入的 runner 验证。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  ALPHA_THRESHOLD,
  GUARD_PX,
  accumulateAlphaBounds,
  alignEvenRect,
  boundsToRect,
  computeCrop,
  countAlphaAbove,
  countAlphaAboveOutside,
  emptyBounds,
  expandRect,
} from './lib/crop.ts';
import { DEFAULT_CRF, DEFAULT_CPU_USED, DEFAULT_GOP, alphaZeroFilter, encodeArgs, encodeTo, preprocessFilter } from './lib/encode.ts';
import { sha256File, sha256Hex } from './lib/hash.ts';
import { IDLE_FRAME_COUNT, buildManifest, summarizePts, validateManifest } from './lib/manifest.ts';

const CANVAS = { width: 640, height: 360 };
/** 契约第 3 节的裁框，单测里钉死。 */
const CONTRACT_CROP = { x: 208, y: 52, width: 226, height: 286 };
const COLOR_TAGS = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' };

type Pixel = readonly [x: number, y: number, alpha: number];

function makeFrame(width: number, height: number, pixels: readonly Pixel[]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (const [x, y, alpha] of pixels) {
    data[(y * width + x) * 4 + 3] = alpha;
  }
  return data;
}

test('全片并集 → guard 2 → 偶数对齐，得到契约裁框', () => {
  // 两帧分别覆盖并集的四角：x210..431、y54..334
  const first: readonly Pixel[] = [[210, 54, 255], [431, 54, 2]];
  const second: readonly Pixel[] = [[210, 334, 2], [300, 200, 255]];
  let bounds = emptyBounds();
  bounds = accumulateAlphaBounds(bounds, makeFrame(CANVAS.width, CANVAS.height, first), CANVAS.width, CANVAS.height);
  bounds = accumulateAlphaBounds(bounds, makeFrame(CANVAS.width, CANVAS.height, second), CANVAS.width, CANVAS.height);
  assert.deepEqual(boundsToRect(bounds), { x: 210, y: 54, width: 222, height: 281 });
  assert.deepEqual(expandRect(boundsToRect(bounds)!, 2), { x: 208, y: 52, width: 226, height: 285 });
  assert.deepEqual(computeCrop(bounds, CANVAS, 2), CONTRACT_CROP);
});

test('阈值固定为 1：alpha<=1 不算前景，alpha>1 才算', () => {
  assert.equal(ALPHA_THRESHOLD, 1);
  const frame = makeFrame(8, 8, [[0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 255]]);
  const bounds = accumulateAlphaBounds(emptyBounds(), frame, 8, 8);
  assert.deepEqual(boundsToRect(bounds), { x: 2, y: 2, width: 2, height: 2 });
  assert.equal(bounds.count, 2);
  assert.equal(countAlphaAbove(frame, 8, 8), 2);
});

test('全片 alpha<=1 时没有裁框机会，返回 null 而不是瞎猜', () => {
  let bounds = emptyBounds();
  bounds = accumulateAlphaBounds(bounds, makeFrame(8, 8, [[0, 0, 1], [7, 7, 0]]), 8, 8);
  assert.equal(boundsToRect(bounds), null);
  assert.equal(computeCrop(bounds, { width: 8, height: 8 }, GUARD_PX), null);
});

test('偶数对齐：起点向下、终点向上，越界收回画布', () => {
  assert.deepEqual(alignEvenRect({ x: 3, y: 5, width: 4, height: 4 }, { width: 16, height: 16 }), {
    x: 2,
    y: 4,
    width: 6,
    height: 6,
  });
  assert.deepEqual(alignEvenRect({ x: -2, y: -2, width: 4, height: 4 }, { width: 16, height: 16 }), {
    x: 0,
    y: 0,
    width: 2,
    height: 2,
  });
  assert.deepEqual(alignEvenRect({ x: 10, y: 10, width: 6, height: 6 }, { width: 16, height: 16 }), {
    x: 10,
    y: 10,
    width: 6,
    height: 6,
  });
  assert.throws(() => alignEvenRect({ x: 0, y: 0, width: 4, height: 4 }, { width: 15, height: 16 }), /偶数/);
});

test('裁框外 alpha>1 像素必须能被数出来（契约要求为 0）', () => {
  const frame = makeFrame(16, 16, [[0, 0, 255], [9, 9, 255], [15, 15, 3]]);
  const rect = { x: 8, y: 8, width: 4, height: 4 };
  assert.equal(countAlphaAboveOutside(frame, 16, 16, rect), 2);
  const covered = { x: 0, y: 0, width: 16, height: 16 };
  assert.equal(countAlphaAboveOutside(frame, 16, 16, covered), 0);
});

test('RGBA 字节数与画布不符直接报错，不静默截断', () => {
  assert.throws(() => accumulateAlphaBounds(emptyBounds(), new Uint8Array(8), 8, 8), /RGBA 字节数不符/);
  assert.throws(() => countAlphaAbove(new Uint8Array(4), 0, 8), /画布尺寸非法/);
});

test('PTS 摘要来自逐帧值：步长与相邻差', () => {
  const summary = summarizePts([0, 40, 90]);
  assert.deepEqual(summary, { count: 3, firstMs: 0, lastMs: 90, stepMs: 45, minDeltaMs: 40, maxDeltaMs: 50 });
  assert.throws(() => summarizePts([]), /PTS 为空/);
  assert.throws(() => summarizePts([0, Number.NaN]), /非法/);
});

function ptsFixture(): number[] {
  // 24fps、时间基 1/1000 时的真实形态：41/42 交替
  const values: number[] = [];
  for (let index = 0; index < IDLE_FRAME_COUNT; index += 1) values.push(Math.round((index * 1000) / 24));
  return values;
}

function validManifest(): Record<string, unknown> {
  const manifest = buildManifest({
    sourceSha256: 'a'.repeat(64),
    candidateSha256: 'b'.repeat(64),
    originalCanvas: CANVAS,
    crop: CONTRACT_CROP,
    colorTags: COLOR_TAGS,
    frameCount: IDLE_FRAME_COUNT,
    pts: summarizePts(ptsFixture()),
    durationMs: 1999,
    ffmpeg: 'ffmpeg version 8.0.1 Copyright (c) 2000-2025 the FFmpeg developers',
    builtAt: '2026-11-10T00:00:00.000Z',
  });
  return structuredClone(manifest) as unknown as Record<string, unknown>;
}

function cloneManifest(): Record<string, unknown> {
  return structuredClone(validManifest());
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('不是对象');
  return value as Record<string, unknown>;
}

test('合法 manifest 通过严格校验', () => {
  const result = validateManifest(validManifest());
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  const manifest = validManifest();
  assert.equal(manifest['kind'], 'idle-roi');
  assert.equal(manifest['alphaThreshold'], 1);
  assert.equal(manifest['guard'], 2);
  assert.equal(manifest['pixelFormat'], 'yuva420p');
  assert.equal(manifest['pts'] === undefined, false);
});

test('manifest：缺字段、NaN、越界、非偶数、sha 不符都拒绝', () => {
  const cases: ReadonlyArray<readonly [string, (manifest: Record<string, unknown>) => void]> = [
    ['缺 sourceSha256', (m) => delete m['sourceSha256']],
    ['缺 crop', (m) => delete m['crop']],
    ['缺 pts', (m) => delete m['pts']],
    ['sha 不是 64 位十六进制', (m) => { m['sourceSha256'] = 'xyz'; }],
    ['candidateSha 大写', (m) => { m['candidateSha256'] = 'B'.repeat(64); }],
    ['crop 横向越界', (m) => { record(m['crop'])['width'] = 440; }],
    ['crop 纵向越界', (m) => { record(m['crop'])['height'] = 360; }],
    ['crop 宽为奇数', (m) => { record(m['crop'])['width'] = 227; }],
    ['crop 高为 0', (m) => { record(m['crop'])['height'] = 0; }],
    ['crop.x 为负', (m) => { record(m['crop'])['x'] = -2; }],
    ['pts.lastMs 是 NaN', (m) => { record(m['pts'])['lastMs'] = Number.NaN; }],
    ['pts.count 与 frameCount 不符', (m) => { record(m['pts'])['count'] = IDLE_FRAME_COUNT - 1; }],
    ['pts 步长为 0', (m) => { record(m['pts'])['stepMs'] = 0; }],
    ['frameCount 不足全片', (m) => { m['frameCount'] = IDLE_FRAME_COUNT - 1; }],
    ['loopFrames 不等于帧数', (m) => { m['loopFrames'] = 1; }],
    ['durationMs 是 NaN', (m) => { m['durationMs'] = Number.NaN; }],
    ['durationMs 早于最后一帧', (m) => { m['durationMs'] = 100; }],
    ['colorTags 缺 range', (m) => delete record(m['colorTags'])['range']],
    ['colorTags 非法范围', (m) => { record(m['colorTags'])['range'] = 'weird'; }],
    ['alphaThreshold 被提高', (m) => { m['alphaThreshold'] = 16; }],
    ['guard 被改', (m) => { m['guard'] = 0; }],
    ['codec 不符', (m) => { m['codec'] = 'vp8'; }],
    ['pixelFormat 不符', (m) => { m['pixelFormat'] = 'yuv420p'; }],
    ['ffmpeg 不是版本行', (m) => { m['ffmpeg'] = 'unknown'; }],
    ['builtAt 不是时间', (m) => { m['builtAt'] = 'yesterday'; }],
  ];
  for (const [label, mutate] of cases) {
    const manifest = cloneManifest();
    mutate(manifest);
    const result = validateManifest(manifest);
    assert.equal(result.ok, false, `应拒绝：${label}`);
    assert.ok(result.errors.length > 0, `缺少原因：${label}`);
  }
  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest([]).ok, false);
});

test('F/C 编码参数逐字相同，只差 crop 与输出', () => {
  const base = { input: 'assets/idle.webm', crf: DEFAULT_CRF, cpuUsed: DEFAULT_CPU_USED, gop: DEFAULT_GOP };
  const fArgs = encodeArgs({ ...base, output: 'F.webm', crop: null });
  const cArgs = encodeArgs({ ...base, output: 'C.webm', crop: CONTRACT_CROP });

  const filterIndex = fArgs.indexOf('-vf') + 1;
  assert.equal(fArgs[filterIndex], preprocessFilter(null));
  assert.equal(cArgs[filterIndex], preprocessFilter(CONTRACT_CROP));
  assert.equal(preprocessFilter(null), `${alphaZeroFilter()},format=yuva420p`);
  assert.equal(preprocessFilter(CONTRACT_CROP), `${alphaZeroFilter()},crop=226:286:208:52,format=yuva420p`);
  assert.equal(alphaZeroFilter(), "format=rgba,lut=a='if(lte(val,1),0,val)'");
  assert.doesNotMatch(preprocessFilter(CONTRACT_CROP), /colorkey|chromakey|lumakey|geq|colorhold|hsvkey/);

  const rest = (args: readonly string[]): readonly string[] =>
    args.filter((_, index) => index !== filterIndex && index !== args.length - 1);
  assert.deepEqual(rest(fArgs), rest(cArgs));
  assert.equal(fArgs.at(-1), 'F.webm');
  assert.equal(cArgs.at(-1), 'C.webm');

  assert.equal(fArgs[fArgs.indexOf('-pix_fmt') + 1], 'yuva420p');
  assert.equal(fArgs[fArgs.indexOf('-crf') + 1], String(DEFAULT_CRF));
  assert.equal(fArgs[fArgs.indexOf('-auto-alt-ref') + 1], '0');
  assert.equal(fArgs[fArgs.indexOf('-fps_mode') + 1], 'passthrough');
  assert.equal(fArgs[fArgs.indexOf('-cpu-used') + 1], String(DEFAULT_CPU_USED));
  assert.ok(fArgs.includes('alpha_mode=1'));
  assert.equal(fArgs.filter((arg) => arg === 'libvpx-vp9').length, 2, '解码与编码都显式指定 libvpx-vp9');
  assert.ok(fArgs.includes('-row-mt'));
});

test('编码参数非法直接拒绝，不带着坏参数出去', () => {
  const base = { input: 'in.webm', output: 'out.webm', crop: null };
  assert.throws(() => encodeArgs({ ...base, crf: Number.NaN, cpuUsed: 2, gop: 48 }), /crf 非法/);
  assert.throws(() => encodeArgs({ ...base, crf: 12, cpuUsed: 99, gop: 48 }), /cpu-used 非法/);
  assert.throws(() => encodeArgs({ ...base, crf: 12, cpuUsed: 2, gop: 0 }), /gop 非法/);
});

test('编码失败不留半成品：无目标文件、无 .partial', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'idle-roi-'));
  const output = path.join(dir, 'F.webm');
  const options = { input: 'assets/idle.webm', output, crop: null, crf: DEFAULT_CRF, cpuUsed: DEFAULT_CPU_USED, gop: DEFAULT_GOP };
  let seen: readonly string[] = [];
  await assert.rejects(
    () =>
      encodeTo('ffmpeg', options, async (_bin, args) => {
        seen = args;
        await writeFile(args[args.length - 1]!, 'partial');
        throw new Error('编码器炸了');
      }),
    /编码器炸了/,
  );
  assert.equal(seen.at(-1), `${output}.partial`);
  await assert.rejects(() => stat(output), /ENOENT/);
  await assert.rejects(() => stat(`${output}.partial`), /ENOENT/);
  assert.deepEqual(await readdir(dir), []);
});

test('编码成功才改名到目标文件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'idle-roi-'));
  const output = path.join(dir, 'C.webm');
  const options = { input: 'assets/idle.webm', output, crop: CONTRACT_CROP, crf: DEFAULT_CRF, cpuUsed: DEFAULT_CPU_USED, gop: DEFAULT_GOP };
  await encodeTo('ffmpeg', options, async (_bin, args) => {
    await writeFile(args[args.length - 1]!, 'webm');
  });
  assert.equal((await stat(output)).size, 4);
  assert.deepEqual(await readdir(dir), ['C.webm']);
});

test('sha256：字节与文件一致', async () => {
  const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(sha256Hex(Buffer.from('abc')), expected);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'idle-roi-'));
  const file = path.join(dir, 'abc.bin');
  await writeFile(file, 'abc');
  assert.equal(await sha256File(file), expected);
});
