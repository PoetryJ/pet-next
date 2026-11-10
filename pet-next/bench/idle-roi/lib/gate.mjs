/**
 * M3-12 R1 D：阶段门（机器放行，无人工覆盖）。
 *
 * 目的：任何一次性能/行为采集在**启动 Electron 之前**必须先过三道机器检查：
 *   1. 素材目录是**本次 subpath** 的准确目录（不是“遍历找到的第一个 manifest”），
 *      存在、非空、含 manifest；
 *   2. `tests/idle-roi/out/quality-report.json` 的 `verdict.status` 必须是 `passed`,
 *      且报告阈值不得比冻结基线更松、`gates` 必须全绿；
 *   3. 报告声明的 O/F/C 素材 SHA 与本次真正加载的三个文件 SHA 逐一相同，
 *      报告内部（arms / provenance / manifest）与本次 manifest 也不许自相矛盾。
 *
 * 没有任何 `--force` / `--allow-missing` / “上次跑过了”式放行：本模块只返回判定，
 * 调用方（run.mjs）在 `ok !== true` 时直接非零退出。报告 sha/filename 之外的
 * 一切“记忆”都不参与判定。
 *
 * 退出码约定（由 run.mjs 使用）：4 = 素材/staging 前置不满足；5 = 质量报告门拒绝。
 * @module pet-next/bench/idle-roi/lib/gate
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { resolveAssetsDir } from './artifacts.mjs';
import { petRoot, sha256 } from './session.mjs';

/** 质量报告在仓内的固定位置（相对 pet-next/）。 */
export const QUALITY_REPORT_REL = 'tests/idle-roi/out/quality-report.json';

/**
 * 冻结阈值基线（原 O-C 门 MAE<=1 / P99<=2，F-C 通道/alpha <=2，覆盖、时间轴、几何原样）。
 * 报告里的阈值只许**等于或更严**；缺字段即视为“无法证明没放宽”而拒绝。
 */
export const THRESHOLD_BASELINE = {
  frameCount: 48,
  roiOutsideOpaque: 0,
  ptsDeltaMs: 1,
  durationDeltaMs: 1,
  fToCChannelMaxLsb: 2,
  fToCAlphaMaxLsb: 2,
  ocMaeLsb: 1,
  ocP99Lsb: 2,
  bboxDeltaPx: 1,
  centroidDeltaPx: 0.5,
  alphaThreshold: 1,
};

/** `--plan=F3,C3` 这类本轮命名 → 内部臂 id。 */
export const ARM_ALIASES = { O: 'O', F: 'F', F3: 'F', C: 'C', C3: 'C' };

const SHA_RE = /^[0-9a-f]{64}$/;

/** 臂的候选文件名（按优先级；SHA 匹配优先于顺序）。 */
export const ARM_FILE_CANDIDATES = {
  O: ['O.webm'],
  F: ['F3.webm', 'F.webm', 'full.webm', 'F-full.webm'],
  C: ['C3.webm', 'C.webm', 'roi.webm', 'C-roi.webm'],
};

/** 文件短名 → 臂 id（用于把 provenance.files 的键映射回臂）。 */
function armFromFilename(name) {
  const base = path.basename(String(name)).replace(/\.[^.]+$/, '').toUpperCase();
  if (base === 'O') return 'O';
  if (['F', 'F3', 'FULL', 'F-FULL'].includes(base)) return 'F';
  if (['C', 'C3', 'ROI', 'C-ROI'].includes(base)) return 'C';
  return null;
}

function statBytes(file) {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/** 读报告本体；返回路径、文件字节 SHA、解析结果（不吞错误）。 */
export function readQualityReport(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return { found: false, path: filePath ?? null, sha256: null, bytes: null, report: null, error: '质量报告文件不存在' };
  }
  const text = readFileSync(filePath, 'utf8');
  const fileSha = sha256(filePath);
  const bytes = statBytes(filePath);
  try {
    return { found: true, path: filePath, sha256: fileSha, bytes, report: JSON.parse(text), error: null };
  } catch (error) {
    return { found: true, path: filePath, sha256: fileSha, bytes, report: null, error: `JSON 解析失败：${String(error?.message ?? error)}` };
  }
}

