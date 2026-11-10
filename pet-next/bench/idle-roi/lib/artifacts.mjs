/**
 * M3-12 R1-A：素材入口（已提交 ref → 准确目录）与来源记账。
 *
 * 三条硬规则（本轮修复项，见 codex-review-m312-b9c2f61/evidence/artifacts-smoke.mjs）：
 * 1. 显式 subpath 时 assetsDir 由**本次 git archive 的子路径唯一决定**（`<dest>/<subpath>`），
 *    不再“遍历 dest 找第一个 manifest”。同 dest 先取 v1 再取 v2 各自准确；不清理同 dest
 *    里不属于本次调用的内容。
 * 2. 路径只接受 `pet-next/` 下的仓库相对路径；绝对路径、盘符/反斜杠路径、`..`/`.` 组件、
 *    空路径、pathspec 通配一律拒绝。
 * 3. 子树里没有 manifest.json / O.webm / F*.webm / C*.webm，或实测 SHA 与 manifest 声明
 *    不符 → 非 ok（调用方非零退出）；不存在 ok:true 的空产物。
 *
 * 本模块只做测量，不改 manifest 契约、不改产品代码。
 * @module pet-next/bench/idle-roi/lib/artifacts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { petRoot, sha256 } from './session.mjs';

export const REPO_SUBTREE = 'pet-next';
export const MANIFEST_FILE = 'manifest.json';
/** `--assets-ref` 默认取 v1 子树。 */
export const DEFAULT_ASSETS_SUBPATH = 'experiments/idle-roi/out';
export const MANIFEST_PATH = path.join(petRoot, `${DEFAULT_ASSETS_SUBPATH}/${MANIFEST_FILE}`);
/** 等价的仓库相对路径（含 pet-next/ 前缀），仅作文档/兼容常量。 */
export const ARCHIVE_SUBPATH = `${REPO_SUBTREE}/${DEFAULT_ASSETS_SUBPATH}`;
/** v2（编码域裁剪）在 `out-v2/`，用 `--assets-subpath=experiments/idle-roi/out-v2` 指定。 */
export const ARCHIVE_SUBPATH_V2 = `${REPO_SUBTREE}/experiments/idle-roi/out-v2`;

const O_FILE = 'O.webm';
const F_FILES = ['F.webm', 'full.webm', 'F-full.webm'];
const C_FILES = ['C.webm', 'roi.webm', 'C-roi.webm'];
/** 没有任何显式目录时的最后回退（只读已提交工作区，不跨版本混用）。 */
const F_CANDIDATES = F_FILES.map((name) => `${DEFAULT_ASSETS_SUBPATH}/${name}`);
const C_CANDIDATES = C_FILES.map((name) => `${DEFAULT_ASSETS_SUBPATH}/${name}`);

const MAX_BUFFER = 256 * 1024 * 1024;
/** 无 subpath 时回退扫描的最大深度（dest/<subpath> 本身只有几层）。 */
const MAX_SCAN_DEPTH = 6;

function git(repo, args) {
  return spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: MAX_BUFFER });
}

/** 把 ref 解析成完整提交 SHA（素材来源必须是确定的提交，不接受“当前工作区”）。 */
export function resolveCommit(repo, ref) {
  if (typeof ref !== 'string' || ref.trim() === '') return { ok: false, error: 'ref 为空' };
  const result = git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || `git rev-parse ${ref} 失败`).trim() };
  }
  return { ok: true, commit: result.stdout.trim() };
}

/**
 * 校验 `--assets-subpath`：只接受 `pet-next/` 下的仓库相对路径。
 * 允许省略 `pet-next/` 前缀（工具自己补）。返回规范化后的组件列表，供确定 assetsDir 用。
 * @param {unknown} subpath
 * @returns {{ok:true, subpath:string, archivePath:string, components:string[]}|{ok:false, code:string, error:string}}
 */
