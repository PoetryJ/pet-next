/**
 * 指针拖拽（src/client/pet/motion/drag.ts）的契约测试：按下态与拖拽阈值、松手三种去向（原地放下/甩抛/弹弓）、
 * 点击互动与「刚拖完」的忽略窗口、冻结时本地解冻。
 * 用假 DOM 元素、假指针事件与假 rAF 驱动，断言落在记录的回调上。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PHYSICS } from '../../../shared/physics/constants.ts';
import { createDrag, type DragCard } from './drag.ts';

/** 假根元素：只留拖拽用到的几个方法。 */
function fakeEl() {
  const classes = new Set<string>();
  return {
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
    hasClass: (name: string) => classes.has(name),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => true,
    dispatchEvent: () => true,
    style: { transform: '' },
    /** 盒 200×112.5，左上角 (400, 300)。 */
    getBoundingClientRect: () => ({ left: 400, top: 300, right: 600, bottom: 412.5, width: 200, height: 112.5 }),
  };
}

/** 造一个指针事件；只需要处理器读到的字段。 */
function pointer(el: ReturnType<typeof fakeEl>, x: number, y: number, button = 0) {
  return {
    button,
    pointerId: 1,
    pointerType: 'mouse',
    clientX: x,
    clientY: y,
    currentTarget: el as unknown as HTMLDivElement,
  } as unknown as React.PointerEvent<HTMLDivElement>;
}

/** 假时钟 + 假 rAF。 */
function withFakeFrames() {
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const previousNow = performance.now;
  let now = 100000;
  let pending: Array<{ id: number; cb: () => void }> = [];
  let seq = 0;
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: () => void) => {
    const id = ++seq;
    pending.push({ id, cb });
    return id;
  };
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (id: number) => {
    pending = pending.filter((entry) => entry.id !== id);
  };
  performance.now = () => now;
  return {
    advance(ms: number): void {
      now += ms;
    },
    get queued(): number {
      return pending.length;
    },
    restore(): void {
      (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = previousRaf;
      (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = previousCancel;
      performance.now = previousNow;
    },
  };
}

/** 造一套能力 + 全部回调的记录。 */
function harness(extra: Partial<DragCard> = {}) {
  const el = fakeEl();
  const stage = fakeEl();
  let box: { x: number; y: number } | null = { x: 400, y: 300 };
  const calls = {
    stopFlight: 0,
    stopAutonomy: 0,
    releaseLock: 0,
    setDragging: [] as boolean[],
    plays: [] as string[],
    flights: [] as Array<{ px: number; py: number; vx: number; vy: number }>,
    places: [] as Array<{ x: number; y: number }>,
    clicks: 0,
    squashes: 0,
    seqs: 0,
    tipOn: [] as boolean[],
  };
  const card: DragCard = {
    petId: 'main',
    size: 200,
    halfW: 100,
    halfH: 56.25,
    bottomPad: 10,
    physics: DEFAULT_PHYSICS,
    dragAnims: ['drag1'],
    clickAnims: ['click1'],
    idleAnims: ['idle1'],
    currentAnim: 'idle1',
    setOnce: () => {},
    playAnim: (name) => calls.plays.push(name),
    bumpSeq: () => {
      calls.seqs++;
    },
    markSquash: () => {
      calls.squashes++;
    },
    setDragging: (on) => calls.setDragging.push(on),
    resumeWork: () => false,
    stopAutonomy: () => {
      calls.stopAutonomy++;
    },
    stopFlight: () => {
      calls.stopFlight++;
    },
    startFlight: (px, py, vx, vy) => calls.flights.push({ px, py, vx, vy }),
    isFrozen: () => false,
    releaseLock: () => {
      calls.releaseLock++;
    },
    grabVelocity: () => null,
    playClickSound: () => {
      calls.clicks++;
    },
    tipOn: () => false,
    placeTip: () => {},
    setTipOn: (on) => calls.tipOn.push(on),
    stage: () => stage as unknown as HTMLDivElement,
    root: () => el as unknown as HTMLDivElement,
    box: () => box,
    setBox: (next) => {
      box = next;
    },
    commitPlace: (point) => calls.places.push(point),
    ...extra,
  };
  return {
    drag: createDrag(() => card),
    el,
    stage,
    calls,
    setBox: (next: { x: number; y: number }) => {
      box = next;
    },
  };
}

describe('createDrag —— 按下与阈值', () => {
  test('非左键：不进入按下态', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el } = harness();
      drag.onPointerDown(pointer(el, 500, 350, 2));
      assert.equal(drag.isActive(), false);
    } finally {
      frames.restore();
    }
  });

  test('左键按下：进入按下态，停飞、停弹簧、停走位各一次', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, calls } = harness();
      drag.onPointerDown(pointer(el, 500, 350));
      assert.equal(drag.isActive(), true);
      assert.equal(calls.stopFlight, 1);
      assert.equal(calls.stopAutonomy, 1);
      assert.deepEqual(calls.tipOn, [false]);
    } finally {
      frames.restore();
    }
  });

  test('冻结时按下：本地解冻一次', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, calls } = harness({ isFrozen: () => true });
      drag.onPointerDown(pointer(el, 500, 350));
      assert.equal(calls.releaseLock, 1);
    } finally {
      frames.restore();
    }
  });

  test('未超过阈值的移动：不算拖拽，不播拖拽动画', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, calls } = harness();
      drag.onPointerDown(pointer(el, 500, 350));
      drag.onPointerMove(pointer(el, 502, 351));
      assert.deepEqual(calls.setDragging, []);
      assert.deepEqual(calls.plays, []);
    } finally {
      frames.restore();
    }
  });

  test('超过阈值：进入拖拽，播拖拽动画并取消舞台位移', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, stage, calls } = harness();
      drag.onPointerDown(pointer(el, 500, 350));
      drag.onPointerMove(pointer(el, 540, 350));
      assert.deepEqual(calls.setDragging, [true]);
      assert.deepEqual(calls.plays, ['drag1']);
      assert.equal(stage.style.transform, 'none');
    } finally {
      frames.restore();
    }
  });
});