/**
 * 从报告里取 verdict 结论。只认字面量 `passed`：
 * `verdict.status` 优先，其次顶层 `status`，再次 `verdict.pass`；
 * 任何 false/非 passed 信号、或 gate 列表里有非绿项，都判不通过。
 */
export function evaluateStatus(report) {
  const signals = [];
  const add = (route, val) => {
    if (val !== undefined && val !== null) signals.push({ path: route, value: val });
  };
  add('verdict.status', report?.verdict?.status);
  add('verdict.pass', report?.verdict?.pass);
  add('status', report?.status);
  const gateRows = Array.isArray(report?.gates)
    ? report.gates.map((row) => ({
        id: row?.id ?? null,
        pass: row?.pass === undefined ? (row?.status === undefined ? null : row.status === 'passed' || row.status === 'pass') : row.pass === true,
      }))
    : [];

  let status = null;
  if (typeof report?.verdict?.status === 'string') status = report.verdict.status;
  else if (typeof report?.status === 'string') status = report.status;
  else if (typeof report?.verdict?.pass === 'boolean') status = report.verdict.pass ? 'passed' : 'failed';

  const errors = [];
  if (status === null) {
    errors.push('报告里没有 verdict.status（也没有 status / verdict.pass），无法证明画质门通过');
  } else if (status !== 'passed') {
    const failed = Array.isArray(report?.verdict?.failed) ? report.verdict.failed : [];
    errors.push(`verdict.status=${status}（不是 passed）${failed.length ? `；失败门：${failed.join(',')}` : ''}`);
  }
  for (const signal of signals) {
    if (signal.path === 'verdict.pass' && signal.value !== true) errors.push(`verdict.pass=${signal.value}`);
  }
  for (const row of gateRows) {
    if (row.pass !== true) errors.push(`门 ${row.id ?? '(未命名)'} 未通过（pass=${String(row.pass)}）`);
  }
  // R1 C 的分层结论：候选门（verdict.candidates）+ 前置（verdict.prerequisites，例如原生 YUVA
  // 直通自对照）都必须绿；`verdict.historical` 是历史版本记录，失败不等于候选失败，只记账。
  const candidates = report?.verdict?.candidates ?? null;
  const prerequisites = Array.isArray(report?.verdict?.prerequisites) ? report.verdict.prerequisites : [];
  if (candidates && typeof candidates.pass === 'boolean') {
    add('verdict.candidates.pass', candidates.pass);
    if (candidates.pass !== true) errors.push(`verdict.candidates.pass=${String(candidates.pass)}（候选门未通过）`);
    if (Array.isArray(candidates.failed) && candidates.failed.length > 0) {
      errors.push(`候选门失败项：${candidates.failed.join(',')}`);
    }
  }
  for (const row of prerequisites) {
    if (row?.pass !== true && row?.status !== 'passed') {
      errors.push(`前置 ${row?.category ?? '(未命名)'} 未通过（status=${String(row?.status)}, pass=${String(row?.pass)}）`);
    }
  }
  return {
    reported: status,
    passed: errors.length === 0 && status === 'passed',
    subject: report?.verdict?.subject ?? candidates?.category ?? null,
    candidates: candidates ? { category: candidates.category ?? null, status: candidates.status ?? null, pass: candidates.pass ?? null, failed: candidates.failed ?? [] } : null,
    prerequisites: prerequisites.map((row) => ({ category: row?.category ?? null, status: row?.status ?? null, pass: row?.pass ?? null })),
    historicalFailed: Array.isArray(report?.verdict?.historicalFailed) ? report.verdict.historicalFailed : [],
    signals,
    gates: gateRows,
    errors,
  };
}