export function normalizeAssetsSubpath(subpath) {
  const reject = (error) => ({ ok: false, code: 'invalid-subpath', error });
  const raw = typeof subpath === 'string' ? subpath : '';
  if (raw.trim() === '') return reject('空路径：必须是 pet-next/ 下的仓库相对路径（例如 experiments/idle-roi/out-v2）');
  if (raw.includes('\0')) return reject(`路径含 NUL：${JSON.stringify(raw)}`);
  if (raw.includes('\\')) return reject(`反斜杠路径不接受（必须是 POSIX 相对路径）：${raw}`);
  if (/^[A-Za-z]:/.test(raw)) return reject(`盘符路径不接受：${raw}`);
  if (raw.startsWith('/') || path.isAbsolute(raw)) return reject(`绝对路径不接受：${raw}`);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return reject(`scheme/URL 不接受：${raw}`);
  let text = raw;
  while (text.startsWith('./')) text = text.slice(2);
  if (text === REPO_SUBTREE) return reject(`空路径：只给了 ${REPO_SUBTREE}/，没有子目录`);
  if (text.startsWith(`${REPO_SUBTREE}/`)) text = text.slice(REPO_SUBTREE.length + 1);
  if (text === '') return reject(`空路径：只给了 ${REPO_SUBTREE}/，没有子目录`);
  const components = [];
  for (const component of text.split('/')) {
    if (component === '') return reject(`空路径组件（双斜杠或结尾斜杠）：${raw}`);
    if (component === '.' || component === '..') return reject(`'.'/'..' 组件不接受：${raw}`);
    // git archive 的 pathspec 支持通配/魔法，素材定位不允许“猜一组文件”。
    if (/[*?[\]{}]/.test(component) || component.startsWith(':')) return reject(`pathspec 通配/魔法不接受：${raw}`);
    components.push(component);
  }
  const clean = components.join('/');
  return { ok: true, subpath: clean, archivePath: `${REPO_SUBTREE}/${clean}`, components };
}

/** 递归列出目录下所有文件（相对路径用 POSIX 分隔，SHA 实测）。 */
function walkFiles(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full, base));
      continue;
    }
    files.push({
      name: entry.name,
      relative: path.relative(base, full).split(path.sep).join('/'),
      path: full,
      bytes: statSync(full).size,
      sha256: sha256(full),
    });
  }
  return files;
}

