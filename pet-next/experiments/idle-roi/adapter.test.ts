/**
 * manifest 校验与 ROI 决策的逐分支断言。
 * 决策是纯函数：同一输入永远同一结果，不读 DOM、不加载视频。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  decideIdleRoi,
  formatIdleRoiStyle,
  parseIdleRoiManifest,
  type IdleRoiDecisionInput,
} from './adapter.ts';

const SOURCE_SHA = 'a'.repeat(64);
const CANDIDATE_SHA = 'b'.repeat(64);

/** 契约第 3 节的 manifest 样例（可覆写单个字段构造无效分支）。 */
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

function decide(patch: Partial<IdleRoiDecisionInput> = {}) {
  return decideIdleRoi({
    selection: 'idle',
    manifestRaw: makeManifest(),
    viewWidth: 320,
    viewHeight: 240,
    enabled: true,
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
    assert.deepEqual(parsed.manifest.originalCanvas, { width: 640, height: 360 });
    assert.deepEqual(parsed.manifest.crop, { x: 208, y: 52, width: 226, height: 286 });
    assert.equal(parsed.manifest.alphaThreshold, 1);
    assert.equal(parsed.manifest.guard, 2);
    assert.equal(parsed.manifest.frameCount, 48);
    assert.equal(parsed.manifest.pts.count, 48);
    assert.equal(parsed.manifest.codec, 'vp9');
    assert.equal(parsed.manifest.pixelFormat, 'yuva420p');
  });

  test('大写的 SHA 归一成小写', () => {
    const parsed = parseIdleRoiManifest(makeManifest({ sourceSha256: SOURCE_SHA.toUpperCase() }));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.manifest.sourceSha256, SOURCE_SHA);
  });

  test('期望 SHA 一致时通过', () => {
    assert.equal(parseIdleRoiManifest(makeManifest(), { sourceSha256: SOURCE_SHA }).ok, true);
  });

  test('期望 SHA 不一致时拒绝，并在原因里给出两个值', () => {
    const parsed = parseIdleRoiManifest(makeManifest(), { sourceSha256: 'c'.repeat(64) });
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.reason, /sourceSha256 mismatch/);
    assert.match(parsed.reason, new RegExp(SOURCE_SHA));
  });

  const invalidManifests: Array<[string, unknown, RegExp]> = [
    ['null', null, /not an object/],
    ['数组', [], /not an object/],
    ['字符串', 'idle-roi', /not an object/],
    ['kind 不对', makeManifest({ kind: 'idle' }), /kind must be "idle-roi"/],
    ['schemaVersion 不对', makeManifest({ schemaVersion: 2 }), /schemaVersion must be 1/],
    ['缺 sourcePath', makeManifest({ sourcePath: '' }), /sourcePath/],
    ['sourceSha256 不是 64 位', makeManifest({ sourceSha256: 'abc' }), /sourceSha256/],
    ['candidateSha256 缺失', makeManifest({ candidateSha256: undefined }), /candidateSha256/],
    ['缺 originalCanvas', makeManifest({ originalCanvas: undefined }), /originalCanvas/],
    ['originalCanvas 宽度为 0', makeManifest({ originalCanvas: { width: 0, height: 360 } }), /originalCanvas/],
    ['缺 crop', makeManifest({ crop: undefined }), /crop/],
    ['crop 宽为 0', makeManifest({ crop: { x: 208, y: 52, width: 0, height: 286 } }), /crop/],
    ['crop 越界', makeManifest({ crop: { x: 208, y: 52, width: 500, height: 286 } }), /crop/],
    ['crop 负偏移', makeManifest({ crop: { x: -2, y: 52, width: 226, height: 286 } }), /crop/],
    ['提阈值到 16', makeManifest({ alphaThreshold: 16 }), /alphaThreshold must be 1/],
    ['guard 不是 2', makeManifest({ guard: 1 }), /guard must be 2/],
    ['codec 不是 vp9', makeManifest({ codec: 'vp8' }), /codec must be "vp9"/],
    ['pixelFormat 缺少 alpha', makeManifest({ pixelFormat: 'yuv420p' }), /pixelFormat must be "yuva420p"/],
    ['缺 colorTags', makeManifest({ colorTags: undefined }), /colorTags/],
    ['colorTags 缺 range', makeManifest({ colorTags: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709' } }), /colorTags.range/],
    ['frameCount 为 0', makeManifest({ frameCount: 0 }), /frameCount/],
    ['pts 缺失', makeManifest({ pts: undefined }), /pts/],
    ['pts.count 与帧数不一致', makeManifest({ pts: { ...(makeManifest().pts as object), count: 47 } }), /pts.count/],
    ['pts.stepMs 为 NaN', makeManifest({ pts: { ...(makeManifest().pts as object), stepMs: Number.NaN } }), /stepMs/],
    ['pts.maxDeltaMs 小于 minDeltaMs', makeManifest({ pts: { ...(makeManifest().pts as object), maxDeltaMs: 1 } }), /maxDeltaMs/],
    ['durationMs 为 0', makeManifest({ durationMs: 0 }), /durationMs/],
    ['loopFrames 为 0', makeManifest({ loopFrames: 0 }), /loopFrames/],
    ['缺 generatedBy', makeManifest({ generatedBy: '' }), /generatedBy/],
    ['缺 ffmpeg', makeManifest({ ffmpeg: undefined }), /ffmpeg/],
    ['缺 builtAt', makeManifest({ builtAt: 123 }), /builtAt/],
    ['期望 SHA 本身非法', makeManifest({}), /expected sourceSha256 is not 64 hex chars/],
  ];

  for (const [label, raw, pattern] of invalidManifests) {
    test(`拒绝无效 manifest：${label}`, () => {
      const expected = label.startsWith('期望 SHA') ? { sourceSha256: 'not-a-sha' } : {};
      const parsed = parseIdleRoiManifest(raw, expected);
      assert.equal(parsed.ok, false);
      if (parsed.ok) return;
      assert.match(parsed.reason, pattern);
    });
  }
});

describe('decideIdleRoi', () => {
  test('开关打开 + idle + manifest 有效 → 走 ROI，布局钉住 104/56/113/143', () => {
    const decision = decide();
    assert.equal(decision.kind, 'roi');
    if (decision.kind !== 'roi') return;
    assert.equal(decision.layout.left, 104);
    assert.equal(decision.layout.top, 56);
    assert.equal(decision.layout.width, 113);
    assert.equal(decision.layout.height, 143);
    assert.equal(decision.manifest.sourceSha256, SOURCE_SHA);
    assert.equal(decision.manifest.crop.width, 226);
  });

  test('开关关闭 → 原片，原因可读', () => {
    const decision = decide({ enabled: false });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.match(decision.reason, /switch is off/);
    assert.equal('layout' in decision, false);
  });

  const otherSelections = ['short', 'reaction', 'placeholder'] as const;
  for (const selection of otherSelections) {
    test(`selection=${selection} 永远原布局`, () => {
      const decision = decide({ selection });
      assert.equal(decision.kind, 'original');
      if (decision.kind !== 'original') return;
      assert.match(decision.reason, new RegExp(`selection="${selection}"`));
      assert.match(decision.reason, /only idle/);
    });
  }

  test('idle → short → idle：只有 idle 走 ROI', () => {
    const first = decide({ selection: 'idle' });
    const middle = decide({ selection: 'short' });
    const last = decide({ selection: 'idle' });
    assert.equal(first.kind, 'roi');
    assert.equal(middle.kind, 'original');
    assert.equal(last.kind, 'roi');
    if (last.kind !== 'roi' || first.kind !== 'roi') return;
    assert.deepEqual(last.layout, first.layout);
  });

  test('manifest 无效 → 原片，原因带前缀与细节', () => {
    const decision = decide({ manifestRaw: { kind: 'idle-roi' } });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.match(decision.reason, /^manifest rejected: /);
    assert.match(decision.reason, /schemaVersion/);
  });

  test('manifest 缺失（未注入）→ 原片，不抛异常', () => {
    const decision = decide({ manifestRaw: undefined });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.match(decision.reason, /^manifest rejected: /);
  });

  test('旧 manifest 套到新素材（SHA 不符）→ 原片', () => {
    const decision = decide({ sourceSha256: 'c'.repeat(64) });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.match(decision.reason, /sourceSha256 mismatch/);
  });

  test('缺少素材 SHA 时不猜：回原片', () => {
    const decision = decide({ sourceSha256: undefined });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.match(decision.reason, /missing source sha/);
  });

  test('素材 SHA 是非 64 位垃圾值时同样回原片', () => {
    const decision = decide({ sourceSha256: 'deadbeef' });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.match(decision.reason, /missing source sha/);
  });

  test('视口无效 → 原片，不返回半套布局', () => {
    const decision = decide({ viewWidth: 0, viewHeight: 240 });
    assert.equal(decision.kind, 'original');
    if (decision.kind !== 'original') return;
    assert.match(decision.reason, /^layout unavailable: /);
    assert.equal('layout' in decision, false);
  });

  test('视口为 NaN 也回原片', () => {
    assert.equal(decide({ viewWidth: Number.NaN }).kind, 'original');
  });

  test('窗口尺寸变化时 ROI 跟着变（同 manifest）', () => {
    const small = decide({ viewWidth: 320, viewHeight: 240 });
    const large = decide({ viewWidth: 640, viewHeight: 480 });
    assert.equal(small.kind, 'roi');
    assert.equal(large.kind, 'roi');
    if (small.kind !== 'roi' || large.kind !== 'roi') return;
    assert.equal(large.layout.left, 208);
    assert.equal(large.layout.top, 112);
    assert.notEqual(large.layout.width, small.layout.width);
  });

  test('入参不是对象时回原片而不是抛异常', () => {
    const decision = decideIdleRoi(null as unknown as IdleRoiDecisionInput);
    assert.equal(decision.kind, 'original');
  });
});

describe('formatIdleRoiStyle', () => {
  test('成套给出四个 DIP 值，不乘 DPR', () => {
    const decision = decide();
    assert.equal(decision.kind, 'roi');
    if (decision.kind !== 'roi') return;
    const style = formatIdleRoiStyle(decision.layout);
    assert.deepEqual(style, { left: '104px', top: '56px', width: '113px', height: '143px' });
    assert.deepEqual(Object.keys(style).sort(), ['height', 'left', 'top', 'width']);
  });

  test('小数保留到 3 位，去掉浮点噪声', () => {
    const decision = decide({ viewWidth: 800, viewHeight: 600 });
    assert.equal(decision.kind, 'roi');
    if (decision.kind !== 'roi') return;
    const style = formatIdleRoiStyle(decision.layout);
    assert.equal(style.left, '260px');
    assert.equal(style.top, '140px');
    assert.equal(style.width, '282.5px');
    assert.equal(style.height, '357.5px');
  });

  test('原片分支不产生任何 CSS 值（调用方回全窗口 contain）', () => {
    const decision = decide({ enabled: false });
    assert.equal(decision.kind, 'original');
    assert.equal('layout' in decision, false);
    assert.equal('style' in decision, false);
  });
});