/** 报告阈值必须覆盖基线且不松于基线。 */
export function checkThresholds(report) {
  const actual = report?.thresholds ?? null;
  const errors = [];
  const rows = [];
  if (!actual || typeof actual !== 'object') {
    return { ok: false, rows, errors: ['报告没有 thresholds，无法证明画质门阈值未被放宽'] };
  }
  for (const [key, baseline] of Object.entries(THRESHOLD_BASELINE)) {
    const value = actual[key];
    const numeric = typeof value === 'number' && Number.isFinite(value);
    const ok = numeric && value <= baseline;
    rows.push({ key, value: value ?? null, baseline, ok });
    if (!numeric) errors.push(`thresholds.${key} 缺失或非数值（基线 ${baseline}）`);
    else if (value > baseline) errors.push(`thresholds.${key}=${value} 比冻结基线 ${baseline} 更松（放水）`);
  }
  return { ok: errors.length === 0, rows, errors };
}

/**
 * 汇总报告对每个臂的 SHA 主张（含本次 staged manifest 的主张）。
 * 同一臂出现两个不同 SHA 即“报告自相矛盾”，不能放行。
 */
export function collectArmShaClaims(report, stagedManifest = null) {
  const claims = { O: [], F: [], C: [] };
  const add = (arm, source, sha) => {
    if (!arm || typeof sha !== 'string') return;
    const text = sha.trim().toLowerCase();
    if (!SHA_RE.test(text)) return;
    claims[arm].push({ source, sha256: text });
  };
  add('O', 'report.arms.sourceSha256', report?.arms?.sourceSha256);
  // R1 C 的报告格式：`verdict.candidates.sha256.{O,F,C}` 才是"本次被测候选臂"的字节，
  // `verdict.historical` / 其他 `variants` 是历史与自对照，**不能**当同一臂的第二个主张。
  const candidateShas = report?.verdict?.candidates?.sha256 ?? null;
  for (const arm of ['O', 'F', 'C']) add(arm, `report.verdict.candidates.sha256.${arm}`, candidateShas?.[arm]);
  const candidateCategory = report?.verdict?.candidates?.category ?? null;
  if (candidateCategory !== null) {
    for (const [index, variant] of (report?.variants ?? []).entries()) {
      if (variant?.category !== candidateCategory) continue;
      for (const arm of ['O', 'F', 'C']) {
        add(arm, `report.variants[${index}].arms.sha256.${arm}`, variant?.arms?.sha256?.[arm]);
      }
    }
  }
  add('F', 'report.arms.fSha256', report?.arms?.fSha256);
  add('C', 'report.arms.candidateSha256', report?.arms?.candidateSha256);
  add('O', 'report.manifest.sourceSha256', report?.manifest?.sourceSha256);
  add('C', 'report.manifest.candidateSha256', report?.manifest?.candidateSha256);
  add('O', 'report.provenance.oSourceSha256', report?.provenance?.oSourceSha256);
  add('F', 'report.provenance.fSourceSha256', report?.provenance?.fSourceSha256);
  add('C', 'report.provenance.cSourceSha256', report?.provenance?.cSourceSha256);
  for (const [name, entry] of Object.entries(report?.provenance?.files ?? {})) {
    add(armFromFilename(name), `report.provenance.files[${name}].sha256`, entry?.sha256);
  }
  for (const [key, entry] of Object.entries(report?.arms ?? {})) {
    if (!['O', 'F', 'C', 'F3', 'C3'].includes(String(key).toUpperCase())) continue;
    add(ARM_ALIASES[String(key).toUpperCase()], `report.arms.${key}.sha256`, entry?.sha256 ?? entry?.video?.sha256);
  }
  for (const [key, entry] of Object.entries(report?.assets ?? {})) {
    add(ARM_ALIASES[String(key).toUpperCase()] ?? null, `report.assets.${key}.sha256`, entry?.sha256);
  }
  add('O', 'staged-manifest.sourceSha256', stagedManifest?.sourceSha256);
  add('C', 'staged-manifest.candidateSha256', stagedManifest?.candidateSha256);
  add('F', 'staged-manifest.fSha256', stagedManifest?.fSha256);
  add('F', 'staged-manifest.f3Sha256', stagedManifest?.f3Sha256);
  add('C', 'staged-manifest.c3Sha256', stagedManifest?.c3Sha256);

  const resolved = {};
  const errors = [];
  for (const [arm, list] of Object.entries(claims)) {
    const distinct = [...new Set(list.map((item) => item.sha256))];
    resolved[arm] = { sha256: distinct.length === 1 ? distinct[0] : null, distinct, claims: list };
    if (distinct.length === 0) errors.push(`${arm}: 报告()没有该臂的素材 SHA，无法核对`);
    else if (distinct.length > 1) {
      errors.push(
        `${arm}: 报告内部素材 SHA 自相矛盾 → ${distinct.join(' | ')}（来源：${list.map((item) => `${item.source}=${item.sha256.slice(0, 8)}`).join(', ')}）`,
      );
    }
  }
  return { ok: errors.length === 0, claims: resolved, errors };
}

