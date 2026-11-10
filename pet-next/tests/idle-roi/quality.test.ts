/**
 * M3-12 画质门（C 的独立判定）。
 *
 * 只认 `experiments/idle-roi/out/` 里已提交的字节：O/F/C 三个 webm 加 manifest。
 * 全 48 帧独立解码（显式 `-c:v libvpx-vp9 -pix_fmt rgba`），不抽样、不只看首末帧。
 *
 * 判据逐条来自 `docs/M3-12-IDLE-ROI.md` 第 6 节，写在 `lib/gates.ts` 的 GATE_THRESHOLDS 里。
 * 门不过就让测试红，并把逐帧数值写进 `out/quality-report.json`——不放宽阈值、不改断言。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fixtureArmsDir, loadRealArms, petRoot, resolveArmsDir, type Arms } from './lib/arms.ts';
import {
  GATE_THRESHOLDS,
  coverageGate,
  fToCGate,
  layoutGate,
  measureReencodeBaseline,
  ocGate,
  overallVerdict,
  timelineGate,
  type GateResult,
} from './lib/gates.ts';
import { openRaw } from './lib/media.ts';
import { compositeFrame, restoreCrop } from './lib/pixels.ts';
import { writeCroppedCompositePng, writeErrorMapPng, writeJson } from './lib/report.ts';
import { measureRoundtripFloor } from './lib/roundtrip.ts';

const OUT = path.join(petRoot(), 'tests', 'idle-roi', 'out');
const FRAMES = path.join(OUT, 'frames');
const RERUN = 'env -u NODE_OPTIONS node --experimental-strip-types --test --test-reporter spec tests/idle-roi/*.test.ts';

function ffmpegVersion(): Promise<string> {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (error, stdout) => {
      if (error) resolve('missing');
      else resolve((stdout.split('\n')[0] ?? '').trim());
    });
  });
}

function gateFailureText(gate: GateResult): string {
  const head = `${gate.id}（${gate.title}）不过：判据「${gate.criteria}」`;
  const shown = gate.failures.slice(0, 12).join('\n  ');
  const more = gate.failures.length > 12 ? `\n  …还有 ${gate.failures.length - 12} 条` : '';
  return `${head}\n  ${shown}${more}\n  实测：${JSON.stringify(gate.metrics).slice(0, 1500)}`;
}

/** 关键帧证据：深色底上的原片/候选对照 + 误差放大图，共 3 张，只裁 crop 区域。 */
function writeKeyFrameEvidence(arms: Arms, frame: number): string[] {
  const { width, height } = arms.originalCanvas;
  const crop = arms.crop;
  const originalReader = openRaw(arms.O.raw);
  const candidateReader = openRaw(arms.C.raw);
  const original = Buffer.alloc(width * height * 4);
  const candidate = Buffer.alloc(arms.C.raw.frameBytes);
  const restored = Buffer.alloc(width * height * 4);
  const left = Buffer.alloc(width * height * 3);
  const right = Buffer.alloc(width * height * 3);
  try {
    originalReader.read(frame, original);
    candidateReader.read(frame, candidate);
    restoreCrop(candidate, crop, width, height, restored);
    compositeFrame(original, width, height, 'black', left);
    compositeFrame(restored, width, height, 'black', right);
    const tag = `frame-${String(frame).padStart(2, '0')}-crop${crop.x}x${crop.y}-black`;
    const originalPath = path.join(FRAMES, `${tag}-original.png`);
    const candidatePath = path.join(FRAMES, `${tag}-candidate.png`);
    const errorPath = path.join(FRAMES, `${tag}-error-x16.png`);
    writeCroppedCompositePng(originalPath, original, width, height, crop, 'black');
    writeCroppedCompositePng(candidatePath, restored, width, height, crop, 'black');
    writeErrorMapPng(errorPath, left, right, width, height, crop, 16);
    return [originalPath, candidatePath, errorPath];
  } finally {
    originalReader.close();
    candidateReader.close();
  }
}

