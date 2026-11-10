/**
 * M3-11 A：纯分析函数（不读文件、不起进程、不看时钟）。
 *
 * 口径（写进 README，别看错）：
 * - 所有时间戳都是**软件时间**：写入时刻取“bench 读到 main 那行 bounds 日志”的时刻，
 *   比 main 里 `win.setPosition` 返回晚一个 IPC/stdout 跳（未在 main 内打时间戳）。
 * - `windowMs` 合并窗口用“相邻两次写入的间隔 < 8ms”判定，另给同一 8ms 桶计数做交叉核对。
 * - 不报 P95、不做显著性检验，只给原始值、样本量、中位数。
 * @module pet-next/bench/drag-write-budget/lib/analysis
 */

/** 中位数；空数组返回 null。偶数个取中间两数均值。 */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lower = sorted[mid - 1] ?? 0;
  const upper = sorted[mid] ?? 0;
  return (lower + upper) / 2;
}

export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** 只保留小数位，避免把浮点噪声当数据。 */
export function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** count / min / median / max / mean；不产出 P95。 */
export function summarize(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  if (clean.length === 0) return { count: 0, minMs: null, medianMs: null, maxMs: null, meanMs: null };
  return {
    count: clean.length,
    minMs: round(Math.min(...clean)),
    medianMs: round(median(clean)),
    maxMs: round(Math.max(...clean)),
    meanMs: round(mean(clean)),
  };
}

/** 相邻元素间隔（ms）；不足两个元素返回空数组。 */
export function intervalsOf(timestamps) {
  const out = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    const prev = timestamps[i - 1];
    const cur = timestamps[i];
    if (typeof prev !== 'number' || typeof cur !== 'number') continue;
    out.push(cur - prev);
  }
  return out;
}

/**
 * 相邻间隔小于 `windowMs` 的对：这就是“同一 8ms 窗口内多次写入”的直接判据。
 * 严格小于（间隔恰好 8ms 不算），并给出对的比例，避免只看绝对数。
 */
export function sameWindowPairs(timestamps, windowMs = 8) {
  /** @type {Array<{index: number, gapMs: number}>} */
  const pairs = [];
  for (let i = 1; i < timestamps.length; i += 1) {
    const prev = timestamps[i - 1];
    const cur = timestamps[i];
    if (typeof prev !== 'number' || typeof cur !== 'number') continue;
    const gap = cur - prev;
    if (gap < windowMs) pairs.push({ index: i, gapMs: round(gap) });
  }
  return {
    windowMs,
    pairCount: pairs.length,
    pairs,
    /** 落在这种对里的写入条数 / 总写入条数。 */
    ratioOfWrites: timestamps.length === 0 ? null : round(pairs.length / timestamps.length, 4),
  };
}

