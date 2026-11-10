/**
 * 装置自检：A 的三臂还没产出时，用 `assets/idle.webm` 自造 fixture 三臂。
 *
 * 这里证明四件事：
 * 1) 合成/差值/区域语义与手算一致（1 LSB 注入 = 1/255，透明区未预乘 RGB 不算误差，背景不稀释前景）；
 * 2) 正经候选（同预处理、同编码、仅多一个 crop）能过结构门与 F–C 门；
 * 3) 负控①「裁入前景」一定被 ROI 合法性门拒绝；
 * 4) 负控②「偏移 1 DIP」一定被位置门与边缘合成门拒绝。
 *
 * fixture 不是 A 的候选，所以 O–C 的实测值只入报告、不当判定；真实判定在 `quality.test.ts`。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { INSET_CROP, buildFixtureArms, loadInsetArms, petRoot, shiftArms, type Arms } from './lib/arms.ts';
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
import { applyAlphaFloor, compositeFrame, countOpaqueByCrop, cropFrame, diffStats, foregroundMask, restoreCrop, type Rect } from './lib/pixels.ts';
import { writeJson } from './lib/report.ts';
import { probeEncoderSettings } from './lib/sensitivity.ts';

const OUT = path.join(petRoot(), 'tests', 'idle-roi', 'out');
const FIXTURE = path.join(OUT, 'fixture');
/** 320×240 视口下 contain 比例 s=0.5，所以 1 DIP 等于 2 个画布像素。 */
const ONE_DIP_IN_CANVAS_PX = 2;
/** 纯单元层本来不依赖 ffmpeg；缺工具时整段跳过，不伪装成通过。 */
const HAS_FFMPEG = await new Promise<boolean>((resolve) => {
  execFile('ffmpeg', ['-version'], (error) => resolve(error === null));
});

/** 造一帧小图：`opaque` 里的像素给 alpha=255。 */
function syntheticFrame(width: number, height: number, opaque: readonly [number, number][], rgb: readonly [number, number, number] = [10, 20, 30]): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (const [x, y] of opaque) {
    const offset = (y * width + x) * 4;
    rgba[offset] = rgb[0];
    rgba[offset + 1] = rgb[1];
    rgba[offset + 2] = rgb[2];
    rgba[offset + 3] = 255;
  }
  return rgba;
}

function rgbOf(rgba: Uint8Array, width: number, height: number): Buffer {
  const rgb = Buffer.alloc(width * height * 3);
  compositeFrame(rgba, width, height, 'black', rgb);
  return rgb;
}

