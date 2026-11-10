/**
 * M3-12 D：纯统计（无 IO），给 summary.json 与判定用。
 *
 * 口径：
 * - 中位数优先（单核共享机器、偶发外部负载；均值会被单次尖峰带跑）。
 * - “CPU 秒/分钟”= 采样窗内归属进程树 utime+stime 增量 / 墙钟 × 60。
 * - 判定是**工程门**（契约第 7 节），不声称统计显著。
 * @module pet-next/bench/idle-roi/lib/stats
 */

export function median(values) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 === 1 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

export function quantile(values, q) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const pos = (list.length - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return list[lower];
  return list[lower] + (list[upper] - list[lower]) * (pos - lower);
}

export function mean(values) {
  const list = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (list.length === 0) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

const round = (value, digits = 3) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10 ** digits) / 10 ** digits : null;

/**
 * 单臂聚合（只吃 phase === 'measure' 的样本；预热段由调用方单列）。
 * @param {Array<Record<string, any>>} samples
 */
export function summarizeArm(samples) {
  const measure = samples.filter((sample) => sample.phase === 'measure');
  const wallSec = measure.reduce((sum, sample) => sum + (sample.wallMs ?? 0), 0) / 1000;
  const cpuSeconds = measure.reduce((sum, sample) => sum + (sample.cpu?.seconds ?? 0), 0);
  const cpuPercents = measure.map((sample) => sample.cpu?.percent ?? null);
  const rssMb = measure.map((sample) => (sample.rss?.sumBytes ?? 0) / 1024 / 1024);
  const pssMb = measure.map((sample) => (sample.rss?.pssBytes === null ? null : (sample.rss?.pssBytes ?? 0) / 1024 / 1024));
  const loadOne = measure.map((sample) => sample.loadavg?.one ?? null);
  const hostBusy = measure.map((sample) => sample.host?.busyPercent ?? null);
  const decoded = measure.map((sample) => sample.frames?.decodedDelta ?? null);
  const decodedTotal = decoded.every((value) => typeof value === 'number')
    ? decoded.reduce((a, b) => a + b, 0)
    : null;
  const videoSize = measure.map((sample) => sample.video).filter((value) => value && value.width > 0).at(-1) ?? null;
  return {
    samples: measure.length,
    warmupSamples: samples.length - measure.length,
    windowSec: round(wallSec, 3),
    cpuSeconds: round(cpuSeconds, 3),
    cpuSecondsPerMinute: wallSec > 0 ? round((cpuSeconds / wallSec) * 60, 3) : null,
    cpuPercentMedian: round(median(cpuPercents), 3),
    cpuPercentP90: round(quantile(cpuPercents, 0.9), 3),
    cpuPercentMean: round(mean(cpuPercents), 3),
    rssSumMbMedian: round(median(rssMb), 2),
    rssSumMbMax: round(quantile(rssMb, 1), 2),
    pssSumMbMedian: round(median(pssMb), 2),
    loadavg1Median: round(median(loadOne), 2),
    loadavg1Max: round(quantile(loadOne, 1), 2),
    hostCpuBusyMedian: round(median(hostBusy), 1),
    decodedFrames: decodedTotal,
    decodedFps: decodedTotal !== null && wallSec > 0 ? round(decodedTotal / wallSec, 2) : null,
    videoSize,
  };
}

/** 每 rep 的 C/O、C/F 配对下降百分比。 */
export function pairDrops(perRep) {
  const pairs = [];
  const arms = new Map();
  for (const entry of perRep) {
    const key = `${entry.arm}#${entry.rep}`;
    arms.set(key, entry.summary.cpuSecondsPerMinute);
  }
  const reps = [...new Set(perRep.map((entry) => entry.rep))].sort((a, b) => a - b);
  for (const rep of reps) {
    const o = arms.get(`O#${rep}`);
    const f = arms.get(`F#${rep}`);
    const c = arms.get(`C#${rep}`);
    const drop = (base, value) =>
      typeof base === 'number' && base > 0 && typeof value === 'number' ? round(((base - value) / base) * 100, 2) : null;
    pairs.push({ rep, o, f, c, cVsOPercent: drop(o, c), cVsFPercent: drop(f, c) });
  }
  return pairs;
}

/**
 * 契约第 7 节判定的机械复算。全部输入都是 summary 里的原始数，不做拟合。
 * @param {{perArm:Record<'O'|'F'|'C', any>, pairs:Array<any>}} input
 */
