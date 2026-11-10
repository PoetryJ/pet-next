/**
 * M3-11 A：确定性输入 trace 的生成与解析。
 *
 * 这里的 trace 只描述**指针位移**（DIP，与产品的 gesture 输入同单位）和名义时间：
 * 不含 Electron/DOM/真实时钟，所以同一 seed 在任何机器上生成同一序列。
 * 两条用途：
 *   1) bench 侧用固定 seed 的序列驱动真实产品（fixture 层，可复现的合成输入）；
 *   2) 纯分析/单测里回放同一条序列（pure-trace 层，不经 Electron）。
 *
 * 注意：500Hz 只是机制压力，不代表物理鼠标 500Hz。
 * @module pet-next/bench/drag-write-budget/lib/trace
 */

/** 缺省 seed（写进产物，便于复跑）。 */
export const DEFAULT_SEED = 20261110;

/** 8 步一循环、每循环位移和为 0 → 轨迹有界，不会把窗口拖到工作区边缘。 */
const CYCLE_STEPS = [
  [6, 0],
  [4, 3],
  [0, 6],
  [-4, 3],
  [-6, 0],
  [-4, -3],
  [0, -6],
  [4, -3],
];

/**
 * mulberry32：32 位状态、无外部依赖、跨平台同结果。
 *
 * @param {number} seed
 * @returns {() => number} 均匀分布在 [0,1)
 */
export function createRng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成 fixture trace：固定 seed 的位移序列。
 *
 * 结构：8 步零和循环，循环起点按 seed 旋转，每个循环的步长按 seed 取 1 或 0.5
 * （所以既有整数增量也有小数增量，覆盖整数取整后的重复坐标）；每 16 步插入一条
 * (0,0)（gesture 不产生 drag-move，用于确认“零位移不是写入”）。
 *
 * @param {{seed?: number, hz?: number, moves?: number}} [options]
 * @returns {{seed: number, hz: number, moves: number, steps: Array<{i: number, dtMs: number, dx: number, dy: number}>}}
 */
export function generateTrace(options = {}) {
  const seed = options.seed ?? DEFAULT_SEED;
  const hz = options.hz ?? 125;
  const moves = options.moves ?? 480;
  if (!Number.isFinite(seed) || !Number.isFinite(hz) || !Number.isFinite(moves)) {
    throw new TypeError('seed/hz/moves must be finite numbers');
  }
  if (hz <= 0 || moves < 0) throw new RangeError('hz must be > 0 and moves >= 0');
  const rng = createRng(seed);
  const rotation = Math.floor(rng() * CYCLE_STEPS.length);
  const dtMs = 1000 / hz;
  /** @type {Array<{i: number, dtMs: number, dx: number, dy: number}>} */
  const steps = [];
  let slot = 0;
  // 步长按**整个循环**统一选（否则随机步长会让循环不再零和，轨迹会漂移）。
  let scale = 1;
  for (let i = 0; i < moves; i += 1) {
    if (i > 0 && i % 16 === 0) {
      steps.push({ i, dtMs, dx: 0, dy: 0 });
      continue;
    }
    if (slot % CYCLE_STEPS.length === 0) scale = rng() < 0.5 ? 1 : 0.5;
    const base = CYCLE_STEPS[(slot + rotation) % CYCLE_STEPS.length] ?? [0, 0];
    steps.push({ i, dtMs, dx: round6(base[0] * scale), dy: round6(base[1] * scale) });
    slot += 1;
  }
  return { seed, hz, moves, steps };
}

/**
 * 生成 cdp 层的屏幕轨迹：正弦往复（净位移 0，窗口不会漂到边缘）。
 *
 * 返回的是**屏幕坐标增量**（相对起点），消费方把它加到起点屏幕坐标上。
 *
 * @param {{hz?: number, moves?: number, ax?: number, ay?: number, f?: number}} [options]
 * @returns {Array<{i: number, tMs: number, dx: number, dy: number}>}
 */
export function buildScreenPath(options = {}) {
  const hz = options.hz ?? 125;
  const moves = options.moves ?? 480;
  const ax = options.ax ?? 60;
  const ay = options.ay ?? 40;
  const f = options.f ?? 0.6;
  /** @type {Array<{i: number, tMs: number, dx: number, dy: number}>} */
  const steps = [];
  let prevX = 0;
  let prevY = 0;
  for (let i = 0; i < moves; i += 1) {
    const tMs = ((i + 1) * 1000) / hz;
    const t = tMs / 1000;
    const x = ax * Math.sin(2 * Math.PI * f * t);
    const y = ay * Math.sin(2 * Math.PI * f * 1.5 * t);
    steps.push({ i, tMs, dx: round6(x - prevX), dy: round6(y - prevY) });
    prevX = x;
    prevY = y;
  }
  return steps;
}

/** 把 trace 序列化成 ndjson（一行一步），留作复跑证据。 */
export function serializeTrace(trace) {
  const head = JSON.stringify({ event: 'trace-head', seed: trace.seed, hz: trace.hz, moves: trace.moves });
  const body = trace.steps.map((step) => JSON.stringify({ ...step, event: 'trace-step' }));
  return `${[head, ...body].join('\n')}\n`;
}

/**
 * 解析 `serializeTrace` 的输出。
 *
 * @param {string} text
 * @returns {{seed: number | null, hz: number | null, moves: number, steps: Array<{i: number, dtMs: number, dx: number, dy: number}>}}
 */
export function parseTrace(text) {
  let seed = null;
  let hz = null;
  /** @type {Array<{i: number, dtMs: number, dx: number, dy: number}>} */
  const steps = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line);
    if (row.event === 'trace-head') {
      seed = typeof row.seed === 'number' ? row.seed : null;
      hz = typeof row.hz === 'number' ? row.hz : null;
      continue;
    }
    if (row.event !== 'trace-step') continue;
    if (![row.i, row.dtMs, row.dx, row.dy].every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new TypeError(`trace step 含非有限数值：${line}`);
    }
    steps.push({ i: row.i, dtMs: row.dtMs, dx: row.dx, dy: row.dy });
  }
  steps.sort((a, b) => a.i - b.i);
  return { seed, hz, moves: steps.length, steps };
}

/** 位移和（有界性检查用）。 */
export function sumDelta(steps) {
  let dx = 0;
  let dy = 0;
  for (const step of steps) {
    dx += step.dx;
    dy += step.dy;
  }
  return { dx: round6(dx), dy: round6(dy) };
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