test('装置自检：合成与差值语义与手算一致', async (t) => {
  await t.test('同一帧差值为 0', () => {
    const frame = syntheticFrame(4, 4, [[0, 0]]);
    const stats = diffStats(rgbOf(frame, 4, 4), rgbOf(frame, 4, 4), null);
    assert.equal(stats.max, 0);
    assert.equal(stats.mae, 0);
    assert.equal(stats.p99, 0);
    assert.equal(stats.samples, 4 * 4 * 3);
  });

  await t.test('透明区未预乘 RGB 不算误差；alpha=1 最多 1 LSB', () => {
    // 两个像素：0 号 alpha=0，1 号 alpha=1；RGB 都是 200 对 0。
    const left = Buffer.alloc(2 * 4);
    const right = Buffer.alloc(2 * 4);
    for (const offset of [0, 4]) {
      left[offset] = 200;
      left[offset + 1] = 200;
      left[offset + 2] = 200;
    }
    left[7] = 1;
    right[7] = 1;
    const black = rgbOf(left, 2, 1);
    const blackRight = rgbOf(right, 2, 1);
    const white = Buffer.alloc(2 * 3);
    const whiteRight = Buffer.alloc(2 * 3);
    compositeFrame(left, 2, 1, 'white', white);
    compositeFrame(right, 2, 1, 'white', whiteRight);
    const onlyTransparent = new Uint8Array([1, 0]);
    const onlyAlphaOne = new Uint8Array([0, 1]);
    assert.equal(diffStats(black, blackRight, onlyTransparent).max, 0, 'alpha=0 的 RGB 不该进合成结果');
    assert.equal(diffStats(white, whiteRight, onlyTransparent).max, 0);
    assert.ok(diffStats(white, whiteRight, onlyAlphaOne).max <= 1, 'alpha=1 在白底上只允许 1 LSB');
  });

  await t.test('1 LSB 注入等于 1/255 的 MAE 分量', () => {
    const left = syntheticFrame(4, 4, [[0, 0]]);
    const right = Buffer.from(left);
    right[0] = (right[0] ?? 0) + 1;
    const mask = foregroundMask(left, 4, 4, 1);
    const stats = diffStats(left, right, mask);
    assert.equal(stats.samples, 3);
    assert.equal(stats.mae, 1 / 3);
    assert.equal(stats.max, 1);
    assert.equal(stats.p99, 1);
    assert.equal(stats.over1, 0);
  });

  await t.test('背景大面积像素不稀释前景区误差', () => {
    const width = 16;
    const height = 16;
    const frame = Buffer.alloc(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) frame[pixel * 4 + 3] = 1;
    for (let y = 0; y < height; y += 1) {
      const offset = (y * width + 2) * 4;
      frame[offset] = 40;
      frame[offset + 1] = 40;
      frame[offset + 2] = 40;
      frame[offset + 3] = 255;
    }
    const shifted = Buffer.from(frame);
    shifted[(5 * width + 2) * 4] = 43;
    const mask = foregroundMask(frame, width, height, 1);
    const left = rgbOf(frame, width, height);
    const right = rgbOf(shifted, width, height);
    const foreground = diffStats(left, right, mask);
    const whole = diffStats(left, right, null);
    assert.equal(foreground.samples, height * 3);
    assert.ok(Math.abs(foreground.mae - 3 / (height * 3)) < 1e-12, `前景 MAE ${foreground.mae}`);
    assert.ok(whole.mae < foreground.mae / 10, `整帧 MAE ${whole.mae} 应被背景稀释`);
  });

  await t.test('crop 还原只留 crop 区域', () => {
    const width = 4;
    const height = 4;
    const full = syntheticFrame(width, height, [
      [1, 1],
      [2, 2],
    ]);
    const crop: Rect = { x: 1, y: 1, width: 2, height: 2 };
    const cut = Buffer.alloc(crop.width * crop.height * 4);
    cropFrame(full, width, crop, cut);
    const restored = Buffer.alloc(width * height * 4);
    restoreCrop(cut, crop, width, height, restored);
    assert.deepEqual(Buffer.from(restored), Buffer.from(full));
    const counts = countOpaqueByCrop(full, width, height, crop, 1);
    assert.equal(counts.inside, 2);
    assert.equal(counts.outside, 0);
    const shifted = Buffer.alloc(width * height * 4);
    restoreCrop(cut, crop, width, height, shifted, 1, 0);
    assert.equal(countOpaqueByCrop(shifted, width, height, crop, 1).outside, 1, '偏移后应有 1 个前景像素落到 ROI 外');
  });

  await t.test('alpha 阈值只清零 <=1 的像素', () => {
    const frame = syntheticFrame(3, 1, []);
    frame[3] = 1;
    frame[7] = 2;
    frame[11] = 0;
    const changed = applyAlphaFloor(frame, 1);
    assert.equal(changed, 1);
    assert.equal(frame[3], 0);
    assert.equal(frame[7], 2);
  });
});

let fixturePromise: Promise<{ arms: Arms }> | null = null;
let workRoot: string | null = null;
const record: Record<string, unknown> = {};

async function fixture(): Promise<{ arms: Arms }> {
  if (fixturePromise === null) {
    fixturePromise = (async () => {
      workRoot = await mkdtemp(path.join(os.tmpdir(), 'm312c-selfcheck-'));
      const built = await buildFixtureArms(FIXTURE, workRoot);
      assert.ok(built.arms, `fixture 造不出来：${built.problems.join('；')}`);
      return { arms: built.arms };
    })();
  }
  return fixturePromise;
}

function summary(gate: GateResult): unknown {
  return { id: gate.id, title: gate.title, criteria: gate.criteria, pass: gate.pass, failures: gate.failures, metrics: gate.metrics };
}

test('装置自检：fixture 三臂', async (t) => {
  if (!HAS_FFMPEG) return t.skip('缺 ffmpeg');
  const { arms } = await fixture();
  const gates = [coverageGate(arms), timelineGate(arms), layoutGate(arms), fToCGate(arms), ocGate(arms)];
  record.fixture = {
    file: path.relative(petRoot(), FIXTURE),
    crop: arms.crop,
    sourceSha256: arms.O.sha256,
    frameCount: arms.frameCount,
    gates: gates.map(summary),
    structuralVerdict: overallVerdict(gates),
  };

  for (const gate of gates) {
    await t.test(`${gate.id}: ${gate.title}`, () => {
      if (gate.id === 'o-to-c') {
        // fixture 的重编码噪声不是 A 的候选，这里只要求逐帧数值完整。
        const records = gate.metrics.perFrame as unknown[];
        assert.equal(records.length, arms.frameCount, 'O–C 必须逐帧出数，不能抽样');
        return;
      }
      assert.equal(gate.pass, true, `${gate.id} 不过：${gate.failures.slice(0, 6).join('；')}`);
    });
  }
});