/** 依次跑 git，返回 stdout（失败返回 null，不抛）。 */
function git(repo, args) {
  const out = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout.trim() : null;
}

/**
 * 报告必须是**已提交且工作区干净**的字节：否则谁都能改一份“passed”放行。
 * 报告不在仓内（例如自检用的临时负控/正控）时标 external，只允许 preflight 使用。
 */
export function checkReportProvenance({ repo, relPath }) {
  if (!repo || !relPath) return { tracked: null, clean: null, commit: null, external: true, errors: [] };
  const tracked = git(repo, ['ls-files', '--error-unmatch', relPath]);
  if (tracked === null) {
    return { tracked: false, clean: null, commit: null, external: false, errors: [`质量报告未被 git 跟踪（${relPath}），不能作为放行依据`] };
  }
  const dirty = git(repo, ['status', '--porcelain', '--', relPath]);
  const commit = git(repo, ['log', '-1', '--format=%H', '--', relPath]);
  const errors = [];
  if (dirty !== null && dirty !== '') errors.push(`质量报告有未提交改动（${dirty}），不能作为放行依据`);
  return { tracked: true, clean: dirty === '', commit: commit || null, external: false, errors };
}

/**
 * 精确解析“本次 subpath”的素材目录：
 *   - 目录名必须等于 subpath 末段（`out` / `out-v2` / `out-v3-yuva`），不回退、不遍历；
 *   - 必须含 manifest.json 且至少有一个臂文件（空目录不算）；
 *   - 与 artifacts.resolveAssetsDir 的结果交叉核对，两者不一致就拒跑
 *     （同 dest 先 out 后 out-v2 时旧实现会选回 out，这就是要挡的）。
 */
export function resolveAssetsDirExact({ dest, subpath, assetsDirArg = null, expectedDir = null }) {
  const subpathName = path.basename(String(subpath).replace(/\/+$/, ''));
  // expectedDir：A 的 stageCommittedAssets 现在用 `--strip-components=1` 保留完整子路径，
  // 并直接返回由 subpath 唯一决定的 assetsDir —— 有它就以它为准（布局变了也不猜）。
  const expected = expectedDir
    ? path.resolve(expectedDir)
    : assetsDirArg
      ? path.resolve(assetsDirArg)
      : dest
        ? path.join(dest, subpathName)
        : null;
  const evidence = {
    subpath: String(subpath),
    subpathName,
    dest: dest ?? null,
    assetsDirArg: assetsDirArg ?? null,
    expectedDir: expectedDir ? path.resolve(expectedDir) : null,
    expected,
    artifactsResolveAssetsDir: null,
    errors: [],
  };
  if (!expected) {
    evidence.errors.push('没有 dest 也没有 --assets-dir，无法定位素材目录');
    return { ok: false, dir: null, evidence };
  }
  if (path.basename(expected) !== subpathName) {
    evidence.errors.push(
      `素材目录 ${expected} 的目录名与本次 subpath 末段 ${subpathName} 不一致（--assets-dir 必须与 --assets-subpath 对齐）`,
    );
  }
  if (!existsSync(expected) || !statSync(expected).isDirectory()) {
    evidence.errors.push(`素材目录不存在或不是目录：${expected}`);
  } else {
    const manifestPath = path.join(expected, 'manifest.json');
    if (!existsSync(manifestPath)) evidence.errors.push(`素材目录缺 manifest.json：${expected}`);
    const armFiles = Object.values(ARM_FILE_CANDIDATES)
      .flat()
      .filter((name) => existsSync(path.join(expected, name)));
    evidence.armFiles = armFiles;
    if (armFiles.length === 0) evidence.errors.push(`素材目录里没有任何臂视频（${expected}）；空产物不算取到素材`);
    // 交叉核对 A 的 resolveAssetsDir：
    // 1) 两参精确模式（<dest>/<subpath>）必须命中本次目录，不扫描、不猜；
    // 2) 单参模式若返回了目录，必须是同一个（旧实现会选回 out/，这条就是挡它）；返回 null 表示
    //    dest 里有多份候选（拒绝猜），此时以第 1 条为准。
    if (dest) {
      const exact = resolveAssetsDir(dest, { subpath });
      evidence.artifactsResolveAssetsDirExact = exact ? path.resolve(exact) : null;
      if (!exact || path.resolve(exact) !== path.resolve(expected)) {
        evidence.errors.push(
          `resolveAssetsDir(dest, { subpath }) 未精确命中本次目录：${exact ?? 'null'}（本次应为 ${expected}）；拒跑`,
        );
      }
    }
    const crossCheck = resolveAssetsDir(dest ?? path.dirname(expected));
    evidence.artifactsResolveAssetsDir = crossCheck ?? null;
    if (crossCheck && path.resolve(crossCheck) !== path.resolve(expected)) {
      evidence.errors.push(
        `resolveAssetsDir 选中了别的目录：${crossCheck}（本次应为 ${expected}）；拒跑，避免拿旧 out 的字节当本轮素材`,
      );
    }
  }
  return { ok: evidence.errors.length === 0, dir: expected, evidence };
}