/** 按固定窗口分桶计数（交叉核对用，桶边界会把 7.9/8.1 拆开，所以只当参考）。 */
export function bucketCounts(timestamps, windowMs = 8) {
  const buckets = new Map();
  for (const at of timestamps) {
    if (!Number.isFinite(at)) continue;
    const key = Math.floor(at / windowMs);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let multi = 0;
  let writesInMulti = 0;
  let maxPerBucket = 0;
  for (const count of buckets.values()) {
    if (count > maxPerBucket) maxPerBucket = count;
    if (count > 1) {
      multi += 1;
      writesInMulti += count;
    }
  }
  return { bucketCount: buckets.size, multiBucketCount: multi, writesInMultiBucket: writesInMulti, maxPerBucket };
}

/**
 * 相同坐标重复写：与**上一次成功写入**的 requested 完全相同。
 * 只统计相邻重复（A→A），不把 A→B→A 当重复。
 */
export function duplicateWrites(writes) {
  /** @type {Array<{index: number, requested: {x: number, y: number}, previousIndex: number}>} */
  const pairs = [];
  for (let i = 1; i < writes.length; i += 1) {
    const prev = writes[i - 1];
    const cur = writes[i];
    if (!prev || !cur) continue;
    if (prev.requested.x === cur.requested.x && prev.requested.y === cur.requested.y) {
      pairs.push({ index: i, previousIndex: i - 1, requested: { ...cur.requested } });
    }
  }
  const distinct = new Set(writes.map((write) => `${write.requested.x},${write.requested.y}`)).size;
  return {
    count: pairs.length,
    ratio: writes.length === 0 ? null : round(pairs.length / writes.length, 4),
    distinctCoordinates: distinct,
    pairs,
  };
}

/**
 * 写入侧汇总。
 *
 * @param {Array<{at: number, requested: {x: number, y: number}}>} writes 按时间升序
 * @param {{windowMs?: number}} [options]
 */
export function analyzeWrites(writes, options = {}) {
  const windowMs = options.windowMs ?? 8;
  const timestamps = writes.map((write) => write.at);
  const intervals = intervalsOf(timestamps);
  const spanMs = timestamps.length > 1 ? (timestamps.at(-1) ?? 0) - (timestamps[0] ?? 0) : 0;
  const duplicates = duplicateWrites(writes);
  const sameWindow = sameWindowPairs(timestamps, windowMs);
  return {
    count: writes.length,
    spanMs: round(spanMs),
    rateHz: spanMs > 0 ? round((writes.length - 1) / (spanMs / 1000), 2) : null,
    intervalMs: summarize(intervals),
    intervalRawMs: intervals.map((value) => round(value)),
    sameWindow: {
      windowMs,
      pairCount: sameWindow.pairCount,
      ratioOfWrites: sameWindow.ratioOfWrites,
      examples: sameWindow.pairs.slice(0, 10),
    },
    bucketCounts: bucketCounts(timestamps, windowMs),
    duplicateRequested: {
      count: duplicates.count,
      ratio: duplicates.ratio,
      distinctCoordinates: duplicates.distinctCoordinates,
      examples: duplicates.pairs.slice(0, 10),
    },
  };
}

/**
 * 输入侧汇总（renderer 里只读观察器记录的 pointer 事件）。
 *
 * @param {Array<{type: string, t: number, screenX: number, screenY: number, coalesced?: number}>} events
 * @param {{windowMs?: number, thresholdPx?: number}} [options]
 */
export function analyzePointerEvents(events, options = {}) {
  const windowMs = options.windowMs ?? 8;
  const thresholdPx = options.thresholdPx ?? 5;
  const moves = events.filter((event) => event.type === 'pointermove');
  const downs = events.filter((event) => event.type === 'pointerdown');
  const ups = events.filter((event) => event.type === 'pointerup');
  const timestamps = moves.map((event) => event.t);
  const intervals = intervalsOf(timestamps);
  const spanMs = timestamps.length > 1 ? (timestamps.at(-1) ?? 0) - (timestamps[0] ?? 0) : 0;
  const press = downs[0] ?? null;
  let nonzero = 0;
  let dragStartIndex = -1;
  let prev = null;
  for (let i = 0; i < moves.length; i += 1) {
    const move = moves[i];
    if (!move) continue;
    if (prev !== null && (move.screenX !== prev.screenX || move.screenY !== prev.screenY)) nonzero += 1;
    if (dragStartIndex < 0 && press !== null) {
      const distance = Math.hypot(move.screenX - press.screenX, move.screenY - press.screenY);
      if (distance >= thresholdPx) dragStartIndex = i;
    }
    prev = move;
  }
  const coalesced = moves.reduce((sum, move) => sum + (move.coalesced ?? 0), 0);
  return {
    pointerdown: downs.length,
    pointermove: moves.length,
    pointerup: ups.length,
    moveWithNonZeroScreenDelta: nonzero,
    dragStartMoveIndex: dragStartIndex,
    /** drag-start 之后的 pointermove 条数：理论上每条对应一次 moveBy 提交。 */
    moveAfterDragStart: dragStartIndex < 0 ? 0 : moves.length - dragStartIndex,
    spanMs: round(spanMs),
    arrivalRateHz: spanMs > 0 ? round((moves.length - 1) / (spanMs / 1000), 2) : null,
    intervalMs: summarize(intervals),
    sameWindow: {
      windowMs,
      pairCount: sameWindowPairs(timestamps, windowMs).pairCount,
      maxPerBucket: bucketCounts(timestamps, windowMs).maxPerBucket,
    },
    coalescedEventCount: coalesced,
    movesWithCoalescedPayload: moves.filter((move) => (move.coalesced ?? 0) > 0).length,
    timestamps: timestamps.map((value) => round(value)),
  };
}

/**
 * 解析 /proc/<pid>/stat 的 utime/stime（字段 14/15）。
 * comm 可能含空格和括号，所以从最后一个 ')' 之后切分。
 *
 * @param {string} text
 * @returns {{utime: number, stime: number, ticks: number}}
 */
export function parseProcStat(text) {
  const close = text.lastIndexOf(')');
  if (close < 0) throw new TypeError('not a /proc stat line');
  const fields = text.slice(close + 2).trim().split(/\s+/);
  // 切分后 fields[0] 是字段 3 (state)，所以 utime(14) 在 fields[11]，stime(15) 在 fields[12]。
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) throw new TypeError(`bad stat fields: ${text}`);
  return { utime, stime, ticks: utime + stime };
}

