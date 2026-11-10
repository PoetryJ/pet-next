/**
 * manifest 校验与 ROI 决策的逐分支断言（测 `experiments/idle-roi/core.ts` 的实现），
 * 外加本层新增的 CSS 值转换。
 *
 * 决策是纯函数：同一输入永远同一结果，不读 DOM、不加载视频。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as contract from './core.ts';
import * as adapter from './adapter.ts';
import { decideIdleRoi, formatIdleRoiStyle, idleRoiCssVariables, parseIdleRoiManifest } from './adapter.ts';

const SOURCE_SHA = 'a'.repeat(64);
const CANDIDATE_SHA = 'b'.repeat(64);

/** 契约第 3 节的 manifest 样例（整数、偶数对齐、小写 hex）。 */
function makeManifest(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'idle-roi',
    sourcePath: 'assets/idle.webm',
    sourceSha256: SOURCE_SHA,
    candidateSha256: CANDIDATE_SHA,
    originalCanvas: { width: 640, height: 360 },
    crop: { x: 208, y: 52, width: 226, height: 286 },
    alphaThreshold: 1,
    guard: 2,
    codec: 'vp9',
    pixelFormat: 'yuva420p',
    colorTags: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
    frameCount: 48,
    pts: {
      count: 48,
      firstMs: 0,
      lastMs: 1958.333,
      stepMs: 41.667,
      minDeltaMs: 41.667,
      maxDeltaMs: 41.667,
    },
    durationMs: 1999,
    loopFrames: 48,
    generatedBy: 'node experiments/idle-roi/compiler.mjs --out=experiments/idle-roi/out',
    ffmpeg: 'ffmpeg version 8.0.1',
    builtAt: '2026-11-10T00:00:00.000Z',
    ...patch,
  };
}

function decide(patch: Record<string, unknown> = {}) {
  return decideIdleRoi({
    enabled: true,
    selection: 'idle',
    manifestRaw: makeManifest(),
    viewWidth: 320,
    viewHeight: 240,
    sourceSha256: SOURCE_SHA,
    ...patch,
  });
}

