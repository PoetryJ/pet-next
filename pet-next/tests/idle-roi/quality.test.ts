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
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadRealArms, petRoot, realArmsDir, type Arms } from './lib/arms.ts';
import {
  GATE_THRESHOLDS,
  coverageGate,
  fToCGate,
  layoutGate,
  ocGate,
  overallVerdict,
  timelineGate,
  type GateResult,
} from './lib/gates.ts';
import { openRaw } from './lib/media.ts';
import { compositeFrame, restoreCrop } from './lib/pixels.ts';
import { writeCroppedCompositePng, writeErrorMapPng, writeJson } from './lib/report.ts';

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
  const restored = Buffer.alloc(width * height * 4);
  const left = Buffer.alloc(width * height * 3);
  const right = Buffer.alloc(width * height * 3);
  try {
    originalReader.read(frame, original);
    candidateReader.read(frame, restored);
    restoreCrop(restored, crop, width, height, restored);
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
    const loaded = await loadRealArms(realArmsDir(), workDir);
    if (!loaded.arms) {
      writeJson(path.join(OUT, 'quality-report.json'), {
        schemaVersion: 1,
        kind: 'idle-roi-quality',
        status: 'not-run',
        generatedAt: new Date().toISOString(),
        reason: loaded.problems,
        armsDir: realArmsDir(),
        rerun: RERUN,
      });
      t.skip(`三臂未就绪：${loaded.problems.join('；')}`);
      return;
    }
    const arms = loaded.arms;
    const gates: GateResult[] = [coverageGate(arms), timelineGate(arms), layoutGate(arms), fToCGate(arms), ocGate(arms)];
    const verdict = overallVerdict(gates);

    const oc = gates.find((gate) => gate.id === 'o-to-c');
    const worstFrame = Math.max(0, (oc?.metrics.worstForeground as { frame?: number } | undefined)?.frame ?? 0);
    // 每次重写，避免旧帧号的图混进来把 PNG 预算撑破。
    rmSync(FRAMES, { recursive: true, force: true });
    mkdirSync(FRAMES, { recursive: true });
    const frames = writeKeyFrameEvidence(arms, worstFrame);
    const pngCount = readdirSync(FRAMES).filter((name) => name.endsWith('.png')).length;

    writeJson(path.join(OUT, 'quality-report.json'), {
      schemaVersion: 1,
      kind: 'idle-roi-quality',
      status: verdict.pass ? 'passed' : 'failed',
      generatedAt: new Date().toISOString(),
      armsDir: realArmsDir(),
      thresholds: GATE_THRESHOLDS,
      arms: {
        sourceSha256: arms.O.sha256,
        candidateSha256: arms.C.sha256,
        fSha256: arms.F.sha256,
        frameCount: { O: arms.O.raw.frameCount, F: arms.F.raw.frameCount, C: arms.C.raw.frameCount },
        stream: { O: arms.O.stream, F: arms.F.stream, C: arms.C.stream },
      },
      manifest: arms.manifest,
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
    await t.test('总判定与证据预算', () => {
      assert.ok(pngCount <= 3, `out/frames 里有 ${pngCount} 张 PNG，上限 3`);
      assert.equal(verdict.pass, true, `不过的门：${verdict.failed.join(', ')}`);
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