/**
 * 在 assetsDir 里为该臂挑文件：**SHA 匹配优先**，其次固定候选顺序。
 * 逐个记录候选的 SHA/字节，找不到与找到但都不符要能区分（错误信息要能直接指向问题）。
 */
export function pickArmFile({ assetsDir, arm, expectedSha256, petRootDir = petRoot, allowShippedFallback = false }) {
  const names = ARM_FILE_CANDIDATES[arm] ?? [];
  const candidates = [];
  for (const name of names) {
    const full = assetsDir ? path.join(assetsDir, name) : null;
    if (!full || !existsSync(full)) continue;
    const sha = sha256(full);
    candidates.push({ name, path: full, sha256: sha, bytes: statBytes(full), matchesExpected: sha === expectedSha256, origin: 'staged' });
  }
  let chosen = candidates.find((item) => item.matchesExpected) ?? null;
  let fallback = null;
  if (!chosen && allowShippedFallback) {
    const shipped = path.join(petRootDir, 'assets/idle.webm');
    if (existsSync(shipped)) {
      const sha = sha256(shipped);
      fallback = { name: 'assets/idle.webm', path: shipped, sha256: sha, bytes: statBytes(shipped), matchesExpected: sha === expectedSha256, origin: 'shipped' };
      if (fallback.matchesExpected) chosen = fallback;
    }
  }
  return {
    arm,
    expectedSha256,
    chosen,
    candidates,
    fallback,
    reason: chosen
      ? null
      : candidates.length === 0 && !fallback
        ? `素材目录里没有该臂文件（找过 ${names.join('/')}）：${assetsDir}`
        : `找到的候选 SHA 都与之不符（期望 ${expectedSha256}）：${[...candidates, fallback].filter(Boolean).map((item) => `${item.name}=${String(item.sha256).slice(0, 8)}`).join(', ')}`,
  };
}

/**
 * 阶段门总判定。`strict`（perf/behavior）下报告必须在仓内、已跟踪、工作区干净。
 * 返回 { ok, code, errors, evidence }；**不抛异常、不退出进程**，由调用方处理。
 */