/**
 * CPU 差换算（Linux 口径：jiffies / CLK_TCK）。
 *
 * @param {{ticks: number}} before
 * @param {{ticks: number}} after
 * @param {{hz?: number, wallMs?: number, writes?: number}} [options]
 */
export function cpuDelta(before, after, options = {}) {
  const hz = options.hz ?? 100;
  const wallMs = options.wallMs ?? 0;
  const writes = options.writes ?? 0;
  const ticks = Math.max(0, after.ticks - before.ticks);
  const cpuSeconds = ticks / hz;
  return {
    hz,
    ticks,
    cpuSeconds: round(cpuSeconds, 4),
    /** 占该窗口墙钟的百分比；jiffies 粒度 10ms，窗口很短时只能当量级。 */
    cpuPercentOfWall: wallMs > 0 ? round((cpuSeconds / (wallMs / 1000)) * 100, 2) : null,
    cpuSecondsPerWrite: writes > 0 ? round(cpuSeconds / writes, 5) : null,
  };
}

/**
 * 从一行 stdout 里取出 JSON 载荷。
 * 入口链（chat-local-core）会给子进程的每行加 `[electron] ` 之类前缀，所以不能整行 parse。
 *
 * @param {string} line
 * @returns {any | null}
 */
export function extractJson(line) {
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(line.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 离线投影：把这一轮**已经发生的写入时刻**按冻结契约的 8ms 规则重放一次
 * （首写即时；距上次写 <8ms 的只更新 pending；到期写一次；结束后 flush）。
 *
 * 这是纸面投影，不是跑候选调度器的实测：它忽略了真实 timer 的调度延迟
 * （真实值只会更差一点），所以对“能减少多少写入”给出的是偏乐观的上界。
 *
 * @param {number[]} timestamps 升序的写入时刻
 * @param {number} [budgetMs]
 */
export function projectBudget(timestamps, budgetMs = 8) {
  if (timestamps.length === 0) return { budgetMs, inputWrites: 0, projectedWrites: 0, reduction: null };
  let written = 0;
  let lastWrite = null;
  let pending = null;
  for (const at of timestamps) {
    if (lastWrite === null || at - lastWrite >= budgetMs) {
      written += 1;
      lastWrite = at;
      pending = null;
    } else {
      pending = at;
    }
  }
  if (pending !== null) written += 1;
  return {
    budgetMs,
    inputWrites: timestamps.length,
    projectedWrites: written,
    reduction: round(1 - written / timestamps.length, 4),
    note: '纸面投影（忽略 timer 调度延迟），不是候选实现实测',
  };
}

/**
 * 把 bench 记录的 bounds 行整理成写入序列。
 * 只接受 main 自己打印的 {event:'bounds'}：bench 不另造计数器。
 *
 * @param {Array<{at: number, line: string, chunkSeq: number}>} records
 */
export function collectWrites(records) {
  const writes = [];
  /** @type {Array<{at: number, chunkSeq: number, bounds: any, requested: any, physical: any}>} */
  const rows = [];
  for (const record of records) {
    const payload = extractJson(record.line);
    if (payload === null) continue;
    if (payload === null || typeof payload !== 'object' || payload.event !== 'bounds') continue;
    const requested = payload.requested;
    if (requested === null || typeof requested !== 'object') continue;
    if (!Number.isFinite(requested.x) || !Number.isFinite(requested.y)) continue;
    writes.push({ at: record.at, requested: { x: requested.x, y: requested.y }, bounds: payload.bounds, physical: payload.physical });
    rows.push({ at: round(record.at), chunkSeq: record.chunkSeq, bounds: payload.bounds, requested, physical: payload.physical });
  }
  return { writes, rows };
}

/**
 * 时钟对齐后的“输入→软件提交”延迟（近似值，见 README 口径）。
 *
 * @param {number[]} inputTimesMs renderer 侧 performance.now()（已只取 drag-start 之后的非零位移）
 * @param {number[]} writeTimesMs bench 侧读 bounds 行的单调时刻
 */
export function inputToWriteLatency(inputTimesMs, writeTimesMs) {
  const paired = Math.min(inputTimesMs.length, writeTimesMs.length);
  const latencies = [];
  for (let i = 0; i < paired; i += 1) {
    const input = inputTimesMs[i];
    const write = writeTimesMs[i];
    if (typeof input !== 'number' || typeof write !== 'number') continue;
    latencies.push(write - input);
  }
  return { paired, unpairedInputs: inputTimesMs.length - paired, unpairedWrites: writeTimesMs.length - paired, latencyMs: summarize(latencies) };
}
