/**
 * M3-12 R1 画质门（C 的独立判定）。
 *
 * 三类**分列**，各自一套门、各自一套数字，不许混写：
 * - `v2-rgba`：旧 RGBA 路径候选（out-v2 / fixtures 字节），历史结论保留；
 * - `yuva-selfcontrol`：out-v3-yuva 的原生 YUVA 直通自对照（Y/U/V/A 与解码 RGB）；
 * - `f3c3`：out-v3-yuva 的 F3/C3，本轮唯一转正候选。
 *
 * 全 48 帧独立解码（显式 `-c:v libvpx-vp9`），不抽样。判据来自
 * `docs/M3-12-IDLE-ROI.md` 第 6 节，写在 `lib/gates.ts` 的 GATE_THRESHOLDS 里，本轮不放宽。
 *
 * `PET_NEXT_IDLE_ROI_STRICT_GATE=1` 才是硬门：任一类别未过或未评测都让测试红。
 * 普通 `verify` 绿只证明装置跑通了，不授权进入性能阶段。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { petRoot, type Arms } from './lib/arms.ts';
import { GATE_THRESHOLDS, type GateResult } from './lib/gates.ts';
import { openRaw } from './lib/media.ts';
import { compositeFrame, restoreCrop } from './lib/pixels.ts';
import { assembleReport, gateSummary, writeReport, type ComparisonRow } from './lib/quality-report.ts';
import { gitState, harnessFingerprint, toolVersion } from './lib/reference.ts';
import { writeCroppedCompositePng, writeErrorMapPng } from './lib/report.ts';
import { measureRoundtripFloor } from './lib/roundtrip.ts';
import { VARIANT_DEFINITIONS, evaluateVariant, type VariantEvaluation } from './lib/variants.ts';

const OUT = path.join(petRoot(), 'tests', 'idle-roi', 'out');
const FRAMES = path.join(OUT, 'frames');
const REPORT = path.join(OUT, 'quality-report.json');
const RERUN = 'env -u NODE_OPTIONS node --experimental-strip-types --test --test-reporter spec tests/idle-roi/*.test.ts';
const STRICT = process.env['PET_NEXT_IDLE_ROI_STRICT_GATE'] === '1';
/**
 * 严格门覆盖「本轮要判的路线」＝候选 + 它的前置（自对照）。
 *
 * 历史类别（v2）仍然全量测量并全部写进报告，但它的失败默认不把测试染红——
 * 那些字节是上一轮已被拒绝的候选，让它永久把严格门钉死等于让严格门失去作用。
 * 想让历史类别也硬失败时置 PET_NEXT_IDLE_ROI_STRICT_INCLUDE_HISTORICAL=1。
 */
const STRICT_INCLUDE_HISTORICAL = process.env['PET_NEXT_IDLE_ROI_STRICT_INCLUDE_HISTORICAL'] === '1';
/** 旧 RGBA 路径的自往返默认不跑：它测的是另一条链，不参与本轮判定。 */
const RUN_ROUNDTRIP = process.env['PET_NEXT_IDLE_ROI_ROUNDTRIP'] === '1';

function ffmpegVersion(): Promise<string> {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (error, stdout) => {
      if (error) resolve('missing');
      else resolve((stdout.split('\n')[0] ?? '').trim());
    });
  });
}

/** 判定文字由 gate 的实测字段生成：过了就写判据，不过就写失败项，不共用一句模板。 */
function gateFailureText(gate: GateResult): string {
  const head = `${gate.id}（${gate.title}）${gate.pass ? '通过' : '不过'}：判据「${gate.criteria}」`;
  if (gate.pass) return head;
  const shown = gate.failures.slice(0, 10).join('\n  ');
  const more = gate.failures.length > 10 ? `\n  …还有 ${gate.failures.length - 10} 条` : '';
  return `${head}\n  ${shown}${more}`;
}

/** 关键帧证据：深色底上原片/候选对照 + 误差放大图，最多 3 张小 PNG，只裁 crop 区域。 */
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
    if (arms.C.raw.width !== width || arms.C.raw.height !== height) {
      restoreCrop(candidate, crop, width, height, restored);
    } else {
      restored.set(candidate);
    }
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