describe('parseIdleRoiManifest', () => {
  test('接受契约样例并重建字段', () => {
    const parsed = parseIdleRoiManifest(makeManifest());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.manifest.schemaVersion, 1);
    assert.equal(parsed.manifest.kind, 'idle-roi');
    assert.equal(parsed.manifest.alphaThreshold, 1);
    assert.deepEqual(parsed.manifest.originalCanvas, { width: 640, height: 360 });
    assert.deepEqual(parsed.manifest.crop, { x: 208, y: 52, width: 226, height: 286 });
    assert.equal(parsed.manifest.frameCount, 48);
    assert.equal(parsed.manifest.pts.count, 48);
    assert.equal(parsed.manifest.sourceSha256, SOURCE_SHA);
    assert.equal(parsed.manifest.candidateSha256, CANDIDATE_SHA);
  });

  test('期望 SHA 一致时通过', () => {
    const parsed = parseIdleRoiManifest(makeManifest(), { sourceSha256: SOURCE_SHA });
    assert.equal(parsed.ok, true);
  });

  test('期望 SHA 不一致时拒绝，原因是可读中文', () => {
    const parsed = parseIdleRoiManifest(makeManifest(), { sourceSha256: 'c'.repeat(64) });
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.reason, 'sourceSha256 与当前原片不匹配');
  });

  test('不传期望 SHA 时只看形态（sha 对齐责任在调用方）', () => {
    assert.equal(parseIdleRoiManifest(makeManifest()).ok, true);
  });

  test('guard 不是几何必需项：缺失时回落 0（几何以 crop 为准）', () => {
    const parsed = parseIdleRoiManifest(makeManifest({ guard: undefined }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.manifest.guard, 0);
  });

  const invalid: Array<[string, unknown, RegExp]> = [
    ['null', null, /不是对象/],
    ['数组', [], /不是对象/],
    ['字符串', 'idle-roi', /不是对象/],
    ['缺 schemaVersion', makeManifest({ schemaVersion: undefined }), /schemaVersion 必须是 1/],
    ['schemaVersion=2', makeManifest({ schemaVersion: 2 }), /schemaVersion 必须是 1/],
    ['kind 不对', makeManifest({ kind: 'idle' }), /kind 必须是 idle-roi/],
    ['alphaThreshold=16（提阈值）', makeManifest({ alphaThreshold: 16 }), /alphaThreshold 必须是 1/],
    ['alphaThreshold 缺失', makeManifest({ alphaThreshold: undefined }), /alphaThreshold 必须是 1/],
    ['sourceSha256 大写', makeManifest({ sourceSha256: SOURCE_SHA.toUpperCase() }), /sourceSha256 必须是 64 位小写 hex/],
    ['sourceSha256 太短', makeManifest({ sourceSha256: 'abc' }), /sourceSha256 必须是 64 位小写 hex/],
    ['candidateSha256 缺失', makeManifest({ candidateSha256: undefined }), /candidateSha256 必须是 64 位小写 hex/],
    ['缺 originalCanvas', makeManifest({ originalCanvas: undefined }), /originalCanvas 缺失/],
    ['originalCanvas 宽非整数', makeManifest({ originalCanvas: { width: 640.5, height: 360 } }), /originalCanvas 宽高必须是正整数/],
    ['originalCanvas 高为 0', makeManifest({ originalCanvas: { width: 640, height: 0 } }), /originalCanvas 宽高必须是正整数/],
    ['缺 crop', makeManifest({ crop: undefined }), /crop 缺失/],
    ['crop 宽为 0', makeManifest({ crop: { x: 208, y: 52, width: 0, height: 286 } }), /crop 宽高必须是正整数/],
    ['crop 高为负', makeManifest({ crop: { x: 208, y: 52, width: 226, height: -286 } }), /crop 宽高必须是正整数/],
    ['crop 原点非整数', makeManifest({ crop: { x: 208.5, y: 52, width: 226, height: 286 } }), /crop 原点必须是整数/],
    ['crop 原点为 NaN', makeManifest({ crop: { x: Number.NaN, y: 52, width: 226, height: 286 } }), /crop 原点必须是整数/],
    ['crop 原点为负', makeManifest({ crop: { x: -2, y: 52, width: 226, height: 286 } }), /crop 越出原画布/],
    ['crop 右边越界', makeManifest({ crop: { x: 208, y: 52, width: 434, height: 286 } }), /crop 越出原画布/],
    ['crop 下边越界', makeManifest({ crop: { x: 208, y: 52, width: 226, height: 310 } }), /crop 越出原画布/],
    ['crop 宽奇数（未偶数对齐）', makeManifest({ crop: { x: 208, y: 52, width: 227, height: 286 } }), /偶数对齐/],
    ['crop 高奇数', makeManifest({ crop: { x: 208, y: 52, width: 226, height: 285 } }), /偶数对齐/],
    ['crop 原点奇数', makeManifest({ crop: { x: 209, y: 52, width: 226, height: 286 } }), /偶数对齐/],
    ['frameCount 为 0', makeManifest({ frameCount: 0 }), /frameCount 必须是正整数/],
    ['frameCount 非整数', makeManifest({ frameCount: 48.5 }), /frameCount 必须是正整数/],
    ['缺 pts', makeManifest({ pts: undefined }), /pts 摘要缺失/],
    ['pts.count 与 frameCount 不一致', makeManifest({ pts: { ...(makeManifest().pts as object), count: 47 } }), /pts.count 必须等于 frameCount/],
    ['pts 数值为 NaN', makeManifest({ pts: { ...(makeManifest().pts as object), stepMs: Number.NaN } }), /pts 数值必须是有限数/],
    ['pts 末帧早于首帧', makeManifest({ pts: { ...(makeManifest().pts as object), lastMs: -1 } }), /pts 末帧早于首帧/],
    ['pts 最小间隔为 0', makeManifest({ pts: { ...(makeManifest().pts as object), minDeltaMs: 0 } }), /pts 帧间隔必须为正/],
    ['pts 最小间隔大于最大间隔', makeManifest({ pts: { ...(makeManifest().pts as object), minDeltaMs: 50, maxDeltaMs: 40 } }), /pts 最小间隔大于最大间隔/],
    ['durationMs 为 0', makeManifest({ durationMs: 0 }), /durationMs 必须是正数/],
    ['durationMs 为负', makeManifest({ durationMs: -1 }), /durationMs 必须是正数/],
    ['durationMs 缺失', makeManifest({ durationMs: undefined }), /durationMs 必须是正数/],
    ['loopFrames 为 0', makeManifest({ loopFrames: 0 }), /loopFrames 必须是正整数/],
    ['sourcePath 为空', makeManifest({ sourcePath: '' }), /sourcePath 缺失或为空/],
    ['codec 缺失', makeManifest({ codec: undefined }), /codec 缺失或为空/],
    ['pixelFormat 为空', makeManifest({ pixelFormat: '' }), /pixelFormat 缺失或为空/],
    ['generatedBy 缺失', makeManifest({ generatedBy: undefined }), /generatedBy 缺失或为空/],
    ['ffmpeg 缺失', makeManifest({ ffmpeg: undefined }), /ffmpeg 缺失或为空/],
    ['builtAt 缺失', makeManifest({ builtAt: 1 }), /builtAt 缺失或为空/],
    ['缺 colorTags', makeManifest({ colorTags: undefined }), /colorTags 缺失/],
    ['colorTags 缺 range', makeManifest({ colorTags: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' } }), /colorTags.range 缺失/],
  ];

  for (const [label, raw, pattern] of invalid) {
    test(`拒绝无效 manifest：${label}`, () => {
      const parsed = parseIdleRoiManifest(raw);
      assert.equal(parsed.ok, false);
      if (parsed.ok) return;
      assert.match(parsed.reason, pattern);
    });
  }
});

describe('decideIdleRoi', () => {
  test('idle + 有效 manifest + 320x240 → roi，布局钉住 104/56/113/143', () => {
    const decision = decide();
    assert.equal(decision.kind, 'roi');
    if (decision.kind !== 'roi') return;
    assert.equal(decision.layout.left, 104);
    assert.equal(decision.layout.top, 56);
    assert.equal(decision.layout.width, 113);
    assert.equal(decision.layout.height, 143);
    assert.equal(decision.manifest.crop.width, 226);
    assert.equal(decision.manifest.sourceSha256, SOURCE_SHA);
  });

  test('开关关闭 → original，原因可读', () => {
    const decision = decide({ enabled: false });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.equal(decision.reason, '开关关闭');
    assert.equal('layout' in decision, false);
  });

  const others = ['short', 'reaction', 'placeholder'] as const;
  for (const selection of others) {
    test(`selection=${selection} → original`, () => {
      const decision = decide({ selection });
      assert.equal(decision.kind, 'original');
      if (decision.kind !== 'original') return;
      assert.equal(decision.reason, `当前选择是 ${selection}，只对 idle 生效`);
      assert.equal('layout' in decision, false);
    });
  }

  test('idle → short → idle：只有 idle 走 ROI，来回数值不变', () => {
    const first = decide({ selection: 'idle' });
    const middle = decide({ selection: 'short' });
    const last = decide({ selection: 'idle' });
    assert.equal(first.kind, 'roi');
    assert.equal(middle.kind, 'original');
    assert.equal(last.kind, 'roi');
    if (first.kind !== 'roi' || last.kind !== 'roi') return;
    assert.deepEqual(last.layout, first.layout);
  });

  test('manifest 无效 → original，原因来自 parse', () => {
    const decision = decide({ manifestRaw: { kind: 'idle-roi' } });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.equal(decision.reason, 'schemaVersion 必须是 1');
  });

  test('manifest 未注入（undefined）→ original，不抛异常', () => {
    const decision = decide({ manifestRaw: undefined });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.match(decision.reason, /不是对象/);
  });

  test('sha 不匹配（旧 manifest 套新素材）→ original', () => {
    const decision = decide({ sourceSha256: 'c'.repeat(64) });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.equal(decision.reason, 'sourceSha256 与当前原片不匹配');
  });

  test('调用方未给素材 sha 时按契约不做比对（对齐责任在注入端，见 WIRING）', () => {
    const decision = decide({ sourceSha256: undefined });
    assert.equal(decision.kind, 'roi');
  });

  test('视口无效 → original，不返回半套布局', () => {
    const decision = decide({ viewWidth: 0 });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.equal(decision.reason, '视口/画布参数无法得出布局');
    assert.equal('layout' in decision, false);
  });

  test('视口 NaN 也回 original', () => {
    assert.equal(decide({ viewWidth: Number.NaN }).kind, 'original');
    assert.equal(decide({ viewWidth: 320, viewHeight: Number.POSITIVE_INFINITY }).kind, 'original');
  });

  test('窗口变大时同一 manifest 给出更大布局', () => {
    const small = decide({ viewWidth: 320, viewHeight: 240 });
    const large = decide({ viewWidth: 640, viewHeight: 480 });
    assert.equal(small.kind, 'roi');
    assert.equal(large.kind, 'roi');
    if (small.kind !== 'roi' || large.kind !== 'roi') return;
    assert.equal(large.layout.left, 208);
    assert.equal(large.layout.top, 112);
    assert.ok(large.layout.width > small.layout.width);
  });
});

describe('CSS 值转换（本层新增，无公式复制）', () => {
  test('转出的是 contracts 的同一个决策函数', () => {
    assert.equal(adapter.decideIdleRoi, contract.decideIdleRoi);
    assert.equal(adapter.parseIdleRoiManifest, contract.parseIdleRoiManifest);
    assert.equal(adapter.computeIdleRoiLayout, contract.computeIdleRoiLayout);
  });

  test('CSS 变量四个键成套，值为 DIP 且不乘 DPR', () => {
    const decision = decide();
    assert.equal(decision.kind, 'roi');
    if (decision.kind !== 'roi') return;
    const variables = idleRoiCssVariables(decision.layout);
    assert.deepEqual(variables, {
      '--idle-roi-left': '104px',
      '--idle-roi-top': '56px',
      '--idle-roi-width': '113px',
      '--idle-roi-height': '143px',
    });
    assert.deepEqual(Object.keys(variables).sort(), [
      '--idle-roi-height',
      '--idle-roi-left',
      '--idle-roi-top',
      '--idle-roi-width',
    ]);
  });

  test('内联样式写法与变量写法数值一致', () => {
    const decision = decide({ viewWidth: 800, viewHeight: 600 });
    assert.equal(decision.kind, 'roi');
    if (decision.kind !== 'roi') return;
    const style = formatIdleRoiStyle(decision.layout);
    assert.deepEqual(style, { left: '260px', top: '140px', width: '282.5px', height: '357.5px' });
    const variables = idleRoiCssVariables(decision.layout);
    assert.equal(variables['--idle-roi-left'], style.left);
    assert.equal(variables['--idle-roi-top'], style.top);
    assert.equal(variables['--idle-roi-width'], style.width);
    assert.equal(variables['--idle-roi-height'], style.height);
  });

  test('小数只保留 3 位，不出现浮点噪声', () => {
    const decision = decide({ viewWidth: 320, viewHeight: 240, manifestRaw: makeManifest({ crop: { x: 208, y: 52, width: 226, height: 286 } }) });
    assert.equal(decision.kind, 'roi');
    if (decision.kind !== 'roi') return;
    for (const value of Object.values(idleRoiCssVariables(decision.layout))) {
      assert.match(value, /^\d+(\.\d{1,3})?px$/);
    }
  });

  test('original 分支没有 layout，也不产生任何 CSS 值', () => {
    const decision = decide({ enabled: false });
    assert.equal(decision.kind, 'original');
    assert.equal('layout' in decision, false);
    assert.equal('style' in decision, false);
  });
});