describe('createDrag —— 松手去向', () => {
  test('没拖动就松手：既不放也不飞，提示按松手位置复位', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, calls } = harness();
      drag.onPointerDown(pointer(el, 500, 350));
      drag.onPointerUp(pointer(el, 500, 350));
      assert.deepEqual(calls.places, []);
      assert.deepEqual(calls.flights, []);
      assert.deepEqual(calls.tipOn, [false, true]);
    } finally {
      frames.restore();
    }
  });

  test('慢慢拖动后松手：原地放下，提交的是当前包围盒', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, calls } = harness();
      drag.onPointerDown(pointer(el, 500, 350));
      frames.advance(50);
      drag.onPointerMove(pointer(el, 540, 350));
      frames.advance(50);
      drag.onPointerMove(pointer(el, 560, 350));
      frames.advance(400); // 停顿够久，估算不出速度
      drag.onPointerUp(pointer(el, 560, 350));
      assert.equal(calls.flights.length, 0);
      assert.equal(calls.places.length, 1);
      assert.deepEqual(calls.setDragging, [true, false]);
    } finally {
      frames.restore();
    }
  });

  test('快速甩动后松手：起飞而不是原地放下', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, calls } = harness();
      drag.onPointerDown(pointer(el, 500, 350));
      frames.advance(20);
      drag.onPointerMove(pointer(el, 600, 350));
      frames.advance(20);
      drag.onPointerMove(pointer(el, 700, 350));
      frames.advance(20);
      drag.onPointerMove(pointer(el, 800, 350));
      drag.onPointerUp(pointer(el, 800, 350));
      assert.equal(calls.places.length, 0);
      assert.equal(calls.flights.length, 1);
      assert.ok(calls.flights[0]!.vx > 0, `应向右飞：${calls.flights[0]!.vx}`);
    } finally {
      frames.restore();
    }
  });

  test('弹弓：两次按下间隔够短，按拉距反向起飞', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, calls, setBox } = harness();
      drag.onPointerDown(pointer(el, 500, 350));
      drag.onPointerUp(pointer(el, 500, 350));
      frames.advance(60);
      // 第二次按下后往左上拽：松手应往右下飞。
      drag.onPointerDown(pointer(el, 500, 350));
      frames.advance(60);
      drag.onPointerMove(pointer(el, 420, 300));
      // 弹簧跟随只在真实 rAF 里推进，这里直接给出被拉到的位置。
      setBox({ x: 380, y: 280 });
      frames.advance(20);
      drag.onPointerUp(pointer(el, 420, 300));
      assert.equal(calls.flights.length, 1);
      const flight = calls.flights[0]!;
      assert.ok(flight.vx > 0 && flight.vy > 0, `拉向左上应往右下飞：vx=${flight.vx} vy=${flight.vy}`);
    } finally {
      frames.restore();
    }
  });
});

describe('createDrag —— 点击', () => {
  test('单击：点击音效 + 点击动画 + 标记 Q 弹 + 递增换源序号', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, calls } = harness();
      drag.onPointerDown(pointer(el, 500, 350));
      drag.onPointerUp(pointer(el, 500, 350));
      drag.onClick();
      assert.equal(calls.clicks, 1);
      assert.deepEqual(calls.plays, ['click1']);
      assert.equal(calls.squashes, 1);
      assert.equal(calls.seqs, 1);
    } finally {
      frames.restore();
    }
  });

  test('刚拖完的 100ms 内：点击被忽略', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, calls } = harness();
      drag.onPointerDown(pointer(el, 500, 350));
      drag.onPointerMove(pointer(el, 540, 350));
      frames.advance(400);
      drag.onPointerUp(pointer(el, 540, 350));
      assert.equal(drag.justDragged(), true);
      drag.onClick();
      assert.equal(calls.clicks, 0);
      frames.advance(150);
      drag.onClick();
      assert.equal(calls.clicks, 1);
    } finally {
      frames.restore();
    }
  });

  test('点击动画池为空：照样出声，但不播动画', () => {
    const frames = withFakeFrames();
    try {
      const { drag, el, calls } = harness({ clickAnims: [] });
      drag.onPointerDown(pointer(el, 500, 350));
      drag.onPointerUp(pointer(el, 500, 350));
      drag.onClick();
      assert.equal(calls.clicks, 1);
      assert.deepEqual(calls.plays, []);
    } finally {
      frames.restore();
    }
  });
});