function statOrNull(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function pickStagedFile(dir, names) {
  for (const name of names) {
    const full = path.join(dir, name);
    if (existsSync(full) && statSync(full).isFile()) return full;
  }
  return null;
}

/**
 * manifest 里声明的各文件 SHA。F 没有顶层字段，按“C.sha256 与 candidateSha256 相同的那一版
 * revision”取 F.sha256（v1/v2 各自的 F 不同，不能拿 v1 的 F 去校验 v2 的字节）。
 */
export function manifestFileShas(manifest) {
  const declared = {
    sourceSha256: typeof manifest?.sourceSha256 === 'string' ? manifest.sourceSha256 : null,
    candidateSha256: typeof manifest?.candidateSha256 === 'string' ? manifest.candidateSha256 : null,
    fSha256: null,
    revision: null,
  };
  const revision = manifest?.revision;
  if (revision !== null && typeof revision === 'object') {
    for (const [key, entry] of Object.entries(revision)) {
      const candidate = entry?.C?.sha256 ?? null;
      if (candidate !== null && candidate === declared.candidateSha256 && typeof entry?.F?.sha256 === 'string') {
        declared.fSha256 = entry.F.sha256;
        declared.revision = key;
        break;
      }
    }
  }
  if (declared.fSha256 === null && typeof manifest?.fSha256 === 'string') {
    declared.fSha256 = manifest.fSha256;
    declared.revision = 'top-level';
  }
  return declared;
}

/**
 * 核对一个素材目录：三臂文件齐备 + 实测 SHA 与 manifest 声明一致。
 * 返回 ok=false 时调用方必须非零退出（不能把空/错版本目录当素材）。
 * @param {string|null} assetsDir
 */
export function verifyAssetsDir(assetsDir) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  const empty = {
    dir: assetsDir ?? null,
    manifest: null,
    manifestSha256: null,
    declared: { sourceSha256: null, candidateSha256: null, fSha256: null, revision: null },
    measured: { sourceVideoSha: null, fullCanvasSha: null, candidateSha: null },
    files: [],
    checks: {},
  };
  if (!assetsDir) {
    add('no-assets-dir', '没有 assetsDir（未解析到素材目录）');
    return { ...empty, ok: false, code: 'no-assets-dir', errors: problems.map((item) => item.message) };
  }
  const dir = path.resolve(assetsDir);
  const stat = statOrNull(dir);
  if (!stat || !stat.isDirectory()) {
    add('assets-dir-missing', `素材目录不存在或不是目录：${dir}（子路径指向文件/未解出目录都算失败）`);
    return { ...empty, ok: false, code: 'assets-dir-missing', errors: problems.map((item) => item.message) };
  }

  const manifestFile = path.join(dir, MANIFEST_FILE);
  const manifestSha256 = sha256(manifestFile);
  let manifest = null;
  if (!existsSync(manifestFile)) add('manifest-missing', `缺少 ${MANIFEST_FILE}：${manifestFile}`);
  else if (manifestSha256 === null) add('manifest-invalid', `读不到 ${manifestFile}`);
  else {
    try {
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    } catch (error) {
      add('manifest-invalid', `${MANIFEST_FILE} 不是合法 JSON：${String(error?.message ?? error)}`);
    }
  }
  if (manifest !== null && (manifest === null || typeof manifest !== 'object')) {
    add('manifest-invalid', `${MANIFEST_FILE} 顶层不是对象`);
  }

  const declared = manifestFileShas(manifest);
  const picked = { O: pickStagedFile(dir, [O_FILE]), F: pickStagedFile(dir, F_FILES), C: pickStagedFile(dir, C_FILES) };
  if (picked.O === null) add('missing-file', `缺少 ${O_FILE}（O 臂/来源视频）`);
  if (picked.F === null) add('missing-file', `缺少 F 全画布文件（接受 ${F_FILES.join('/')}）`);
  if (picked.C === null) add('missing-file', `缺少 C 候选文件（接受 ${C_FILES.join('/')}）`);

  const measured = {
    sourceVideoSha: picked.O === null ? null : sha256(picked.O),
    fullCanvasSha: picked.F === null ? null : sha256(picked.F),
    candidateSha: picked.C === null ? null : sha256(picked.C),
  };
  const checks = { oMatchesSource: null, cMatchesCandidate: null, fMatchesManifest: null, fShaDeclared: declared.fSha256 !== null };
  if (manifest !== null) {
    if (declared.sourceSha256 === null) add('manifest-incomplete', `${MANIFEST_FILE} 没有 sourceSha256，无法校验来源视频`);
    else if (measured.sourceVideoSha !== null) {
      checks.oMatchesSource = measured.sourceVideoSha === declared.sourceSha256;
      if (!checks.oMatchesSource) add('sha-mismatch', `O.webm SHA 与 manifest.sourceSha256 不符：实测 ${measured.sourceVideoSha}，声明 ${declared.sourceSha256}`);
    }
    if (declared.candidateSha256 === null) add('manifest-incomplete', `${MANIFEST_FILE} 没有 candidateSha256，无法校验 C 候选`);
    else if (measured.candidateSha !== null) {
      checks.cMatchesCandidate = measured.candidateSha === declared.candidateSha256;
      if (!checks.cMatchesCandidate) add('sha-mismatch', `C.webm SHA 与 manifest.candidateSha256 不符：实测 ${measured.candidateSha}，声明 ${declared.candidateSha256}`);
    }
    if (declared.fSha256 !== null && measured.fullCanvasSha !== null) {
      checks.fMatchesManifest = measured.fullCanvasSha === declared.fSha256;
      if (!checks.fMatchesManifest) add('sha-mismatch', `F.webm SHA 与 manifest.revision.${declared.revision}.F.sha256 不符：实测 ${measured.fullCanvasSha}，声明 ${declared.fSha256}`);
    }
  }

  const code = problems.length === 0 ? 'ok' : problems[0].code;
  return {
    ok: problems.length === 0,
    code,
    errors: problems.map((item) => item.message),
    dir,
    manifest,
    manifestSha256,
    declared,
    measured,
    checks,
    files: walkFiles(dir),
  };
}

/**
 * 从**已提交** ref 精确取出一段素材子树，返回由本次 subpath 唯一决定的 assetsDir。
 * 等价命令：`git -C <repo> archive <ref> pet-next/<subpath> |
 *            tar -x -C <dest> --strip-components=1`（只去掉 pet-next/，保留完整子路径）。
 * 不做任何“清理 dest”的动作：同 dest 里之前的 v1 目录不会被删除。
 * @param {{repo:string, ref:string, dest:string, subpath?:string}} options
 */
