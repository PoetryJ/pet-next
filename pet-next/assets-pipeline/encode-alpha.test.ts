/**
 * 编码参数必须带上 alpha，并且不能出现抠黑滤镜。
 * 候选交付的断言也放在这个文件里：纯函数套件的文件名清单是冻结的。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AssetCandidateManifest } from '../contracts/asset-candidate.ts';
import { parseCandidateArgs } from './candidate-cli.ts';
import {
  CANDIDATE_MANIFEST,
  CANDIDATE_NOTE,
  CANDIDATE_OUTPUT,
  CANDIDATE_PLATES,
  CANDIDATE_PROVENANCE,
  CANDIDATE_SOURCE,
  ORIGINAL_REACTION_REPO_PATH,
  PLATE_FRAMES,
  SHIPPED_PLATE_FRAMES,
  SHIPPED_PLATES,
  SHIPPED_REACTION,
  candidatePathError,
  deliverReactionCandidate,
  isLockedAsset,
  reproductionCommand,
  type CandidateProvenance,
} from './deliver-candidate.ts';
import { observeDarkForeground } from './frame-metrics.ts';
import { decodeRgba, probeVideo } from './read-media.ts';
import { filterDeletesNearBlack, preserveAlphaEncodeCommand } from './encode-alpha.ts';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('VP9 编码保留 yuva，并在解码端指定 libvpx', () => {
  const command = preserveAlphaEncodeCommand('ffmpeg', 'in.webm', 'out.webm', { x: 2, y: 4, width: 16, height: 18 }, 'vp9');
  const filter = command[command.indexOf('-vf') + 1] ?? '';
  assert.equal(filter, 'crop=16:18:2:4,format=yuva420p');
  assert.equal(filterDeletesNearBlack(filter), false);
  assert.ok(command.includes('libvpx-vp9'));
  assert.equal(command[command.indexOf('-auto-alt-ref') + 1], '0');
  assert.equal(command[command.indexOf('-pix_fmt') + 1], 'yuva420p');
  assert.equal(command.at(-1), 'out.webm');
});

test('色键和 geq 算作删除近黑', () => {
  assert.equal(filterDeletesNearBlack('crop=2:2:0:0,format=yuva420p'), false);
  assert.equal(filterDeletesNearBlack('colorkey=0x000000:0.1:0.1'), true);
  assert.equal(filterDeletesNearBlack('format=yuva420p,chromakey=black'), true);
  assert.equal(filterDeletesNearBlack('geq=r=r:a=if(lt(r,16),0,255)'), true);
});

test('候选路径不能盖住成品，也不能逃出 pet-next', () => {
  assert.equal(isLockedAsset('assets/reaction.webm'), true);
  assert.equal(isLockedAsset('assets/candidates/reaction/reaction.webm'), false);
  assert.match(candidatePathError(petRoot, CANDIDATE_SOURCE, 'assets/reaction.webm', CANDIDATE_PLATES) ?? '', /锁定/);
  assert.match(candidatePathError(petRoot, '../outside.webm', CANDIDATE_OUTPUT, CANDIDATE_PLATES) ?? '', /超出/);
  assert.match(candidatePathError(petRoot, CANDIDATE_SOURCE, 'assets/reaction-next.webm', CANDIDATE_PLATES) ?? '', /只能写到/);
  assert.equal(parseCandidateArgs(['--nope']).ok, false);
});

test('色键命令在读源之前就被拒绝', async () => {
  const rejected = await deliverReactionCandidate({
    petRoot,
    sourceRelativePath: 'assets-pipeline/out/cases/candidate-reject/source.webm',
    outputRelativePath: 'assets-pipeline/out/cases/candidate-reject/out.webm',
    platesDirRelative: 'assets-pipeline/out/cases/candidate-reject/plates',
    plateFrameIndexes: [0],
    command: ['ffmpeg', '-vf', 'colorkey=0x000000:0.1:0.1'],
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.match(rejected.limitation, /色键/);
});

test('没有可用 alpha 的源不会写出候选', { timeout: 30_000 }, async () => {
  const dir = path.join(petRoot, 'assets-pipeline', 'out', 'cases', 'candidate-flat');
  const source = await encodeTiny(dir, 'flat', () => [12, 12, 12, 255], false);
  const output = path.join(dir, 'out.webm');
  const delivered = await deliverReactionCandidate({
    petRoot,
    sourceRelativePath: relative(source),
    outputRelativePath: relative(output),
    platesDirRelative: relative(path.join(dir, 'plates')),
    plateFrameIndexes: [0],
    command: ['node', 'candidate-cli.ts'],
  });
  assert.equal(delivered.ok, false);
  if (!delivered.ok) assert.match(delivered.limitation, /删除近黑|没有可用的 alpha/);
  await assert.rejects(stat(output));
});

test('有深色前景的 alpha 源按字节复制，并写出三背景', { timeout: 30_000 }, async () => {
  const dir = path.join(petRoot, 'assets-pipeline', 'out', 'cases', 'candidate-dark');
  const source = await encodeTiny(dir, 'dark', (x, y) => (inSquare(x, y) ? [0, 0, 0, 255] : [0, 0, 0, 0]), true);
  const output = path.join(dir, 'out.webm');
  const delivered = await deliverReactionCandidate({
    petRoot,
    sourceRelativePath: relative(source),
    outputRelativePath: relative(output),
    platesDirRelative: relative(path.join(dir, 'plates')),
    plateFrameIndexes: [0],
    command: ['node', 'candidate-cli.ts'],
  });
  assert.equal(delivered.ok, true);
  if (!delivered.ok) return;
  assert.equal(delivered.manifest.kind, 'alpha-source');
  assert.equal(delivered.manifest.limitation, null);
  assert.equal(delivered.manifest.sourceSha256, delivered.manifest.outputSha256);
  assert.equal(delivered.manifest.sourceSha256, sha256(await readFile(source)));
  assert.deepEqual(
    delivered.manifest.plates.map((plate) => plate.background),
    ['light', 'dark', 'checker'],
  );
  const dark = delivered.manifest.plates.find((plate) => plate.background === 'dark');
  assert.ok(dark);
  const png = await readFile(path.join(petRoot, dark.imagePath));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('已交付的 reaction 候选是母版字节，深色前景还在，成品没被改写', { timeout: 60_000 }, async () => {
  const before = {
    'assets/idle.webm': '6ebca6b20bcce978f5a52f8333212784b3a642d0b8803c630a455439ebb7df1a',
    'assets/reaction.webm': '9d73e16ca8d9abcfff96a41d9e98f632a241691ddf81b59538b16a6e77049861',
    'assets/placeholder.png': 'cef548d332264a6ffc9440679da983c0be61e34ed2b41f879fce150647d41dc8',
  };
  for (const [rel, expected] of Object.entries(before)) {
    assert.equal(sha256(await readFile(path.join(petRoot, rel))), expected, rel);
  }
  const manifest = JSON.parse(await readFile(path.join(petRoot, CANDIDATE_MANIFEST), 'utf8')) as AssetCandidateManifest;
  const provenance = JSON.parse(await readFile(path.join(petRoot, CANDIDATE_PROVENANCE), 'utf8')) as CandidateProvenance;
  const mother = sha256(await readFile(path.resolve(petRoot, '..', ORIGINAL_REACTION_REPO_PATH)));
  assert.equal(manifest.role, 'reaction');
  assert.equal(manifest.kind, 'alpha-source');
  assert.equal(manifest.limitation, null);
  assert.equal(manifest.sourcePath, CANDIDATE_SOURCE);
  assert.equal(manifest.outputPath, CANDIDATE_OUTPUT);
  assert.equal(manifest.sourceSha256, mother);
  assert.equal(manifest.outputSha256, mother);
  assert.equal(sha256(await readFile(path.join(petRoot, CANDIDATE_SOURCE))), mother);
  assert.equal(sha256(await readFile(path.join(petRoot, CANDIDATE_OUTPUT))), mother);
  assert.deepEqual(manifest.command, reproductionCommand());
  assert.equal(manifest.command.some((part) => filterDeletesNearBlack(part)), false);
  assert.equal(provenance.sourceMatchesOriginalBytes, true);
  assert.equal(provenance.webmStep, 'byte-copy');
  assert.equal(provenance.encodeFilter, null);
  assert.equal(provenance.defaultReplaced, false);
  assert.equal(provenance.verdict, 'pass');
  assert.equal(provenance.note, CANDIDATE_NOTE);
  assert.equal(provenance.shipped.sha256, before[SHIPPED_REACTION]);
  assert.equal(provenance.shipped.frames.every((frame) => frame.usableAlpha === false), true);
  const backgrounds = ['light', 'dark', 'checker'];
  for (const frameIndex of PLATE_FRAMES) {
    for (const background of backgrounds) {
      const plate = manifest.plates.find((item) => item.imagePath.endsWith(`frame-${frameIndex}-${background}.png`));
      assert.ok(plate);
      const info = await stat(path.join(petRoot, plate.imagePath));
      assert.equal(info.size > 20_000, true, plate.imagePath);
    }
  }
  for (const frameIndex of SHIPPED_PLATE_FRAMES) {
    for (const background of backgrounds) {
      const info = await stat(path.join(petRoot, SHIPPED_PLATES, `frame-${frameIndex}-${background}.png`));
      assert.equal(info.size < 20_000, true, `shipped ${frameIndex} ${background}`);
    }
  }
  const output = path.join(petRoot, CANDIDATE_OUTPUT);
  const video = await probeVideo('ffprobe', output);
  const decoded = await decodeRgba('ffmpeg', output, video, PLATE_FRAMES[1] ?? 84);
  const frame = decoded?.[0];
  assert.ok(frame);
  assert.equal(observeDarkForeground(frame), true);
});

function relative(file: string): string {
  return path.relative(petRoot, file).split(path.sep).join('/');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inSquare(x: number, y: number): boolean {
  return x >= 8 && x < 24 && y >= 8 && y < 24;
}

async function encodeTiny(
  dir: string,
  name: string,
  paint: (x: number, y: number) => readonly [number, number, number, number],
  alpha: boolean,
): Promise<string> {
  const width = 32;
  const height = 32;
  const frames = 2;
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