test('编码档位敏感性：crf 0/4/32', async (t) => {
  if (!HAS_FFMPEG) return t.skip('缺 ffmpeg');
  const root = workRoot;
  assert.ok(root !== null, '敏感性探针依赖 fixture 的临时目录');
  const { probes } = await probeEncoderSettings(root, [0, 4, 32]);
  const lossless = probes.find((probe) => probe.crf === 0);
  const lossy = probes.find((probe) => probe.crf === 4);
  record.encoderSensitivity = probes;
  record.finding = lossless
    ? `同一份预处理输入，crf 0（无损）时 O–C 前景 MAE 仍为 ${lossless.ocForeground.mae.toFixed(4)}/255、P99 ${lossless.ocForeground.p99}，已超 §6 的 MAE≤1/255；说明差距来自 8-bit yuva420p 重编码往返，不是 ROI 几何。`
    : 'crf 0 没跑出来';
  await t.test('档位越低误差越小（探针有分辨力）', () => {
    assert.equal(probes.length, 3, `只跑到 ${probes.length} 个档位`);
    assert.ok(lossless && lossy, `缺 crf 0 或 crf 4：${JSON.stringify(probes)}`);
    assert.ok(lossless.ocForeground.mae <= lossy.ocForeground.mae, 'crf 0 的前景误差不应大于 crf 4');
    assert.ok(lossless.fToC.maxComposite <= lossy.fToC.maxComposite, 'crf 0 的 F–C 最大差不应大于 crf 4');
  });
  await t.test('无损档位也过不了 O–C 门（当前编码器行为）', () => {
    assert.ok(lossless, '缺 crf 0');
    assert.ok(
      lossless.ocForeground.mae > GATE_THRESHOLDS.ocMae,
      `crf 0 前景 MAE ${lossless.ocForeground.mae} 已 ≤1/255：编码器行为变了，需要重看「重编码过不了门」的结论`,
    );
  });
});

test('负控①：裁入前景必须被 ROI 合法性门拒绝', async (t) => {
  const root = workRoot;
  assert.ok(root !== null, '负控依赖 fixture 的临时目录');
  const inset = await loadInsetArms(FIXTURE, root);
  assert.ok(inset.arms, `负控臂造不出来：${inset.problems.join('；')}`);
  const gate = coverageGate(inset.arms);
  const perArm = gate.metrics.perArm as Record<string, { outsideOpaque: number }>;
  const outside = perArm.O?.outsideOpaque ?? 0;
  record.negativeControlInset = { crop: INSET_CROP, outsideOpaque: outside, pass: gate.pass, failures: gate.failures.slice(0, 6) };
  await t.test('门必须失败', () => {
    assert.equal(gate.pass, false, '把 crop 内移 10px 之后合法性门仍然通过，等于门失效');
  });
  await t.test('失败原因是 ROI 外仍有 alpha>1', () => {
    assert.ok(outside > 0, `crop=${JSON.stringify(INSET_CROP)} 下 ROI 外 alpha>1 像素数应 > 0，实测 ${outside}`);
    assert.ok(gate.failures.some((item) => item.includes('ROI 外')), `失败项里应指名 ROI 外像素，实际：${gate.failures.join('｜')}`);
  });
});

test('负控②：偏移 1 DIP 必须被位置/边缘门拒绝', async (t) => {
  if (!HAS_FFMPEG) return t.skip('缺 ffmpeg');
  const { arms } = await fixture();
  const shifted = shiftArms(arms, ONE_DIP_IN_CANVAS_PX, 0, 'fixture-shift-1dip');
  const layout = layoutGate(shifted);
  const oc = ocGate(shifted);
  const worstEdge = oc.metrics.worstEdge as { mae: number; frame: number; plate: string };
  record.negativeControlShift = {
    shiftCanvasPx: ONE_DIP_IN_CANVAS_PX,
    shiftDip: 1,
    layout: summary(layout),
    ocPass: oc.pass,
    worstEdge,
    ocFailures: oc.failures.slice(0, 8),
  };
  await t.test('位置门必须失败', () => {
    assert.equal(layout.pass, false, `偏移 ${ONE_DIP_IN_CANVAS_PX}px 后位置门仍然通过，等于门失效`);
  });
  await t.test('边缘合成门必须失败', () => {
    assert.equal(oc.pass, false, '偏移 1 DIP 之后边缘区合成仍然过 MAE/P99，等于门太松');
  });
});

test.after(async () => {
  writeJson(path.join(OUT, 'selfcheck-report.json'), {
    schemaVersion: 1,
    kind: 'idle-roi-selfcheck',
    generatedAt: new Date().toISOString(),
    note: 'fixture 由 O 自造，只用于自测与负控；其中 O–C 数值只作参考，不构成对 A 候选的判定',
    thresholds: GATE_THRESHOLDS,
    ...record,
  });
  if (workRoot !== null) await rm(workRoot, { recursive: true, force: true });
});