/** 候选类别（f3c3）优先；它没评测时退回 v2，图只用于人工看边缘。 */
function keyFrameSource(variants: readonly VariantEvaluation[]): { variant: VariantEvaluation; frame: number } | null {
  const order = ['f3c3', 'v2-rgba', 'yuva-selfcontrol'];
  for (const category of order) {
    const variant = variants.find((item) => item.category === category && item.status === 'evaluated');
    if (!variant) continue;
    const key = Object.keys(variant.measurements).find((id) => /^o-to-c/.test(id)) ?? Object.keys(variant.measurements)[0];
    const measurement = key === undefined ? undefined : variant.measurements[key];
    if (measurement === undefined) continue;
    // 证据图要落在真有误差的地方：优先边缘最差帧（O–C 的残差集中在半透明边），
    // 前景已经全 0 时再退回前景最差帧——那不是"最差"，只是"有代表意义的一帧"。
    const worst = measurement.worstAcrossFramesAndPlates;
    const frame = worst.edgeMae.mae > 0 ? worst.edgeMae.frame : worst.foregroundMae.frame;
    if (frame >= 0) return { variant, frame };
  }
  return null;
}

test('M3-12 画质门：三类分列、全 48 帧独立解码', async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'm312c-quality-'));
  try {
    // 阈值不是本轮可调项：先把判据钉死，跑之前就知道不许改。
    assert.equal(GATE_THRESHOLDS.frameCount, 48, '全片必须是 48 帧');
    assert.equal(GATE_THRESHOLDS.ocMaeLsb, 1, 'O–C 前景 MAE 门被改动');
    assert.equal(GATE_THRESHOLDS.ocP99Lsb, 2, 'O–C P99 门被改动');
    assert.equal(GATE_THRESHOLDS.fToCChannelMaxLsb, 2, 'F–C 每通道门被改动');
    assert.equal(GATE_THRESHOLDS.fToCAlphaMaxLsb, 2, 'F–C alpha 门被改动');
    assert.equal(GATE_THRESHOLDS.alphaThreshold, 1, 'alpha 阈值不是契约固定的 1');

    const gatedCategories = new Set<string>([
      'f3c3',
      ...VARIANT_DEFINITIONS.filter((definition) => definition.prerequisiteOf === 'f3c3').map((definition) => definition.category),
    ]);
    const variants: VariantEvaluation[] = [];
    for (const definition of VARIANT_DEFINITIONS) variants.push(await evaluateVariant(definition, workDir));

    // 关键帧证据（预算 ≤3 张）：先清空，避免旧帧号混进来。
    rmSync(FRAMES, { recursive: true, force: true });
    mkdirSync(FRAMES, { recursive: true });
    const source = keyFrameSource(variants);
    const pngs =
      source === null || source.variant.armsObject === null
        ? []
        : writeKeyFrameEvidence(source.variant.armsObject, Math.max(0, source.frame));
    const pngCount = readdirSync(FRAMES).filter((name) => name.endsWith('.png')).length;

    const git = gitState();
    const harness = harnessFingerprint();
    const assembled = assembleReport({
      variants,
      git,
      harness,
      environment: { ffmpeg: await ffmpegVersion(), ffprobe: toolVersion('ffprobe'), node: process.version, platform: `${process.platform}/${process.arch}` },
      rerun: RERUN,
      keyFrame: source === null ? null : { frame: Math.max(0, source.frame), pngs: pngs.map((file) => path.relative(petRoot(), file)), pngCount, category: source.variant.category },
      roundtrip: RUN_ROUNDTRIP
        ? {
            ran: true,
            reason: '按 PET_NEXT_IDLE_ROI_ROUNDTRIP=1 显式回看：这是 RGBA→YUV 旧链的自往返，只用来看旧结论 1.151 的来源，不参与本轮判定',
            data: await measureRoundtripFloor(workDir),
          }
        : {
            ran: false,
            reason:
              'RGBA 路径的合成自往返本轮未跑：它测的是「YUV→RGB→YUV」这条旧链，已被 yuva-selfcontrol（原生平面直通）与 F3–C3（真实字节成对）取代；置 PET_NEXT_IDLE_ROI_ROUNDTRIP=1 可回看，不参与本轮判定',
          },
    });
    writeReport(REPORT, assembled.report);

    for (const variant of variants) {
      await t.test(`[${variant.category}] ${variant.label}`, async (sub) => {
        if (variant.status !== 'evaluated') {
          if (STRICT) assert.fail(`[${variant.category}] 未评测：${variant.reasons.join('；')}`);
          sub.diagnostic(`未评测：${variant.reasons.join('；')}`);
          return;
        }
        // 反抽样：每个比较都必须有 48 帧的逐帧记录。
        for (const [id, measurement] of Object.entries(variant.measurements)) {
          assert.equal(measurement.perFrame.length, GATE_THRESHOLDS.frameCount, `${variant.category}/${id} 只有 ${measurement.perFrame.length} 帧逐帧记录`);
        }
        const gated = gatedCategories.has(variant.category) || STRICT_INCLUDE_HISTORICAL;
        for (const gate of variant.gates) {
          await sub.test(`${gate.id}: ${gate.title}`, (child) => {
            if (STRICT && gated) assert.equal(gate.pass, true, gateFailureText(gate));
            else if (STRICT) child.diagnostic(`历史类别（不计入本轮严格门）${gate.id}: ${gate.pass ? 'pass' : 'FAIL'} — ${gateFailureText(gate)}`);
            else child.diagnostic(`${gate.id}: ${gate.pass ? 'pass' : 'FAIL'} — ${gateFailureText(gate)}`);
          });
        }
      });
    }

    await t.test('机器可读判定与失败项', (sub) => {
      const rows = assembled.report['comparisons'] as readonly ComparisonRow[];
      assert.ok(rows.length > 0, '三类分列表为空');
      for (const row of rows) {
        assert.notEqual(row.worstAcrossFramesAndPlates, undefined, `${row.category}/${row.comparison} 缺 worstAcrossFramesAndPlates 口径`);
        assert.notEqual(row.meanOverAllSamples, undefined, `${row.category}/${row.comparison} 缺 meanOverAllSamples 口径`);
        assert.notEqual(
          row.worstAcrossFramesAndPlates.foregroundMae,
          undefined,
          `${row.category}/${row.comparison} 的 worst 与 mean 必须是两个字段，不能合并成一个「平均值」`,
        );
      }
      const performance = assembled.performance;
      if (STRICT) {
        assert.equal(assembled.verdict.status, 'passed', `候选未过：${assembled.verdict.decidedBy}`);
        assert.equal(performance.allowed, true, `性能被阻断：${performance.reason}`);
      } else {
        sub.diagnostic(`候选判定 ${assembled.verdict.status}：${assembled.verdict.decidedBy}`);
        sub.diagnostic(`性能 allowed=${String(performance.allowed)}：${performance.reason}`);
      }
      assert.equal(performance.allowed, assembled.verdict.status === 'passed', 'performance.allowed 必须与候选判定一致');
      // failed[] 必须是能回到具体门的限定 id（`类别/门`），否则下游没法定位。
      for (const id of [...assembled.verdict.failed, ...assembled.verdict.historicalFailed]) {
        const [category, gate] = id.split('/');
        assert.ok(category !== undefined && category.length > 0, `失败项 ${id} 缺类别前缀`);
        assert.ok(gate !== undefined && gate.length > 0, `失败项 ${id} 缺门名`);
        const variant = variants.find((item) => item.category === category);
        assert.ok(variant !== undefined, `失败项 ${id} 指向不存在的类别`);
        assert.ok(variant.gates.some((item) => item.id === gate), `失败项 ${id} 在报告里找不到对应门`);
      }
      assert.equal(typeof assembled.report['status'], 'string', 'status 必须是机器可读字符串');
    });

    await t.test('证据预算', () => {
      assert.ok(pngCount <= 3, `out/frames 里有 ${pngCount} 张 PNG，上限 3`);
    });

    // 一页纸用的控制台摘要：每门 pass/fail + 两个口径的数值。
    for (const variant of variants) {
      if (variant.status !== 'evaluated') {
        process.stderr.write(`[${variant.category}] not-run: ${variant.reasons.join('；')}\n`);
        continue;
      }
      process.stderr.write(`[${variant.category}] ${variant.localStatus.pass ? 'PASS' : 'FAIL'} ${variant.localStatus.failed.join(',')}\n`);
      for (const gate of gateSummary(variant)) {
        process.stderr.write(`  ${gate.pass ? 'pass' : 'FAIL'} ${gate.id} (${gate.kind}) ${JSON.stringify(gate.keyNumbers)}\n`);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