export function verdict({ perArm, pairs }) {
  // summary.perArm 存的是跨 rep 的中位（`*Median`），单臂 summary 里才叫 `cpuSecondsPerMinute`。
  // 两种键都认，避免"有数据却判成缺少 CPU 数据"。
  const armCpu = (arm) =>
    perArm[arm]?.cpuSecondsPerMinute ?? perArm[arm]?.cpuSecondsPerMinuteMedian ?? null;
  const cVo = armCpu('C');
  const o = armCpu('O');
  const f = armCpu('F');
  const cVoDrop = typeof o === 'number' && o > 0 && typeof cVo === 'number' ? round(((o - cVo) / o) * 100, 2) : null;
  const cVfDrop = typeof f === 'number' && f > 0 && typeof cVo === 'number' ? round(((f - cVo) / f) * 100, 2) : null;
  const cVsOPairSupports = pairs.filter((pair) => typeof pair.cVsOPercent === 'number' && pair.cVsOPercent > 0).length;
  const cVsFPairSupports = pairs.filter((pair) => typeof pair.cVsFPercent === 'number' && pair.cVsFPercent > 0).length;
  const pairCount = pairs.filter((pair) => pair.cVsOPercent !== null).length;
  const rssO = perArm.O?.rssSumMbMedian;
  const rssC = perArm.C?.rssSumMbMedian;
  const rssDeltaPercent =
    typeof rssO === 'number' && rssO > 0 && typeof rssC === 'number' ? round(((rssC - rssO) / rssO) * 100, 2) : null;
  const loadO = perArm.O?.loadavg1Median;
  const loadC = perArm.C?.loadavg1Median;
  const loadDelta = typeof loadO === 'number' && typeof loadC === 'number' ? round(loadC - loadO, 2) : null;

  const checks = {
    cpuMedianDropAtLeast15: cVoDrop !== null && cVoDrop >= 15,
    cBetterThanFDirection: cVfDrop !== null && cVfDrop > 0,
    pairedSupportAtLeast2of3: pairCount > 0 && cVsOPairSupports / pairCount >= 2 / 3,
    rssWithin10Percent: rssDeltaPercent !== null && rssDeltaPercent <= 10,
    loadComparable: loadDelta !== null && Math.abs(loadDelta) <= 2,
  };
  const reasons = [];
  if (cVoDrop === null) reasons.push('缺少 O 或 C 的 CPU 数据');
  else if (cVoDrop < 15) reasons.push(`C 对 O 中位仅降 ${cVoDrop}%（门 ≥15%）`);
  if (cVfDrop !== null && cVfDrop <= 0) reasons.push(`C 对 F 未同向（${cVfDrop}%）`);
  if (pairCount > 0 && cVsOPairSupports / pairCount < 2 / 3) {
    reasons.push(`配对支持 ${cVsOPairSupports}/${pairCount} < 2/3`);
  }
  if (rssDeltaPercent !== null && rssDeltaPercent > 10) reasons.push(`RSS 增 ${rssDeltaPercent}%（门 ≤10%）`);
  if (loadDelta !== null && Math.abs(loadDelta) > 2) {
    reasons.push(`O/C 臂 loadavg1 中位差 ${loadDelta}（>2），无法与负载波动分离`);
  }
  return {
    cVsOPercent: cVoDrop,
    cVsFPercent: cVfDrop,
    cVsOPairSupports,
    cVsFPairSupports,
    pairCount,
    rssDeltaPercent,
    loadDelta,
    checks,
    pass: Object.values(checks).every(Boolean),
    reasons,
    note: '工程门，非统计显著性；CPU 数值必须与 loadavg 同时解读',
  };
}

/**
 * behavior 模式（`--seconds=0`，只做功能回归）的判定：**不复用 CPU 门**。
 * 判据全部来自探针：布局（含 C 的 ROI 接线）、退出码、残留进程、点击命中率、
 * 隐藏恢复后回到 idle、失败占位可见。
 * `incompleteArms` 是"该臂没产出探针"（例如页面 45s 内未进入可播放状态），
 * 属采集侧抖动，单独列出、不计入 pass/fail，也不补跑填数。
 * @param {{arms:Array<Record<string, any>>}} input
 */
