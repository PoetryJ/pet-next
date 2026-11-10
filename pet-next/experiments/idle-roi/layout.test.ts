/**
 * 布局公式逐条钉住（`docs/M3-12-IDLE-ROI.md` 第 4 节）。
 * 全部是纯算术断言：不读 DOM、不 sleep、不碰视频。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeIdleRoiLayout, type CropRect, type IdleRoiLayoutInput } from './layout.ts';

/** 契约里冻结的候选：640x360 原画布上的 (208,52,226,286)。 */
const CANDIDATE = {
  originalCanvas: { width: 640, height: 360 },
  crop: { x: 208, y: 52, width: 226, height: 286 },
} as const;

function layoutAt(viewWidth: number, viewHeight: number, patch: Partial<IdleRoiLayoutInput> = {}) {
  return computeIdleRoiLayout({
    viewWidth,
    viewHeight,
    originalCanvas: CANDIDATE.originalCanvas,
    crop: CANDIDATE.crop,
    ...patch,
  });
}

/** 浮点断言：布局不取整，只允许 1e-9 级噪声。 */
function assertClose(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= 1e-9,
    `${label}: 期望 ${expected}，实际 ${actual}`,
  );
}

describe('待机 ROI 布局公式', () => {
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

  test('结果里没有 NaN/Infinity，且都是有限数', () => {
    const layout = layoutAt(320, 240);
    assert.notEqual(layout, null);
    if (layout === null) return;
    for (const value of [layout.left, layout.top, layout.width, layout.height, layout.scale]) {
      assert.ok(Number.isFinite(value));
    }
  });

  test('原画布尺寸视口（640x360）时 scale=1，ROI 落在 crop 原位', () => {
    const layout = layoutAt(640, 360);
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.equal(layout.scale, 1);
    assert.equal(layout.left, 208);
    assert.equal(layout.top, 52);
    assert.equal(layout.width, 226);
    assert.equal(layout.height, 286);
  });

  test('等比放大（800x600）只放大不偏移：scale=1.25 并带 letterbox 偏移', () => {
    // s = min(800/640, 600/360) = 1.25；竖直方向 360*1.25=450 < 600，故 top 多出 (600-450)/2
    const layout = layoutAt(800, 600);
    assert.notEqual(layout, null);
    if (layout === null) return;
    assertClose(layout.scale, 1.25, 'scale');
    assertClose(layout.left, 260, 'left');
    assertClose(layout.top, 140, 'top');
    assertClose(layout.width, 282.5, 'width');
    assertClose(layout.height, 357.5, 'height');
  });

  test('视口变高（320x300）时宽度不变、top 随 letterbox 下移', () => {
    // s 仍由宽决定 = 0.5；竖直 (300-180)/2 = 60，再 + 52*0.5
    const layout = layoutAt(320, 300);
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.equal(layout.scale, 0.5);
    assert.equal(layout.left, 104);
    assert.equal(layout.width, 113);
    assert.equal(layout.height, 143);
    assert.equal(layout.top, 86);
  });

  test('窗口变大时 left/top/width/height 全部随之变化', () => {
    const small = layoutAt(320, 240);
    const large = layoutAt(640, 480);
    assert.notEqual(small, null);
    assert.notEqual(large, null);
    if (small === null || large === null) return;
    // 640x480：s = min(1, 1.3333) = 1
    assert.equal(large.scale, 1);
    assert.equal(large.left, 208);
    assert.equal(large.top, 112);
    assert.equal(large.width, 226);
    assert.equal(large.height, 286);
    assert.notEqual(large.left, small.left);
    assert.notEqual(large.top, small.top);
    assert.notEqual(large.width, small.width);
    assert.notEqual(large.height, small.height);
    assert.ok(large.width > small.width);
  });

  test('整幅裁框（0,0,640,360）在 320x240 下等价于 contain 的 letterbox', () => {
    const crop: CropRect = { x: 0, y: 0, width: 640, height: 360 };
    const layout = layoutAt(320, 240, { crop });
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.equal(layout.left, 0);
    assert.equal(layout.top, 30);
    assert.equal(layout.width, 320);
    assert.equal(layout.height, 180);
  });

  test('换一个裁框（左上角小方块）时几何跟着 crop 走', () => {
    const crop: CropRect = { x: 100, y: 20, width: 60, height: 40 };
    const layout = layoutAt(320, 240, { crop });
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.equal(layout.left, 50);
    assert.equal(layout.top, 40);
    assert.equal(layout.width, 30);
    assert.equal(layout.height, 20);
  });

  test('极小视口仍按同一公式给出正尺寸', () => {
    const layout = layoutAt(16, 12);
    assert.notEqual(layout, null);
    if (layout === null) return;
    assert.equal(layout.scale, 0.025);
    assertClose(layout.left, 5.2, 'left');
    assertClose(layout.top, 2.8, 'top');
    assertClose(layout.width, 5.65, 'width');
    assertClose(layout.height, 7.15, 'height');
  });
});

describe('待机 ROI 布局：拒绝无效输入', () => {
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

  const invalidCrops: Array<[string, unknown]> = [
    ['宽为 0', { x: 208, y: 52, width: 0, height: 286 }],
    ['高为 0', { x: 208, y: 52, width: 226, height: 0 }],
    ['宽为负', { x: 208, y: 52, width: -226, height: 286 }],
    ['高为 NaN', { x: 208, y: 52, width: 226, height: Number.NaN }],
    ['x 为 NaN', { x: Number.NaN, y: 52, width: 226, height: 286 }],
    ['y 为 Infinity', { x: 208, y: Number.POSITIVE_INFINITY, width: 226, height: 286 }],
    ['x 为负', { x: -1, y: 52, width: 226, height: 286 }],
    ['y 为负', { x: 208, y: -1, width: 226, height: 286 }],
    ['右边越界', { x: 208, y: 52, width: 433, height: 286 }],
    ['下边越界', { x: 208, y: 52, width: 226, height: 309 }],
    ['整体在画布外', { x: 700, y: 52, width: 20, height: 20 }],
    ['不是对象', null],
    ['是数组', [208, 52, 226, 286]],
  ];

  for (const [label, crop] of invalidCrops) {
    test(`拒绝裁框：${label}`, () => {
      assert.equal(layoutAt(320, 240, { crop: crop as CropRect }), null);
    });
  }

  const invalidCanvas: Array<[string, unknown]> = [
    ['宽为 0', { width: 0, height: 360 }],
    ['高为 NaN', { width: 640, height: Number.NaN }],
    ['缺 height', { width: 640 }],
    ['是 null', null],
  ];

  for (const [label, originalCanvas] of invalidCanvas) {
    test(`拒绝原画布：${label}`, () => {
      assert.equal(
        layoutAt(320, 240, { originalCanvas: originalCanvas as { width: number; height: number } }),
        null,
      );
    });
  }

  test('拒绝缺少 crop 的输入', () => {
    assert.equal(
      computeIdleRoiLayout({ viewWidth: 320, viewHeight: 240, originalCanvas: CANDIDATE.originalCanvas } as unknown as IdleRoiLayoutInput),
      null,
    );
  });

  test('拒绝 null/undefined 输入', () => {
    assert.equal(computeIdleRoiLayout(null as unknown as IdleRoiLayoutInput), null);
    assert.equal(computeIdleRoiLayout(undefined as unknown as IdleRoiLayoutInput), null);
  });
});