export function stageCommittedAssets({ repo, ref, dest, subpath = DEFAULT_ASSETS_SUBPATH }) {
  if (typeof repo !== 'string' || repo.trim() === '') return { ok: false, code: 'bad-args', error: 'stageCommittedAssets 需要 repo' };
  if (typeof dest !== 'string' || dest.trim() === '') return { ok: false, code: 'bad-args', error: 'stageCommittedAssets 需要 dest' };
  const normalized = normalizeAssetsSubpath(subpath);
  if (!normalized.ok) {
    return { ok: false, code: normalized.code, error: normalized.error, subpath, files: [] };
  }
  const resolved = resolveCommit(repo, ref);
  if (!resolved.ok) {
    return { ok: false, code: 'bad-ref', error: `ref 不是可解析的提交：${resolved.error}`, subpath: normalized.archivePath, command: `git -C ${repo} rev-parse --verify ${ref}^{commit}`, files: [] };
  }
  const assetsDir = path.join(path.resolve(dest), ...normalized.components);
  const command = `git -C ${repo} archive ${resolved.commit} ${normalized.archivePath} | tar -x -C ${dest} --strip-components=1`;
  const archive = spawnSync('git', ['-C', repo, 'archive', resolved.commit, normalized.archivePath], { maxBuffer: MAX_BUFFER });
  if (archive.status !== 0) {
    return {
      ok: false,
      code: 'archive-failed',
      command,
      subpath: normalized.archivePath,
      commit: resolved.commit,
      error: String(archive.stderr ?? '').trim() || `git archive ${normalized.archivePath} 失败（子树不存在？）`,
      files: [],
    };
  }
  if (!archive.stdout || archive.stdout.length === 0) {
    return { ok: false, code: 'empty-subtree', command, subpath: normalized.archivePath, commit: resolved.commit, error: 'git archive 输出为空：子树里没有任何已提交文件', files: [] };
  }
  mkdirSync(dest, { recursive: true });
  const tar = spawnSync('tar', ['-x', '-C', dest, '--strip-components=1'], { input: archive.stdout, maxBuffer: MAX_BUFFER });
  if (tar.status !== 0) {
    return { ok: false, code: 'extract-failed', command, subpath: normalized.archivePath, commit: resolved.commit, error: String(tar.stderr ?? '').trim(), files: [] };
  }
  const verification = verifyAssetsDir(assetsDir);
  if (!verification.ok) {
    return {
      ok: false,
      code: verification.code,
      command,
      repo,
      ref,
      commit: resolved.commit,
      subpath: normalized.archivePath,
      dest,
      assetsDir,
      error: verification.errors.join('; '),
      verification,
      files: verification.files,
    };
  }
  return {
    ok: true,
    repo,
    ref,
    commit: resolved.commit,
    subpath: normalized.archivePath,
    dest,
    assetsDir,
    command,
    stripComponents: 1,
    files: verification.files,
    verification,
  };
}

