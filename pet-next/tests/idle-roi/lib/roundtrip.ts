/**
 * 【旧装置的保留件，本轮不参与判定】RGBA 路径的自往返测量。
 *
 * 它把 O 解码成 RGBA，再以 `-f rawvideo -pix_fmt rgba` 重新编码，最后量离 O 有多远。
 * **这条链必然经过 YUV→RGB→YUV**，所以它测出来的差是「这条 RGBA 路径的往返损失」，
 * 不能外推成「任何重编码都过不了门」，也不构成编码格式的数学下界。
 *
 * 为什么还留着：报告里要能回答「旧结论 1.151 是怎么来的」。现在这条职责由两件更直接的事取代——
 * `out-v3-yuva` 的原生 YUVA 直通自对照（不经 RGB，看平面本身变不变）
 * 与 F3–C3 真实字节成对（同参数、只差 crop，看裁边本身）。
 * 因此 `quality.test.ts` 默认不跑它，只在 `PET_NEXT_IDLE_ROI_ROUNDTRIP=1` 时回看。
 *
 * 产物全写进调用方给的临时目录（os.tmpdir），不入库。
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runMediaTool } from './tool.ts';
import { FIXTURE_CROP, encodeCommand, petRoot } from './arms.ts';
import { decodeAllFrames, openRaw } from './media.ts';
import { alphaStats, applyAlphaFloor, compositeFrame, diffStats, edgeMask, foregroundMask, restoreCrop } from './pixels.ts';

export interface RegionError {
  readonly mae: number;
  readonly p99: number;
  readonly max: number;
}

export interface RoundtripVariant {
  readonly id: string;
  readonly pixelFormat: string;
  readonly crf: number;
  readonly losslessFlag: boolean;
  readonly bytes: number;
  /** 最差一帧/一种底下的前景区误差，单位 LSB。 */
  readonly foreground: RegionError & { readonly frame: number; readonly plate: string };
  readonly edge: RegionError & { readonly frame: number; readonly plate: string };
  readonly alphaMax: number;
}

export interface GeometryControl {
  readonly note: string;
  readonly settings: { readonly pixelFormat: string; readonly crf: number; readonly losslessFlag: boolean };
  readonly fToC: { readonly maxComposite: number; readonly maxAlpha: number; readonly samplesOver2: number };
  readonly bytes: { readonly F: number; readonly C: number };
}

export interface RoundtripReport {
  readonly variants: readonly RoundtripVariant[];
  readonly geometry: GeometryControl | null;
}

interface VariantSpec {
  readonly id: string;
  readonly pixelFormat: string;
  readonly crf: number;
  readonly losslessFlag: boolean;
}

/** 默认跑三档：444 无损、444 + `-lossless 1`、420 无损（120 用于看色度下采样的贡献）。 */
export const DEFAULT_ROUNDTRIP_SPECS: readonly VariantSpec[] = [
  { id: 'O->O 444 crf0', pixelFormat: 'yuva444p', crf: 0, losslessFlag: false },
  { id: 'O->O 444 lossless1', pixelFormat: 'yuva444p', crf: 0, losslessFlag: true },
  { id: 'O->O 420 crf0', pixelFormat: 'yuva420p', crf: 0, losslessFlag: false },
];

/** 逐帧把 references 与 candidate 在三种底上比一遍，返回最差的前景/边缘误差。 */
function frameError(original: Buffer, candidate: Buffer, width: number, height: number, threshold: number): {
  foreground: RegionError & { frame: number; plate: string };
  edge: RegionError & { frame: number; plate: string };
  alphaMax: number;
  frame: number;
} {
  const left = Buffer.alloc(width * height * 3);
  const right = Buffer.alloc(width * height * 3);
  const fgMask = foregroundMask(original, width, height, threshold);
  const edMask = edgeMask(original, width, height, threshold, 2, 64);
  let foreground = { mae: 0, p99: 0, max: 0, frame: -1, plate: '' };
  let edge = { mae: 0, p99: 0, max: 0, frame: -1, plate: '' };
  let alphaMax = 0;
  const alpha = alphaStats(original, candidate, null);
  if (alpha.max > alphaMax) alphaMax = alpha.max;
  for (const plate of ['black', 'white', 'checker'] as const) {
    compositeFrame(original, width, height, plate, left);
    compositeFrame(candidate, width, height, plate, right);
    const fg = diffStats(left, right, fgMask);
    if (fg.mae > foreground.mae) foreground = { mae: fg.mae, p99: fg.p99, max: fg.max, frame: 0, plate };
    const ed = diffStats(left, right, edMask);
    if (ed.mae > edge.mae) edge = { mae: ed.mae, p99: ed.p99, max: ed.max, frame: 0, plate };
  }
  return { foreground, edge, alphaMax, frame: 0 };
}

/**
 * 跑完所有对照。`workDir` 是临时目录（裸帧与 webm 都落这里，不提交）。
 *
 * 结论口径（报告里也必须这么说）：这些变体都经过 RGBA→YUV，"过不了门"只说明
 * 当前这条含 RGB 转换的路径及所试参数过不了，不是所有编码参数/所有路线的下界。
 */
