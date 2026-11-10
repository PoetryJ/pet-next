/**
 * 布局与常量逐条钉住：测的是 `experiments/idle-roi/core.ts` 的实现（产品树唯一实现），
 * 本文件只经 `experiments/idle-roi/layout.ts` 的转出取用，并断言两者是同一个函数。
 *
 * 纯算术断言：不读 DOM、不 sleep、不碰视频。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as contract from './core.ts';
import * as layoutModule from './layout.ts';
import { computeIdleRoiLayout, type CropRect } from './layout.ts';

/** 契约里冻结的候选：640x360 原画布上的 (208,52,226,286)。 */
const CANDIDATE = {
  originalCanvas: { width: 640, height: 360 },
  crop: { x: 208, y: 52, width: 226, height: 286 },
} as const;

function layoutAt(viewWidth: number, viewHeight: number, crop: CropRect = CANDIDATE.crop) {
  return computeIdleRoiLayout({
    viewWidth,
    viewHeight,
    originalCanvas: CANDIDATE.originalCanvas,
    crop,
  });
}

/** 布局不取整，只允许 1e-9 级浮点噪声。 */
function assertClose(actual: number, expected: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${label}: 期望 ${expected}，实际 ${actual}`);
}

describe('roi 布局公式（contracts/idle-roi）', () => {
  test('320x240 视口下契约候选必须是 left=104 top=56 width=113 height=143', () => {
    const layout = layoutAt(320, 240);
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.equal(layout.left, 104);
    assert.equal(layout.top, 56);
    assert.equal(layout.width, 113);
    assert.equal(layout.height, 143);
    assert.equal(layout.scale, 0.5);
  });

  test('四个几何值与 scale 都是有限数', () => {
    const layout = layoutAt(320, 240);
    assert.notEqual(layout, null);
    if (layout === null) return;
    for (const value of [layout.left, layout.top, layout.width, layout.height, layout.scale]) {
      assert.ok(Number.isFinite(value));
    }
  });

  test('视口等于原画布（640x360）时 scale=1，ROI 落在 crop 原位', () => {
    const layout = layoutAt(640, 360);
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.equal(layout.scale, 1);
    assert.deepEqual(
      { left: layout.left, top: layout.top, width: layout.width, height: layout.height },
      { left: 208, top: 52, width: 226, height: 286 },
    );
  });

  test('视口变大（640x480）时 left/top 随 letterbox 变化，宽高按 scale 放大', () => {
    const layout = layoutAt(640, 480);
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.equal(layout.scale, 1);
    assert.equal(layout.left, 208);
    assert.equal(layout.top, 112);
    assert.equal(layout.width, 226);
    assert.equal(layout.height, 286);
  });

  test('视口等比放大（800x600）只缩放不偏移：scale=1.25 且 top 带 letterbox', () => {
    const layout = layoutAt(800, 600);
    assert.notEqual(layout, null);
    if (layout === null) return;
    assertClose(layout.scale, 1.25, 'scale');
    assertClose(layout.left, 260, 'left');
    assertClose(layout.top, 140, 'top');
    assertClose(layout.width, 282.5, 'width');
    assertClose(layout.height, 357.5, 'height');
  });

  test('视口变窄（160x240）时整体缩小，left 与宽高同步减半', () => {
    // s = min(160/640, 240/360) = 0.25
    const layout = layoutAt(160, 240);
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.equal(layout.scale, 0.25);
    assert.equal(layout.left, 52);
    assert.equal(layout.top, 88);
    assertClose(layout.width, 56.5, 'width');
    assertClose(layout.height, 71.5, 'height');
  });

  test('视口变高（320x300）时宽度不变、top 随 letterbox 下移', () => {
    const layout = layoutAt(320, 300);
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.equal(layout.scale, 0.5);
    assert.equal(layout.left, 104);
    assert.equal(layout.top, 86);
    assert.equal(layout.width, 113);
    assert.equal(layout.height, 143);
  });

  test('窗口从小到大：四项几何都随之变化', () => {
    const small = layoutAt(320, 240);
    const large = layoutAt(640, 480);
    assert.notEqual(small, null);
    assert.notEqual(large, null);
    if (small === null || large === null) return;
    assert.ok(large.left > small.left);
    assert.ok(large.top > small.top);
    assert.ok(large.width > small.width);
    assert.ok(large.height > small.height);
  });

  test('整幅裁框（0,0,640,360）在 320x240 下等价 contain 的 letterbox', () => {
    const layout = layoutAt(320, 240, { x: 0, y: 0, width: 640, height: 360 });
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.deepEqual(
      { left: layout.left, top: layout.top, width: layout.width, height: layout.height },
      { left: 0, top: 30, width: 320, height: 180 },
    );
  });

  test('换一个裁框时几何跟着 crop 走', () => {
    const layout = layoutAt(320, 240, { x: 100, y: 20, width: 60, height: 40 });
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.deepEqual(
      { left: layout.left, top: layout.top, width: layout.width, height: layout.height },
      { left: 50, top: 40, width: 30, height: 20 },
    );
  });
});

describe('roi 布局：拒绝无效输入', () => {
  const invalidViews: Array<[string, number, number]> = [
    ['viewWidth 为 NaN', Number.NaN, 240],
    ['viewHeight 为 NaN', 320, Number.NaN],
    ['viewWidth 为 Infinity', Number.POSITIVE_INFINITY, 240],
    ['viewHeight 为 -Infinity', 320, Number.NEGATIVE_INFINITY],
    ['viewWidth 为 0', 0, 240],
    ['viewHeight 为 0', 320, 0],
    ['viewWidth 为负', -320, 240],
    ['viewHeight 为负', 320, -240],
  ];

  for (const [label, viewWidth, viewHeight] of invalidViews) {
    test(`拒绝视口：${label}`, () => {
      assert.equal(layoutAt(viewWidth, viewHeight), null);
    });
  }

  const invalidCrops: Array<[string, CropRect]> = [
    ['宽为 0', { x: 208, y: 52, width: 0, height: 286 }],
    ['高为 0', { x: 208, y: 52, width: 226, height: 0 }],
    ['宽为负', { x: 208, y: 52, width: -226, height: 286 }],
    ['高为 NaN', { x: 208, y: 52, width: 226, height: Number.NaN }],
    ['x 为 NaN', { x: Number.NaN, y: 52, width: 226, height: 286 }],
    ['y 为 Infinity', { x: 208, y: Number.POSITIVE_INFINITY, width: 226, height: 286 }],
    ['原点为负', { x: -2, y: 52, width: 226, height: 286 }],
    ['右边越界', { x: 208, y: 52, width: 434, height: 286 }],
    ['下边越界', { x: 208, y: 52, width: 226, height: 310 }],
    ['整体在画布外', { x: 700, y: 52, width: 20, height: 20 }],
  ];

  for (const [label, crop] of invalidCrops) {
    test(`拒绝裁框：${label}`, () => {
      assert.equal(layoutAt(320, 240, crop), null);
    });
  }

  test('画布尺寸为 0 时返回 null', () => {
    assert.equal(
      computeIdleRoiLayout({
        viewWidth: 320,
        viewHeight: 240,
        originalCanvas: { width: 0, height: 360 },
        crop: CANDIDATE.crop,
      }),
      null,
    );
  });

  /**
   * 契约的形状保护只做到"字段值不合法返 null"，不做对象级判空：
   * 缺 `crop` 时会在解构后取属性抛 TypeError。所以调用方必须先用
   * `parseIdleRoiQuery` / `parseIdleRoiManifest` 过滤，再调本函数
   * （`app/page.ts` 的 `idleRoiSpec === null` 早退即为此）。
   */
  test('几何字段缺失不属于本函数职责：会抛，调用方必须先过 parse*', () => {
    assert.throws(
      () => computeIdleRoiLayout({ viewWidth: 320, viewHeight: 240, originalCanvas: CANDIDATE.originalCanvas } as never),
      TypeError,
    );
    assert.throws(() => computeIdleRoiLayout(null as never), TypeError);
    // 先过滤再算：非法 query 已在上游变成 null，不会走到布局。
    assert.equal(layoutModule.parseIdleRoiQuery(null), null);
    assert.equal(layoutModule.parseIdleRoiQuery('208,52,0,286,640,360'), null);
  });
});

describe('实验侧转出与产品树是同一份实现', () => {
  test('layout.ts 的 computeIdleRoiLayout 就是 contracts 的同一个函数', () => {
    assert.equal(layoutModule.computeIdleRoiLayout, contract.computeIdleRoiLayout);
  });

  test('常量与开关判定一并转出', () => {
    assert.equal(layoutModule.IDLE_ROI_QUERY, 'idleRoi');
    assert.equal(layoutModule.IDLE_ROI_ENV, 'PET_NEXT_IDLE_ROI');
    assert.equal(layoutModule.IDLE_ROI_MANIFEST_ENV, 'PET_NEXT_IDLE_ROI_MANIFEST');
    assert.equal(layoutModule.idleRoiEnabled({ PET_NEXT_IDLE_ROI: '1' }), true);
    assert.equal(layoutModule.idleRoiEnabled({}), false);
    assert.equal(layoutModule.idleRoiEnabled({ PET_NEXT_IDLE_ROI: '0' }), false);
    assert.equal(layoutModule.idleRoiEnabled({ PET_NEXT_IDLE_ROI: 'true' }), false);
  });

  test('query 编解码往返（主进程 → 页面）', () => {
    const encoded = layoutModule.encodeIdleRoiQuery(CANDIDATE);
    assert.equal(encoded, '208,52,226,286,640,360');
    const decoded = layoutModule.parseIdleRoiQuery(encoded);
    assert.deepEqual(decoded, {
      crop: { x: 208, y: 52, width: 226, height: 286 },
      originalCanvas: { width: 640, height: 360 },
    });
  });

  test('query 解析拒绝缺项/非整数/越界', () => {
    assert.equal(layoutModule.parseIdleRoiQuery(null), null);
    assert.equal(layoutModule.parseIdleRoiQuery(''), null);
    assert.equal(layoutModule.parseIdleRoiQuery('208,52,226,286,640'), null);
    assert.equal(layoutModule.parseIdleRoiQuery('208,52,226,286,640,360,1'), null);
    assert.equal(layoutModule.parseIdleRoiQuery('208.5,52,226,286,640,360'), null);
    assert.equal(layoutModule.parseIdleRoiQuery('208,52,226,286,640,NaN'), null);
    assert.equal(layoutModule.parseIdleRoiQuery('208,52,434,286,640,360'), null);
    assert.equal(layoutModule.parseIdleRoiQuery('-2,52,226,286,640,360'), null);
  });
});
