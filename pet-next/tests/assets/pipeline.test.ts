/**
 * 用夹具跑 `assets:check`：有 alpha 才编码，没有就停，背景色字符串不改结论。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AssetProcessReport } from '../../contracts/assets.ts';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const cli = path.join(petRoot, 'assets-pipeline', 'cli.ts');
const shipped = ['assets/idle.webm', 'assets/reaction.webm', 'assets/placeholder.png'];

test('背景色字符串不能把没有 alpha 的源说成通过', { timeout: 30_000 }, async () => {
  const before = await shippedHashes();
  const dir = path.join(petRoot, 'assets-pipeline', 'out', 'cases', 'no-alpha');
  const source = await encodeFixture(dir, 'flat', () => [12, 12, 12, 255], false);
  const report = await runCheck(source, dir, ['--background-color', '#00000000']);
  assert.equal(report.code, 0, report.stderr);
  assert.equal(report.body.verdict, 'source-lacks-alpha');
  assert.equal(report.body.backgroundColorString, '#00000000');
  assert.equal(report.body.output, null);
  assert.deepEqual(report.body.evidence.frames, []);
  assert.equal(report.body.source.hasAlpha, false);
  assert.equal(report.body.limitation?.includes('删除近黑'), true);
  assert.equal(report.body.command.some((part) => part.includes('colorkey')), false);
  assert.deepEqual(await shippedHashes(), before);
});

test('有深色前景的 alpha 源：保留通道、三背景对照，且换背景色字符串仍通过', { timeout: 60_000 }, async () => {
  const dir = path.join(petRoot, 'assets-pipeline', 'out', 'cases', 'dark');
  const source = await encodeFixture(dir, 'dark', (x, y) => (inSquare(x, y) ? [0, 0, 0, 255] : [0, 0, 0, 0]), true);
  const transparent = await runCheck(source, path.join(dir, 'a'), ['--background-color', '#00000000']);
  const opaque = await runCheck(source, path.join(dir, 'b'), ['--background-color', '#010203']);
  assert.equal(transparent.code, 0, transparent.stderr);
  assert.equal(opaque.code, 0, opaque.stderr);
  assert.equal(transparent.body.verdict, 'pass');
  assert.equal(opaque.body.verdict, 'pass');
  assert.equal(transparent.body.backgroundColorString, '#00000000');
  assert.equal(opaque.body.backgroundColorString, '#010203');
  assert.equal(transparent.body.limitation, null);
  assert.ok(transparent.body.output);
  assert.equal(transparent.body.output.hasAlpha, true);
  assert.equal(transparent.body.output.byteLength > 0, true);
  assert.equal(transparent.body.source.sha256, createHash('sha256').update(await readFile(source)).digest('hex'));
  const filter = transparent.body.command[transparent.body.command.indexOf('-vf') + 1] ?? '';
  assert.match(filter, /^crop=\d+:\d+:\d+:\d+,format=yuva420p$/);
  assert.equal(filter.includes('colorkey') || filter.includes('chromakey') || filter.includes('geq'), false);
  const dark = transparent.body.evidence.frames.find((frame) => frame.background === 'dark');
  assert.ok(dark);
  assert.equal(dark.darkForegroundVisible, true);
  assert.deepEqual(
    transparent.body.evidence.frames.map((frame) => frame.background).sort(),
    ['checker', 'dark', 'light'],
  );
  assert.equal(new Set(transparent.body.evidence.frames.map((frame) => frame.frameIndex)).size, 1);
  const png = await readFile(path.join(petRoot, dark.imagePath));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('只有亮色前景时深色检查是 unobserved，结论为 fail', { timeout: 30_000 }, async () => {
  const dir = path.join(petRoot, 'assets-pipeline', 'out', 'cases', 'bright');
  const source = await encodeFixture(dir, 'bright', (x, y) => (inSquare(x, y) ? [240, 240, 240, 255] : [0, 0, 0, 0]), true);
  const report = await runCheck(source, dir, []);
  assert.equal(report.code, 1, report.stderr);
  assert.equal(report.body.verdict, 'fail');
  const dark = report.body.evidence.frames.find((frame) => frame.background === 'dark');
  assert.equal(dark?.darkForegroundVisible, 'unobserved');
  assert.match(report.body.limitation ?? '', /深色前景/);
});

test('容器标了 alpha_mode 但没有不透明像素时停住，不补抠', { timeout: 30_000 }, async () => {
  const dir = path.join(petRoot, 'assets-pipeline', 'out', 'cases', 'tag-only');
  const source = await encodeFixture(dir, 'thin', (x, y) => (inSquare(x, y) ? [40, 40, 40, 100] : [0, 0, 0, 0]), true);
  const report = await runCheck(source, dir, ['--background-color', '#00000000']);
  assert.equal(report.code, 0, report.stderr);
  assert.equal(report.body.verdict, 'source-lacks-alpha');
  assert.equal(report.body.source.alphaMode, '1');
  assert.equal(report.body.source.hasAlpha, false);
  assert.equal(report.body.output, null);
  assert.equal(report.body.backgroundColorString, '#00000000');
  assert.match(report.body.limitation ?? '', /alpha_mode=1/);
  assert.match(report.body.limitation ?? '', /删除近黑/);
});

test('ffprobe 不存在时是 fail，而不是 source-lacks-alpha', { timeout: 15_000 }, async () => {
  const dir = path.join(petRoot, 'assets-pipeline', 'out', 'cases', 'missing-tool');
  await mkdir(dir, { recursive: true });
  const source = path.join(dir, 'empty.webm');
  await writeFile(source, Buffer.from('not a video'));
  const report = await runCheck(source, dir, ['--ffprobe', '/no/such/ffprobe']);
  assert.equal(report.code, 1, report.stderr);
  assert.equal(report.body.verdict, 'fail');
  assert.match(report.body.limitation ?? '', /ffprobe/);
  assert.equal(report.body.source.sha256.length, 64);
});

function inSquare(x: number, y: number): boolean {
  return x >= 8 && x < 24 && y >= 8 && y < 24;
}

async function shippedHashes(): Promise<string[]> {
  const hashes: string[] = [];
  for (const relative of shipped) {
    const bytes = await readFile(path.join(petRoot, relative));
    hashes.push(createHash('sha256').update(bytes).digest('hex'));
  }
  return hashes;
}

async function runCheck(
  source: string,
  outDir: string,
  extra: readonly string[],
): Promise<{ code: number; stderr: string; body: AssetProcessReport }> {
  const relativeSource = path.relative(petRoot, source).split(path.sep).join('/');
  const relativeOut = path.relative(petRoot, outDir).split(path.sep).join('/');
  const result = await runNode(['--experimental-strip-types', cli, '--out', relativeOut, ...extra, relativeSource]);
  const body = JSON.parse(await readFile(path.join(outDir, 'report.json'), 'utf8')) as AssetProcessReport;
  return { code: result.code, stderr: result.stderr, body };
}

async function encodeFixture(
  dir: string,
  name: string,
  paint: (x: number, y: number) => readonly [number, number, number, number],
  alpha: boolean,
): Promise<string> {
  const width = 32;
  const height = 32;
  const frames = 4;
  const rgba = Buffer.alloc(width * height * 4 * frames);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const [red, green, blue, pixelAlpha] = paint(x, y);
        const offset = (frame * width * height + y * width + x) * 4;
        rgba[offset] = red;
        rgba[offset + 1] = green;
        rgba[offset + 2] = blue;
        rgba[offset + 3] = pixelAlpha;
      }
    }
  }
  await mkdir(dir, { recursive: true });
  const raw = path.join(dir, `${name}.raw`);
  const webm = path.join(dir, `${name}.webm`);
  if (alpha) {
    await writeFile(raw, rgba);
    await ffmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '32x32', '-r', '10', '-i', raw, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-metadata:s:v:0', 'alpha_mode=1', '-b:v', '0', '-crf', '10', '-an', webm]);
    return webm;
  }
  const rgb = Buffer.alloc(width * height * 3 * frames);
  for (let pixel = 0; pixel < width * height * frames; pixel += 1) {
    rgb[pixel * 3] = rgba[pixel * 4] ?? 0;
    rgb[pixel * 3 + 1] = rgba[pixel * 4 + 1] ?? 0;
    rgb[pixel * 3 + 2] = rgba[pixel * 4 + 2] ?? 0;
  }
  await writeFile(raw, rgb);
  await ffmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '32x32', '-r', '10', '-i', raw, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', '10', '-an', webm]);
  return webm;
}

function ffmpeg(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error)));
      else resolve();
    });
  });
}

function runNode(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: petRoot }, (error, _stdout, stderr) => {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : 0;
      resolve({ code, stderr: String(stderr ?? '') });
    });
  });
}
