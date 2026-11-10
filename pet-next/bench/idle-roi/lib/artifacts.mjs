/**
 * M3-12 D：三臂素材解析 + ROI 布局核对（只读，不改 manifest 契约）。
 *
 * 素材来源按契约第 3 节：`experiments/idle-roi/out/manifest.json`；C 的 SHA 必须与
 * manifest.candidateSha256 一致，O 的 SHA 必须与 manifest.sourceSha256 一致——
 * 不一致时 summary 记 `shaMatched:false` 并拒绝把该臂当有效数据（不静默使用）。
 * @module pet-next/bench/idle-roi/lib/artifacts
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
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

export function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return { found: false, path: MANIFEST_PATH, manifest: null, error: 'manifest.json 不存在' };
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    return { found: true, path: MANIFEST_PATH, manifest, error: null };
  } catch (error) {
    return { found: false, path: MANIFEST_PATH, manifest: null, error: String(error?.message ?? error) };
  }
}

function pickFirst(candidates) {
  for (const candidate of candidates) {
    const full = path.join(petRoot, candidate);
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
export function resolveArmSource(arm, overrides = {}, manifest = null) {
  if (arm === 'O') {
    const file = overrides.src ? path.resolve(overrides.src) : path.join(petRoot, 'assets/idle.webm');
    return describe(arm, file, manifest?.sourceSha256 ?? null, 'assets/idle.webm（原字节）');
  }
  if (arm === 'F') {
    const file = overrides.fSrc
      ? path.resolve(overrides.fSrc)
      : overrides.src
        ? path.resolve(overrides.src)
        : pickFirst(F_CANDIDATES);
    return describe(arm, file, null, 'experiments/idle-roi/out F 全画布重编码', true);
  }
  const file = overrides.cSrc
    ? path.resolve(overrides.cSrc)
    : overrides.src
      ? path.resolve(overrides.src)
      : pickFirst(C_CANDIDATES);
  return describe(arm, file, manifest?.candidateSha256 ?? null, 'experiments/idle-roi/out C ROI 裁剪', true);
}

function describe(arm, file, expectedSha, label, optional = false) {
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
  return {
    arm,
    path: file,
    label,
    exists: true,
    optional,
    sha256: actual,
    expectedSha,
    shaMatched: expectedSha ? actual === expectedSha : null,
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
 * 用页面实际 rect + videoWidth/videoHeight 核对 ROI 接线是否真的生效。
 * 未接线时 rect.width 会是整个视口（contain 放大到窗口），据此判定 roiLayoutWired=false。
 */
export function verifyLayout(page, manifest) {
  if (!page) return { checked: false, reason: '没有页面快照' };
  const videos = page.videos.filter((video) => video.readyState >= 1 && video.videoWidth > 0);
  if (videos.length === 0) return { checked: false, reason: '没有已加载的视频' };
  const video = videos.find((item) => !item.paused) ?? videos[0];
  const expected = expectedRoiRect(manifest, page.viewport);
  const crop = manifest?.crop;
  const sizeMatches = crop ? video.videoWidth === crop.width && video.videoHeight === crop.height : null;
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
  return {
    checked: true,
    videoSrc: video.src,
    videoIntrinsic: { width: video.videoWidth, height: video.videoHeight },
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
    cropSizeMatches: sizeMatches,
    roiLayoutWired: Boolean(rectMatches && sizeMatches),
  };
}