export async function measureRoundtripFloor(workDir: string, specs: readonly VariantSpec[] = DEFAULT_ROUNDTRIP_SPECS): Promise<RoundtripReport> {
  const source = path.join(petRoot(), 'assets', 'idle.webm');
  const decoded = await decodeAllFrames(source, workDir, 'roundtrip-source');
  const width = decoded.width;
  const height = decoded.height;
  const sourceReader = openRaw(decoded);
  const original = Buffer.alloc(decoded.frameBytes);
  const variants: RoundtripVariant[] = [];

  for (const spec of specs) {
    const out = path.join(workDir, `roundtrip-${spec.pixelFormat}-crf${spec.crf}${spec.losslessFlag ? '-ll' : ''}.webm`);
    await runMediaTool(encodeCommand(decoded.rawPath, out, width, height, null, spec.crf, { pixelFormat: spec.pixelFormat, losslessFlag: spec.losslessFlag }), 300_000);
    const arm = await decodeAllFrames(out, workDir, `roundtrip-decode-${spec.pixelFormat}-${spec.crf}-${spec.losslessFlag ? 'll' : 'x'}`);
    const reader = openRaw(arm);
    const candidate = Buffer.alloc(arm.frameBytes);
    let foreground = { mae: 0, p99: 0, max: 0, frame: -1, plate: '' };
    let edge = { mae: 0, p99: 0, max: 0, frame: -1, plate: '' };
    let alphaMax = 0;
    try {
      for (let frame = 0; frame < Math.min(decoded.frameCount, arm.frameCount); frame += 1) {
        sourceReader.read(frame, original);
        reader.read(frame, candidate);
        const worst = frameError(original, candidate, width, height, 1);
        if (worst.foreground.mae > foreground.mae) foreground = { ...worst.foreground, frame };
        if (worst.edge.mae > edge.mae) edge = { ...worst.edge, frame };
        if (worst.alphaMax > alphaMax) alphaMax = worst.alphaMax;
      }
    } finally {
      reader.close();
    }
    variants.push({
      id: spec.id,
      pixelFormat: spec.pixelFormat,
      crf: spec.crf,
      losslessFlag: spec.losslessFlag,
      bytes: statSync(out).size,
      foreground,
      edge,
      alphaMax,
    });
  }
  sourceReader.close();

  // 几何对照：同一份预处理，F 全画布、C 裁 crop，只用 444 无损，唯一变量是分辨率。
  const settings = { pixelFormat: 'yuva444p', crf: 0, losslessFlag: false };
  const prepared = path.join(workDir, 'roundtrip-prepared.rgba');
  const whole = Buffer.from(readFileSync(decoded.rawPath));
  for (let frame = 0; frame < decoded.frameCount; frame += 1) {
    applyAlphaFloor(whole.subarray(frame * decoded.frameBytes, (frame + 1) * decoded.frameBytes), 1);
  }
  writeFileSync(prepared, whole);
  const fFile = path.join(workDir, 'geometry-F.webm');
  const cFile = path.join(workDir, 'geometry-C.webm');
  await runMediaTool(encodeCommand(prepared, fFile, width, height, null, settings.crf, settings), 300_000);
  await runMediaTool(encodeCommand(prepared, cFile, width, height, FIXTURE_CROP, settings.crf, settings), 300_000);
  const fArm = await decodeAllFrames(fFile, workDir, 'geometry-F');
  const cArm = await decodeAllFrames(cFile, workDir, 'geometry-C');
  const fReader = openRaw(fArm);
  const cReader = openRaw(cArm);
  const fFrame = Buffer.alloc(fArm.frameBytes);
  const cFrame = Buffer.alloc(cArm.frameBytes);
  const restored = Buffer.alloc(width * height * 4);
  const left = Buffer.alloc(width * height * 3);
  const right = Buffer.alloc(width * height * 3);
  let maxComposite = 0;
  let maxAlpha = 0;
  let samplesOver2 = 0;
  try {
    for (let frame = 0; frame < Math.min(fArm.frameCount, cArm.frameCount); frame += 1) {
      fReader.read(frame, fFrame);
      cReader.read(frame, cFrame);
      restoreCrop(cFrame, FIXTURE_CROP, width, height, restored);
      const alpha = alphaStats(fFrame, restored, null);
      if (alpha.max > maxAlpha) maxAlpha = alpha.max;
      for (const plate of ['black', 'white', 'checker'] as const) {
        compositeFrame(fFrame, width, height, plate, left);
        compositeFrame(restored, width, height, plate, right);
        const stats = diffStats(left, right, null);
        if (stats.max > maxComposite) maxComposite = stats.max;
        samplesOver2 += stats.over2;
      }
    }
  } finally {
    fReader.close();
    cReader.close();
  }

  return {
    variants,
    geometry: {
      note: '预处理相同（alpha<=1→0）、编码参数相同，唯一变量是 F 全画布 / C 裁 crop → 这个 max 就是「裁边本身」的误差',
      settings,
      fToC: { maxComposite, maxAlpha, samplesOver2 },
      bytes: { F: statSync(fFile).size, C: statSync(cFile).size },
    },
  };
}