test('M3-12 画质门：O/F/C 全 48 帧独立解码', async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'm312c-quality-'));
  try {
    const armsDir = resolveArmsDir();
    const loaded = await loadRealArms(armsDir, workDir);
    if (!loaded.arms) {
      writeJson(path.join(OUT, 'quality-report.json'), {
        schemaVersion: 1,
        kind: 'idle-roi-quality',
        status: 'not-run',
        generatedAt: new Date().toISOString(),
        reason: loaded.problems,
        armsDir,
        rerun: RERUN,
      });
      t.skip(`三臂未就绪：${loaded.problems.join('；')}`);
      return;
    }
    const arms = loaded.arms;
    const fToC = fToCGate(arms);
    const oc = ocGate(arms);
    const gates: GateResult[] = [coverageGate(arms), timelineGate(arms), layoutGate(arms), fToC, oc];
    const verdict = overallVerdict(gates);
    // 三样东西要分开：重编码往返的固有损失（O→F）、裁边的额外损失（O→C 减 O→F）、编码下限（O 自往返）。
    const oToF = measureReencodeBaseline(arms, 'F');
    const oToC = measureReencodeBaseline(arms, 'C');
    const roundtrip = await measureRoundtripFloor(workDir);
    const cropOnlyDelta = oToC.foreground.mae - oToF.foreground.mae;
    const firstFloor = roundtrip.variants[0];
    const bestFloor = firstFloor === undefined ? null : roundtrip.variants.reduce((best, item) => (item.foreground.mae < best.foreground.mae ? item : best), firstFloor);

    const worstFrame = Math.max(0, (oc.metrics.worstForeground as { frame?: number } | undefined)?.frame ?? 0);
    // 每次重写，避免旧帧号的图混进来把 PNG 预算撑破。
    rmSync(FRAMES, { recursive: true, force: true });
    mkdirSync(FRAMES, { recursive: true });
    const frames = writeKeyFrameEvidence(arms, worstFrame);
    const pngCount = readdirSync(FRAMES).filter((name) => name.endsWith('.png')).length;

    const bytesOf = (file: string): number => statSync(file).size;
    const bytes = { O: bytesOf(arms.O.file), F: bytesOf(arms.F.file), C: bytesOf(arms.C.file) };
    const cropArea = arms.crop.width * arms.crop.height;
    const canvasArea = arms.originalCanvas.width * arms.originalCanvas.height;
    const provenanceFile = path.join(fixtureArmsDir(), 'SOURCE.json');
    const provenance = existsSync(provenanceFile) ? (JSON.parse(readFileSync(provenanceFile, 'utf8')) as unknown) : null;
    const colorTags = arms.manifest?.colorTags ?? null;
    const colorTagsConsistent =
      colorTags !== null &&
      [arms.O, arms.F, arms.C].every((arm) => arm.stream.color.matrix === colorTags.matrix && arm.stream.color.range === colorTags.range);

    writeJson(path.join(OUT, 'quality-report.json'), {
      schemaVersion: 1,
      kind: 'idle-roi-quality',
      status: verdict.pass ? 'passed' : 'failed',
      generatedAt: new Date().toISOString(),
      armsDir,
      thresholds: GATE_THRESHOLDS,
      provenance,
      arms: {
        sourceSha256: arms.O.sha256,
        candidateSha256: arms.C.sha256,
        fSha256: arms.F.sha256,
        frameCount: { O: arms.O.raw.frameCount, F: arms.F.raw.frameCount, C: arms.C.raw.frameCount },
        stream: { O: arms.O.stream, F: arms.F.stream, C: arms.C.stream },
      },
      manifest: arms.manifest,
      colorTagsConsistent,
      cost: {
        bytes,
        bytesVsSource: { F: bytes.F - bytes.O, C: bytes.C - bytes.O },
        candidateVsFullCanvas: { deltaBytes: bytes.C - bytes.F, ratio: Number((bytes.C / bytes.F).toFixed(4)) },
        decodedArea: { cropArea, canvasArea, retainedRatio: Number((cropArea / canvasArea).toFixed(6)) },
        note: `ROI 省的是解码像素面积，不是文件体积：C ${bytes.C} 字节 > F ${bytes.F} 字节，多 ${bytes.C - bytes.F} 字节（+${((bytes.C / bytes.F - 1) * 100).toFixed(1)}%）；相对源片 O 则是 ${bytes.C - bytes.O} 字节/+${((bytes.C / bytes.O - 1) * 100).toFixed(1)}%。`,
      },
      comparison: {
        unit: 'LSB (1 LSB = 1/255 of full scale)',
        note: 'O→F 与 O→C 用同一套掩码、同一批帧、三种底；C↔F 只差裁边',
        rows: [
          { id: 'O->F', note: '纯重编码：全画布编码，不裁边，保留 alpha<=1 的背景', unit: 'LSB', ...oToF },
          { id: 'O->C', note: '重编码 + 裁边：实际采用的候选臂', unit: 'LSB', ...oToC },
          {
            id: 'C<->F',
            note: '只差裁边：C 按 crop 还原到 640×360 后与 F 比（就是 f-to-c 门）',
            unit: 'LSB',
            compositeMax: fToC.metrics.worstCompositeMax,
            alphaMax: fToC.metrics.worstAlphaMax,
            samplesOver2: fToC.metrics.samplesOver2,
          },
        ],
      },
      roundtripFloor: roundtrip,
      attribution: {
        verdict: 'f-to-c 与 o-to-c 不过，归因于 8-bit yuva420p 重编码往返，不是 ROI 裁边',
        numbers: {
          oToFMicroForegroundMaeLsb: oToF.foreground.mae,
          oToCMicroForegroundMaeLsb: oToC.foreground.mae,
          cropOnlyDeltaMaeLsb: Number(cropOnlyDelta.toFixed(4)),
          bestSelfRoundtrip: bestFloor === null ? null : { id: bestFloor.id, foregroundMaeLsb: bestFloor.foreground.mae, p99Lsb: bestFloor.foreground.p99, maxLsb: bestFloor.foreground.max },
        },
        evidence: [
          `O→F（不裁）：前景 MAE ${oToF.foreground.mae.toFixed(3)} LSB、P99 ${oToF.foreground.p99}、max ${oToF.foreground.max}；边缘 MAE ${oToF.edge.mae.toFixed(3)} LSB`,
          `O→C（裁边）：前景 MAE ${oToC.foreground.mae.toFixed(3)} LSB、P99 ${oToC.foreground.p99}、max ${oToC.foreground.max}；边缘 MAE ${oToC.edge.mae.toFixed(3)} LSB`,
          `两者之差 ${cropOnlyDelta.toFixed(3)} LSB 才是裁边的额外损失`,
          bestFloor === null ? '自往返对照没跑出来' : `O 自往返下限（不裁边、不置零，${bestFloor.id}）：前景 MAE ${bestFloor.foreground.mae.toFixed(3)} LSB、P99 ${bestFloor.foreground.p99}、max ${bestFloor.foreground.max}`,
          roundtrip.geometry === null ? '几何对照没跑出来' : `几何对照（444 无损、同参数、只差分辨率）：F–C max ${roundtrip.geometry.fToC.maxComposite} LSB、alpha max ${roundtrip.geometry.fToC.maxAlpha}`,
        ],
        cropErrorAgainstF: `几何本身为 0（见 roundtripFloor.geometry）；但这批 v1 字节用的是 crf 12，F–C max 实际是 ${fToC.metrics.worstCompositeMax} LSB，所以「裁边误差=0」只在同参数无损成对时成立`,
      },
      gates,
      verdict: { pass: verdict.pass, failed: verdict.failed },
      environment: { ffmpeg: await ffmpegVersion(), node: process.version },
      keyFrame: { frame: worstFrame, pngs: frames.map((file) => path.relative(petRoot(), file)), pngCount },
      rerun: RERUN,
    });

    for (const gate of gates) {
      await t.test(`${gate.id}: ${gate.title}`, () => {
        assert.equal(gate.pass, true, gateFailureText(gate));
      });
    }
    await t.test('几何对照：同参数无损成对时，裁边本身要在 F–C 门内', () => {
      const geometry = roundtrip.geometry;
      assert.ok(geometry !== null, '几何对照没跑出来');
      assert.ok(
        geometry.fToC.maxComposite <= GATE_THRESHOLDS.fToCChannelMaxLsb,
        `几何对照 F–C max ${geometry.fToC.maxComposite} LSB > ${GATE_THRESHOLDS.fToCChannelMaxLsb} LSB，说明裁边/还原本身有问题`,
      );
      assert.ok(
        geometry.fToC.maxAlpha <= GATE_THRESHOLDS.fToCAlphaMaxLsb,
        `几何对照 alpha max ${geometry.fToC.maxAlpha} LSB > ${GATE_THRESHOLDS.fToCAlphaMaxLsb} LSB`,
      );
    });
    await t.test('总判定与证据预算', () => {
      assert.ok(pngCount <= 3, `out/frames 里有 ${pngCount} 张 PNG，上限 3`);
      assert.equal(verdict.pass, true, `不过的门：${verdict.failed.join(', ')}`);
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