export function evaluateStageGate({
  repo,
  subpath,
  dest = null,
  assetsDirArg = null,
  expectedDir = null,
  qualityReportPath,
  qualityReportRel = QUALITY_REPORT_REL,
  strictReport = true,
  stagedManifest = null,
  petRootDir = petRoot,
}) {
  const errors = [];
  const codes = new Set();
  const evidence = { checkedAt: new Date().toISOString(), petRoot: petRootDir, subpath, strictReport };

  const dirCheck = resolveAssetsDirExact({ dest, subpath, assetsDirArg, expectedDir });
  evidence.assetsDir = dirCheck.evidence;
  if (!dirCheck.ok) {
    errors.push(...dirCheck.evidence.errors);
    codes.add(4);
  }

  const reportInfo = readQualityReport(qualityReportPath);
  evidence.qualityReport = {
    path: reportInfo.path,
    relPath: qualityReportRel,
    sha256: reportInfo.sha256,
    bytes: reportInfo.bytes,
    found: reportInfo.found,
    error: reportInfo.error,
  };
  if (!reportInfo.found) {
    errors.push(`读不到质量报告：${reportInfo.path ?? '(未给路径)'}`);
    codes.add(5);
    return { ok: false, code: pickCode(codes), errors, evidence };
  }
  if (!reportInfo.report) {
    errors.push(`质量报告无法解析（${reportInfo.path}，sha256=${reportInfo.sha256}）：${reportInfo.error}`);
    codes.add(5);
    return { ok: false, code: pickCode(codes), errors, evidence };
  }
  const report = reportInfo.report;

  // 报告来源可信度（已提交 + 工作区干净）。
  const prov = checkReportProvenance({ repo: strictReport ? repo : null, relPath: qualityReportRel });
  evidence.qualityReport.provenance = prov;
  if (strictReport && prov.errors.length > 0) {
    errors.push(...prov.errors);
    codes.add(5);
  }

  if (report.kind !== undefined && report.kind !== 'idle-roi-quality') {
    errors.push(`质量报告 kind=${String(report.kind)}，不是 idle-roi-quality（${reportInfo.path}）`);
    codes.add(5);
  }

  const status = evaluateStatus(report);
  evidence.qualityReport.status = status;
  if (!status.passed) {
    errors.push(...status.errors.map((item) => `${item}（报告：${reportInfo.path}，sha256=${reportInfo.sha256}）`));
    codes.add(5);
  }

  const thresholds = checkThresholds(report);
  evidence.qualityReport.thresholds = thresholds;
  if (!thresholds.ok) {
    errors.push(...thresholds.errors.map((item) => `${item}（报告：${reportInfo.path}）`));
    codes.add(5);
  }

  const claims = collectArmShaClaims(report, stagedManifest);
  evidence.armShaClaims = claims;
  if (!claims.ok) {
    errors.push(...claims.errors.map((item) => `${item}（报告：${reportInfo.path}，sha256=${reportInfo.sha256}）`));
    codes.add(5);
  }

  const picks = {};
  for (const arm of ['O', 'F', 'C']) {
    const expected = claims.claims[arm]?.sha256 ?? null;
    if (!expected) {
      picks[arm] = { arm, expectedSha256: null, chosen: null, reason: '报告没有该臂 SHA，无法核对，拒绝放行' };
      continue;
    }
    picks[arm] = pickArmFile({
      assetsDir: dirCheck.dir,
      arm,
      expectedSha256: expected,
      petRootDir,
      allowShippedFallback: arm === 'O',
    });
    if (!picks[arm].chosen) {
      // 有候选文件但都对不上 = SHA 冲突（5）；连候选都没有 = 素材缺失（4）。
      const sawCandidates = picks[arm].candidates.length > 0 || Boolean(picks[arm].fallback);
      errors.push(`${arm}: ${picks[arm].reason}${sawCandidates ? '（文件存在但与报告 SHA 冲突）' : ''}`);
      codes.add(sawCandidates ? 5 : 4);
    } else if (picks[arm].chosen.sha256 !== expected) {
      errors.push(`${arm}: 加载的 ${picks[arm].chosen.path} sha256=${picks[arm].chosen.sha256} 与报告 ${expected} 不一致`);
      codes.add(5);
    }
  }
  evidence.arms = picks;

  return { ok: errors.length === 0, code: errors.length === 0 ? 0 : pickCode(codes), errors, evidence };
}

function pickCode(codes) {
  // 报告被拒（5）优先报出来：它才是“必须停”的原因；素材问题同时存在时正文都已列出。
  return codes.has(5) ? 5 : codes.has(4) ? 4 : 1;
}
