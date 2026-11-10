/**
 * M3-12 D：三臂素材解析 + ROI 布局核对（只读，不改 manifest 契约）。
 *
 * 素材来源按契约第 3 节：`experiments/idle-roi/out/manifest.json`；C 的 SHA 必须与
 * manifest.candidateSha256 一致，O 的 SHA 必须与 manifest.sourceSha256 一致——
 * 不一致时 summary 记 `shaMatched:false` 并拒绝把该臂当有效数据（不静默使用）。
 * @module pet-next/bench/idle-roi/lib/artifacts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { petRoot, sha256 } from './session.mjs';

export const MANIFEST_PATH = path.join(petRoot, 'experiments/idle-roi/out/manifest.json');

const F_CANDIDATES = [
  'experiments/idle-roi/out/F.webm',
  'experiments/idle-roi/out/full.webm',
  'experiments/idle-roi/out/F-full.webm',
];
const C_CANDIDATES = [
  'experiments/idle-roi/out/C.webm',
  'experiments/idle-roi/out/roi.webm',
  'experiments/idle-roi/out/C-roi.webm',
];

/** `--assets-ref` 只提取这个子树；strip 3 层后得到 `<dest>/out/*`。 */
export const ARCHIVE_SUBPATH = 'pet-next/experiments/idle-roi/out';

/**
 * 从**已提交** ref 取三臂素材（不读别人的未提交工作区）。
 * 等价命令：`git -C <repo> archive <ref> pet-next/experiments/idle-roi/out |
 *            tar -x -C <dest> --strip-components=3`。
 * @param {{repo:string, ref:string, dest:string}} options
 */
export function stageCommittedAssets({ repo, ref, dest }) {
  mkdirSync(dest, { recursive: true });
  const head = spawnSync('git', ['-C', repo, 'cat-file', '-t', ref], { encoding: 'utf8' });
  if (head.status !== 0) {
    return { ok: false, command: `git -C ${repo} cat-file -t ${ref}`, error: (head.stderr || head.stdout || '').trim() };
  }
  const archive = spawnSync('git', ['-C', repo, 'archive', ref, ARCHIVE_SUBPATH], { maxBuffer: 256 * 1024 * 1024 });
  if (archive.status !== 0) {
    return {
      ok: false,
      command: `git -C ${repo} archive ${ref} ${ARCHIVE_SUBPATH}`,
      error: String(archive.stderr ?? '').trim(),
    };
  }
  const tar = spawnSync('tar', ['-x', '-C', dest, '--strip-components=3'], { input: archive.stdout, maxBuffer: 256 * 1024 * 1024 });
  if (tar.status !== 0) {
    return {
      ok: false,
      command: `git -C ${repo} archive ${ref} ${ARCHIVE_SUBPATH} | tar -x -C ${dest} --strip-components=3`,
      error: String(tar.stderr ?? '').trim(),
    };
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push({ path: full, sha256: sha256(full), bytes: statSync(full).size });
    }
  };
  walk(dest);
  return {
    ok: true,
    repo,
    ref,
    dest,
    command: `git -C ${repo} archive ${ref} ${ARCHIVE_SUBPATH} | tar -x -C ${dest} --strip-components=3`,
    files,
  };
}

/** staged 目录既可能是 `<dest>/out`，也可能是调用方直接给的 `out` 目录。 */
export function resolveAssetsDir(dir) {
  if (!dir) return null;
  const nested = path.join(dir, 'out');
  if (existsSync(path.join(nested, 'manifest.json'))) return nested;
  if (existsSync(path.join(dir, 'manifest.json'))) return dir;
  return nested;
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
 * @param {'O'|'F'|'C'} arm
 * @param {{src?:string, fSrc?:string, cSrc?:string}} overrides 显式覆盖（阶段二 A 产物命名不同时）
 * @param {any|null} manifest
 */
export function resolveArmSource(arm, overrides = {}, manifest = null, assetsDir = null) {
  if (arm === 'O') {
    const staged = pickStaged(assetsDir, ['O.webm']);
    const file = overrides.src
      ? path.resolve(overrides.src)
      : staged ?? path.join(petRoot, 'assets/idle.webm');
    return describe(
      arm,
      file,
      manifest?.sourceSha256 ?? null,
      staged ? '已提交 out/O.webm（manifest.sourceSha 对应）' : 'assets/idle.webm（原字节）',
      false,
      path.join(petRoot, 'assets/idle.webm'),
    );
  }
  if (arm === 'F') {
    const file = overrides.fSrc
      ? path.resolve(overrides.fSrc)
      : overrides.src
        ? path.resolve(overrides.src)
        : pickStaged(assetsDir, ['F.webm', 'full.webm', 'F-full.webm']) ?? pickFirst(F_CANDIDATES);
    return describe(arm, file, null, 'F 全画布重编码（与 C 同预处理/编码/PTS）', true);
  }
  const file = overrides.cSrc
    ? path.resolve(overrides.cSrc)
    : overrides.src
      ? path.resolve(overrides.src)
      : pickStaged(assetsDir, ['C.webm', 'roi.webm', 'C-roi.webm']) ?? pickFirst(C_CANDIDATES);
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
      reason: '素材文件不存在（A 的产物未落地或路径不同）',
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
  // （B 指出 830b7cb 的 page.css 正是 none）。O/F 基线要求 contain，C 要求非 none。
  const objectFit = video.objectFit ?? null;
  const contentScalingOk = expectRoi ? objectFit !== null && objectFit !== 'none' : objectFit === 'contain';
  const bodyIdleRoi = page.bodyIdleRoi ?? null;
  return {
    checked: true,
    applicable: expectRoi ? 'roi' : 'contain',
    videoSrc: video.src,
    videoIntrinsic: { width: video.videoWidth, height: video.videoHeight },
    objectFit,
    objectFitExpected: expectRoi ? 'not-none' : 'contain',
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