function scanManifestDirs(base, maxDepth) {
  const found = [];
  let level = [{ dir: base, depth: 0 }];
  while (level.length > 0) {
    const next = [];
    for (const { dir, depth } of level) {
      if (existsSync(path.join(dir, MANIFEST_FILE))) found.push(dir);
      if (depth >= maxDepth) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        next.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
    level = next;
  }
  return found;
}

/**
 * 解析素材目录。
 * - 传 `{subpath}`：**不扫描**，直接返回 `<dir>/<subpath>`（本次调用唯一确定），供调用方
 *   复核“staged 目录里到底该用哪一份”；路径非法或目录不存在都返回 ok:false。
 * - 不传 `subpath`：`dir` 本身有 manifest 就用它，否则向下扫描；0 个候选或 2 个以上候选都
 *   失败（报 ambiguous，绝不猜“第一个”）。
 * @param {string|null} dir
 * @param {{maxDepth?:number, subpath?:string|null}} [options]
 */
export function resolveAssetsDirDetailed(dir, { maxDepth = MAX_SCAN_DEPTH, subpath = null } = {}) {
  if (!dir) return { ok: false, code: 'no-dir', dir: null, candidates: [], error: '没有给出素材目录' };
  const base = path.resolve(dir);
  const stat = statOrNull(base);
  if (!stat || !stat.isDirectory()) return { ok: false, code: 'dir-missing', dir: null, candidates: [], error: `素材目录不存在：${base}` };
  if (subpath !== null && subpath !== undefined && subpath !== '') {
    const normalized = normalizeAssetsSubpath(subpath);
    if (!normalized.ok) return { ok: false, code: normalized.code, dir: null, candidates: [], error: normalized.error };
    const exact = path.join(base, ...normalized.components);
    if (!existsSync(exact)) {
      return { ok: false, code: 'subpath-not-found', dir: null, candidates: [exact], error: `显式 subpath 对应的目录不存在：${exact}` };
    }
    return { ok: true, code: 'ok', dir: exact, candidates: [exact], source: 'explicit-subpath' };
  }
  if (existsSync(path.join(base, MANIFEST_FILE))) return { ok: true, code: 'ok', dir: base, candidates: [base], source: 'direct' };
  const candidates = scanManifestDirs(base, maxDepth);
  if (candidates.length === 1) return { ok: true, code: 'ok', dir: candidates[0], candidates, source: 'scan' };
  if (candidates.length === 0) {
    return { ok: false, code: 'manifest-not-found', dir: null, candidates, error: `${base} 下 ${maxDepth} 层内没有 ${MANIFEST_FILE}（空产物不能当素材）` };
  }
  return {
    ok: false,
    code: 'ambiguous-assets-dir',
    dir: null,
    candidates,
    error: `${base} 下有 ${candidates.length} 个含 ${MANIFEST_FILE} 的候选目录，拒绝猜：${candidates.join(', ')}；请用 --assets-subpath=<subpath> 或 --assets-dir=<其中一个>`,
  };
}

/** 兼容旧签名：只在唯一候选（或给了 subpath 时精确命中）返回路径，否则 null（细节见 resolveAssetsDirDetailed）。 */
export function resolveAssetsDir(dir, options) {
  const resolved = resolveAssetsDirDetailed(dir, options);
  return resolved.ok ? resolved.dir : null;
}

export function loadManifest(manifestPath = MANIFEST_PATH) {
  if (!existsSync(manifestPath)) return { found: false, path: manifestPath, manifest: null, error: 'manifest.json 不存在' };
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return { found: true, path: manifestPath, manifest, error: null };
  } catch (error) {
    return { found: false, path: manifestPath, manifest: null, error: String(error?.message ?? error) };
  }
}