export function behavioralVerdict({ arms }) {
  const detail = [];
  const failed = [];
  const incomplete = [];
  let noLeftovers = true;
  let allExitZero = true;
  for (const entry of arms) {
    const tag = `${entry.label ?? entry.arm}#${entry.rep}`;
    const probes = entry.probes ?? null;
    const click = probes?.click ?? null;
    const layout = entry.layout ?? null;
    const exitCode = entry.exit?.exitCode ?? null;
    const leftovers = (entry.leftovers ?? []).length;
    // “没有数据”和“数据不合格”必须分开：页面 45s 没起来时 click/layout 全是 null，
    // 那不是功能性失败，是采集抖动，记进 incompleteArms、不补跑、也不算 pass。
    const hasClickSamples = Array.isArray(click?.samples) ? click.samples.length > 0 : typeof click?.medianMs === 'number';
    const hasLayout = layout?.layoutMatches === true || layout?.layoutMatches === false;
    if (!probes || (!hasClickSamples && !hasLayout)) {
      incomplete.push({ tag, reason: (entry.failures ?? []).join('; ') || '没有探针数据' });
      continue;
    }
    const row = {
      tag,
      label: entry.label ?? entry.arm,
      layoutMatches: layout ? layout.layoutMatches === true : null,
      roiLayoutWired: layout ? layout.roiLayoutWired ?? null : null,
      objectFit: layout?.objectFit ?? null,
      clickObserved: click?.observed ?? null,
      clickRequested: click?.requested ?? null,
      clickMissed: click?.missed ?? null,
      clickMedianMs: typeof click?.medianMs === 'number' ? round(click.medianMs, 2) : null,
      hiddenResumeIdle: probes?.hidden?.visualAfterResume ?? null,
      failurePlaceholderVisible: probes?.failure?.placeholderVisible ?? null,
      exitCode,
      leftovers,
    };
    detail.push(row);
    const problems = [];
    if (row.layoutMatches !== true) problems.push('布局不符');
    if (row.clickMissed !== 0) problems.push(`点击未命中 ${String(row.clickMissed)}`);
    if (row.clickObserved !== row.clickRequested) problems.push(`点击样本 ${String(row.clickObserved)}/${String(row.clickRequested)}`);
    if (row.hiddenResumeIdle !== 'idle') problems.push('隐藏恢复未回 idle');
    if (row.failurePlaceholderVisible !== true) problems.push('失败占位不可见');
    if (exitCode !== 0) problems.push(`退出码 ${String(exitCode)}`);
    if (leftovers !== 0) problems.push(`残留进程 ${leftovers}`);
    if (problems.length > 0) failed.push({ tag, problems });
    if (exitCode !== 0) allExitZero = false;
    if (leftovers !== 0) noLeftovers = false;
  }
  const clickMedians = detail.map((row) => row.clickMedianMs).filter((value) => typeof value === 'number');
  // 逐臂功能汇总（替代 CPU 的 perArm：behavior 轮不采 CPU，不该出现"三臂全 null"的假象）
  const perArmByLabel = {};
  for (const row of detail) {
    const bucket = perArmByLabel[row.label] ?? { reps: 0, clickMedianMsValues: [], exits: [], leftovers: [], layoutAllMatch: true, roiLayoutWired: null, objectFit: null };
    bucket.reps += 1;
    if (typeof row.clickMedianMs === 'number') bucket.clickMedianMsValues.push(row.clickMedianMs);
    bucket.exits.push(row.exitCode);
    bucket.leftovers.push(row.leftovers);
    bucket.layoutAllMatch = bucket.layoutAllMatch && row.layoutMatches === true;
    bucket.roiLayoutWired = bucket.roiLayoutWired === true || row.roiLayoutWired === true;
    bucket.objectFit = row.objectFit ?? bucket.objectFit;
    perArmByLabel[row.label] = bucket;
  }
  for (const bucket of Object.values(perArmByLabel)) {
    bucket.clickMedianMs = typeof median(bucket.clickMedianMsValues) === 'number' ? round(median(bucket.clickMedianMsValues), 2) : null;
    bucket.exitAllZero = bucket.exits.every((code) => code === 0);
    bucket.leftoversAllZero = bucket.leftovers.every((count) => count === 0);
  }
  return {
    perArmByLabel,
    kind: 'behavioral',
    pass: detail.length > 0 && failed.length === 0 && allExitZero && noLeftovers,
    checks: {
      layoutAllMatch: detail.length > 0 && detail.every((row) => row.layoutMatches === true),
      clicksAllHit: detail.length > 0 && detail.every((row) => row.clickMissed === 0 && row.clickObserved === row.clickRequested),
      hiddenResumeToIdle: detail.length > 0 && detail.every((row) => row.hiddenResumeIdle === 'idle'),
      failurePlaceholder: detail.length > 0 && detail.every((row) => row.failurePlaceholderVisible === true),
      exitCodesZero: allExitZero,
      noLeftoverProcesses: noLeftovers,
    },
    armsChecked: detail.length,
    incompleteArms: incomplete,
    failed,
    clickMedianMsAcrossArms: typeof median(clickMedians) === 'number' ? round(median(clickMedians), 2) : null,
    detail,
    reasons: failed.map((item) => `${item.tag}: ${item.problems.join('/')}`),
    note: 'behavior 轮只做功能回归（--seconds=0 不采 CPU），因此不套用 CPU 收益门；incompleteArms 为采集侧抖动，不补跑',
  };
}