function pickFirst(candidates) {
  for (const candidate of candidates) {
    const full = path.join(petRoot, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

function pickStaged(assetsDir, names) {
  if (!assetsDir) return null;
  for (const name of names) {
    const full = path.join(assetsDir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * 解析某臂实际的 idle 源文件。
 * `assetsDir` 一旦给出（= 本次 stage 的准确目录），**不再回退到仓库里的其它版本**：
 * 缺文件就报 missing，而不是悄悄拿 v1 的 F/C 去当 v2 的数据。
 * @param {'O'|'F'|'C'} arm
 * @param {{src?:string, fSrc?:string, cSrc?:string}} overrides 显式覆盖（仅用于人工指定单文件）
 * @param {any|null} manifest
 * @param {string|null} assetsDir
 */
export function resolveArmSource(arm, overrides = {}, manifest = null, assetsDir = null) {
  if (arm === 'O') {
    const staged = pickStaged(assetsDir, [O_FILE]);
    const file = overrides.src
      ? path.resolve(overrides.src)
      : staged ?? (assetsDir === null ? path.join(petRoot, 'assets/idle.webm') : null);
    return describe(
      arm,
      file,
      manifest?.sourceSha256 ?? null,
      staged ? '已提交素材目录里的 O.webm（manifest.sourceSha 对应）' : assetsDir === null ? 'assets/idle.webm（原字节）' : '素材目录里没有 O.webm',
      false,
      path.join(petRoot, 'assets/idle.webm'),
    );
  }
  if (arm === 'F') {
    const file = overrides.fSrc
      ? path.resolve(overrides.fSrc)
      : overrides.src
        ? path.resolve(overrides.src)
        : pickStaged(assetsDir, F_FILES) ?? (assetsDir === null ? pickFirst(F_CANDIDATES) : null);
    return describe(arm, file, null, 'F 全画布重编码（与 C 同预处理/编码/PTS）', true);
  }
  const file = overrides.cSrc
    ? path.resolve(overrides.cSrc)
    : overrides.src
      ? path.resolve(overrides.src)
      : pickStaged(assetsDir, C_FILES) ?? (assetsDir === null ? pickFirst(C_CANDIDATES) : null);
  return describe(arm, file, manifest?.candidateSha256 ?? null, 'C ROI 裁剪（编码分辨率=ROI 宽高）', true);
}

function describe(arm, file, expectedSha, label, optional = false, shippedPath = null) {
  if (file === null || !existsSync(file)) {
    return {
      arm,
      path: file,
      label,
      exists: false,
      optional,
      sha256: null,
      expectedSha,
      shaMatched: null,
      bytes: null,
      reason: '素材文件不存在（本次素材目录里缺该文件，不用其他版本顶替）',
    };
  }
  const actual = sha256(file);
  const size = statSafe(file);
  const shippedSha = shippedPath && existsSync(shippedPath) ? sha256(shippedPath) : null;
  return {
    arm,
    path: file,
    label,
    exists: true,
    optional,
    sha256: actual,
    expectedSha,
    shaMatched: expectedSha ? actual === expectedSha : null,
    shippedPath,
    shippedSha256: shippedSha,
    matchesShipped: shippedSha ? shippedSha === actual : null,
    bytes: size,
  };
}

function statSafe(file) {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

function measuredFromFiles(files, names) {
  const hit = files.find((file) => names.includes(file.name));
  return hit ? hit.sha256 : null;
}

/**
 * 来源记账：全部字段从**实际取出的文件**重算，不接受手填。
 * - `assetCommit`：素材来源提交（`--assets-ref` 解析出的完整 SHA）；
 * - `evaluationCodeCommit`：跑评测的仓库 HEAD（两者不同不是错误，混写才是）；
 * - `sourceVideoSha` / `candidateSha` / `fullCanvasSha`：本臂实际会播放的字节的 SHA；
 * - `files[]`：素材目录里每个文件的实测 sha256 与字节数。
 * @param {{archive?:any, assetsDir?:string|null, sources?:Record<string,any>, codeRepo?:string, shippedIdlePath?:string}} options
 */
export function buildProvenance({ archive = null, assetsDir = null, sources = {}, codeRepo = petRoot, shippedIdlePath = path.join(petRoot, 'assets/idle.webm') } = {}) {
  const verification = archive?.verification ?? (assetsDir ? verifyAssetsDir(assetsDir) : null);
  const files = verification?.files ?? [];
  const head = resolveCommit(codeRepo ?? petRoot, 'HEAD');
  const o = sources?.O ?? null;
  const f = sources?.F ?? null;
  const c = sources?.C ?? null;
  const declared = verification?.declared ?? { sourceSha256: null, candidateSha256: null, fSha256: null, revision: null };
  const measured = verification?.measured ?? { sourceVideoSha: null, fullCanvasSha: null, candidateSha: null };
  const sourceVideoSha = o?.exists ? o.sha256 : measuredFromFiles(files, [O_FILE]) ?? measured.sourceVideoSha;
  const fullCanvasSha = f?.exists ? f.sha256 : measuredFromFiles(files, F_FILES) ?? measured.fullCanvasSha;
  const candidateSha = c?.exists ? c.sha256 : measuredFromFiles(files, C_FILES) ?? measured.candidateSha;
  const shipped = shippedIdlePath && existsSync(shippedIdlePath) ? sha256(shippedIdlePath) : null;
  return {
    schemaVersion: 2,
    assetCommit: archive?.commit ?? verification?.commit ?? null,
    assetRef: archive?.ref ?? null,
    assetSubpath: archive?.subpath ?? null,
    assetArchiveCommand: archive?.command ?? null,
    assetsDir: archive?.assetsDir ?? verification?.dir ?? (assetsDir ? path.resolve(assetsDir) : null),
    evaluationCodeCommit: head.ok ? head.commit : null,
    evaluationCodeRepo: path.resolve(codeRepo ?? petRoot),
    sourceVideoSha,
    fullCanvasSha,
    candidateSha,
    shippedIdleSha: shipped,
    sourceVideoMatchesShipped: shipped !== null && sourceVideoSha !== null ? shipped === sourceVideoSha : null,
    manifestSha256: verification?.manifestSha256 ?? null,
    declared,
    measured: { sourceVideoSha, fullCanvasSha, candidateSha },
    checks: verification?.checks ?? {},
    verification: verification ? { ok: verification.ok, code: verification.code, errors: verification.errors } : null,
    files: files.map((file) => ({ relative: file.relative, bytes: file.bytes, sha256: file.sha256 })),
    note: '所有 SHA 由实际取出的文件重算；assetCommit=素材来源提交，evaluationCodeCommit=跑评测的 HEAD，两者不同不是错误',
  };
}

/** 契约第 4 节的纯布局公式（DIP）。 */
export function expectedRoiRect(manifest, viewport) {
  const crop = manifest?.crop;
  const canvas = manifest?.originalCanvas;
  if (!crop || !canvas || !(viewport?.width > 0) || !(viewport?.height > 0)) return null;
  const s = Math.min(viewport.width / canvas.width, viewport.height / canvas.height);
  return {
    x: (viewport.width - canvas.width * s) / 2 + crop.x * s,
    y: (viewport.height - canvas.height * s) / 2 + crop.y * s,
    width: crop.width * s,
    height: crop.height * s,
    scale: s,
  };
}

/**
 * 用页面实际 rect + videoWidth/videoHeight 核对布局。
 * - `expectRoi=true`（C 臂）：对照契约第 4 节公式，未接线时 rect 会是整个视口 → roiLayoutWired=false；
 * - `expectRoi=false`（O/F 臂）：应保持全窗口 contain（320×240 视口 → rect 0,0,320,240，
 *   视频 intrinsic 为 640×360），仅作基线记录，不参与 ROI 判定。
 */
export function verifyLayout(page, manifest, { expectRoi = false } = {}) {
  if (!page) return { checked: false, reason: '没有页面快照' };
  const videos = page.videos.filter((video) => video.readyState >= 1 && video.videoWidth > 0);
  if (videos.length === 0) return { checked: false, reason: '没有已加载的视频' };
  const video = videos.find((item) => !item.paused) ?? videos[0];
  const expected = expectRoi
    ? expectedRoiRect(manifest, page.viewport)
    : page.viewport
      ? { x: 0, y: 0, width: page.viewport.width, height: page.viewport.height, scale: null }
      : null;
  const crop = manifest?.crop;
  const canvas = manifest?.originalCanvas;
  const sizeMatches = !expectRoi
    ? canvas
      ? video.videoWidth === canvas.width && video.videoHeight === canvas.height
      : null
    : crop
      ? video.videoWidth === crop.width && video.videoHeight === crop.height
      : null;
  const rectDelta = expected
    ? {
        x: Math.round((video.rect.x - expected.x) * 100) / 100,
        y: Math.round((video.rect.y - expected.y) * 100) / 100,
        width: Math.round((video.rect.width - expected.width) * 100) / 100,
        height: Math.round((video.rect.height - expected.height) * 100) / 100,
      }
    : null;
  const tolerance = 1.5;
  const rectMatches =
    rectDelta !== null &&
    Math.abs(rectDelta.x) <= tolerance &&
    Math.abs(rectDelta.y) <= tolerance &&
    Math.abs(rectDelta.width) <= tolerance &&
    Math.abs(rectDelta.height) <= tolerance;
  // 盒子位置对 ≠ 画面正确：object-fit:none 会把 226×286 按原尺寸塞进 113×143 盒
  // （B 指出 830b7cb/4b0b1f0 的 page.css 正是 none）。C 与 O/F 都要求字面量 contain：
  // fill/cover 在 113:143 ≡ 226:286 下会“碰巧同值”，用全等才能在手改 CSS 时立刻暴露。
  const objectFit = video.objectFit ?? null;
  const contentScalingOk = objectFit === 'contain';
  const bodyIdleRoi = page.bodyIdleRoi ?? null;
  return {
    checked: true,
    applicable: expectRoi ? 'roi' : 'contain',
    videoSrc: video.src,
    videoIntrinsic: { width: video.videoWidth, height: video.videoHeight },
    objectFit,
    objectFitExpected: 'contain',
    contentScalingOk,
    bodyIdleRoiClass: bodyIdleRoi,
    videoHidden: video.hidden,
    viewport: page.viewport,
    rect: video.rect,
    expected: expected
      ? {
          x: Math.round(expected.x * 100) / 100,
          y: Math.round(expected.y * 100) / 100,
          width: Math.round(expected.width * 100) / 100,
          height: Math.round(expected.height * 100) / 100,
        }
      : null,
    rectDelta,
    toleranceDip: tolerance,
    intrinsicMatchesExpectation: sizeMatches,
    cropSizeMatches: expectRoi ? sizeMatches : null,
    layoutMatches: Boolean(rectMatches && sizeMatches && contentScalingOk),
    roiLayoutWired: expectRoi ? Boolean(rectMatches && sizeMatches && contentScalingOk) : null,
  };
}
