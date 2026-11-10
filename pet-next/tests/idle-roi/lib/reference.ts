/**
 * 引用重建：报告的每一个数字都要能追到「哪一版字节、哪条命令、哪种实际像素格式」。
 *
 * 三件事分开记，因为它们是三件不同的事：
 * 1. `manifest`：素材自带的声明（sha、crop、colorTags、PTS）；
 * 2. `statedCommands`：产物构建记录里**实际执行过**的 ffmpeg/ffprobe 命令行（从
 *    `build-report.json` 里逐条挖出来，含其 JSON 路径，便于回查）；
 * 3. `actual`：产物字节自己报出来的 pix_fmt / range / matrix / alpha_mode。
 *
 * 声明与实际不一致时，以 `actual` 为准并把差异写进 `colorConsistency`。
 * 构建记录缺失不是错误，但必须显式写成 `gaps`，不能默默当"没有命令"。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { decodePlanesCommand, decodeRgbaCommand, probeStreamCommand, probeStream, type StreamInfo } from './media.ts';
import { petRoot, sha256File, type ArmKey, type Arms } from './arms.ts';

export interface StreamActual {
  readonly key: string;
  readonly file: string;
  readonly relativeFile: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly stream: StreamInfo;
}

export interface StatedCommand {
  /** 在构建记录 JSON 里的位置，便于回查。 */
  readonly jsonPath: string;
  readonly command: readonly string[];
}

export interface ColorConsistency {
  readonly consistent: boolean;
  readonly declared: { readonly matrix: string; readonly range: string; readonly primaries: string; readonly transfer: string } | null;
  readonly differences: readonly string[];
}

export interface ReferenceBlock {
  readonly sourceVideo: { readonly path: string; readonly sha256: string; readonly width: number; readonly height: number; readonly matchesOriginalArmSha: boolean };
  readonly manifest: { readonly file: string; readonly sha256: string } | null;
  readonly buildReport: {
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly statedCommands: readonly StatedCommand[];
    readonly filters: Readonly<Record<string, string>>;
  } | null;
  readonly actual: Readonly<Record<string, StreamActual>>;
  readonly colorConsistency: ColorConsistency;
  /** 评测自身的解码/probe 命令（同一条命令既跑也记）。 */
  readonly evaluationCommands: { readonly probe: readonly string[]; readonly decodeRgba: readonly string[]; readonly decodePlanes: readonly string[] };
  readonly ffmpeg: string;
  readonly ffprobe: string;
  /** WebM/VP9 的 alpha 不在基础流的 pix_fmt 里，读报告的人必须知道这一点。 */
  readonly alphaChannelNote: string;
  /**
   * 素材取自哪个提交：优先 SOURCE.json 里记的 sourceCommit（只读副本自己声明来源），
   * 其次 PET_NEXT_IDLE_ROI_ARMS_COMMIT（直接指向别人提交目录时用）。都没有就记 null，不猜。
   */
  readonly armsCommit: string | null;
  readonly armsProvenance: { readonly file: string; readonly sourceCommit: string | null; readonly extractCommand: string | null } | null;
  readonly gaps: readonly string[];
}

export interface GitState {
  readonly commit: string | null;
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly dirtyPaths: readonly string[];
  readonly error: string | null;
}

function run(bin: string, args: readonly string[], cwd: string): string | null {
  try {
    const result = execFileSync(bin, args as string[], { cwd, encoding: 'utf8', timeout: 20_000 });
    return result;
  } catch {
    return null;
  }
}

/** 版本行（`ffmpeg version ...` 第一行），缺失记 missing。 */
export function toolVersion(bin: string): string {
  const output = run(bin, ['-version'], petRoot());
  if (output === null) return 'missing';
  return (output.split('\n')[0] ?? '').trim();
}

/** 仓库状态：commit + 是否有未提交改动。评测代码落在哪一版，报告里必须写死。 */
export function gitState(): GitState {
  const root = petRoot();
  const head = run('git', ['rev-parse', 'HEAD'], root);
  if (head === null) return { commit: null, branch: null, dirty: false, dirtyPaths: [], error: '不是 git 仓库或 git 不可用' };
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const status = run('git', ['status', '--porcelain'], root) ?? '';
  const dirtyPaths = status
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\S+\s+/, ''))
    // 只关心**代码**是否与 HEAD 一致：out/ 下的报告与 PNG 是本次运行的产物，
    // 它们被写出来是正常工作，不能因此把「评测代码有未提交改动」也标成 true。
    .filter((entry) => !entry.startsWith('pet-next/tests/idle-roi/out/'));
  return { commit: head.trim(), branch: branch === null ? null : branch.trim(), dirty: dirtyPaths.length > 0, dirtyPaths, error: null };
}

/** 评测代码指纹：把装置源码逐个 sha256 再整体 sha256，未提交时也能钉死是哪一版代码跑出来的。 */
export function harnessFingerprint(): { sha256: string; files: ReadonlyArray<{ path: string; sha256: string; bytes: number }> } {
  const bases = [path.join(petRoot(), 'tests', 'idle-roi')];
  const collected: Array<{ path: string; sha256: string; bytes: number }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'out' || entry.name === 'fixtures') continue;
        walk(full);
        continue;
      }
      const isHarness = entry.name.endsWith('.ts') || entry.name.endsWith('.mjs');
      if (!isHarness) continue;
      collected.push({ path: path.relative(petRoot(), full), sha256: sha256File(full), bytes: statSync(full).size });
    }
  };
  for (const base of bases) if (existsSync(base)) walk(base);
  collected.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash('sha256');
  for (const file of collected) digest.update(`${file.path} ${file.sha256}\n`);
  return { sha256: digest.digest('hex'), files: collected };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
}

/** 从任意形状的构建记录里挖出所有 ffmpeg/ffprobe 命令行，保留 JSON 路径。 */
export function collectStatedCommands(raw: unknown): StatedCommand[] {
  const found: StatedCommand[] = [];
  const walk = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      if (isStringArray(node) && (node[0] === 'ffmpeg' || node[0] === 'ffprobe')) {
        found.push({ jsonPath: pointer.length === 0 ? '/' : pointer, command: node });
        return;
      }
      node.forEach((item, index) => walk(item, `${pointer}/${index}`));
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) walk(value, `${pointer}/${key}`);
    }
  };
  walk(raw, '');
  return found;
}

/** 构建记录里声明的滤镜串（`filters` / `filter` / `vf` 都认）。 */
export function collectFilters(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${pointer}/${index}`));
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const next = `${pointer}/${key}`;
        if (typeof value === 'string' && /filter|(^|\/)vf$/i.test(key)) out[next] = value;
        else walk(value, next);
      }
    }
  };
  walk(raw, '');
  return out;
}

export interface BuildReferenceInput {
  readonly armsDir: string;
  readonly arms: Arms;
  /** 报告里称呼各臂用的名字（S/C3 这类）。 */
  readonly labels: Readonly<Record<ArmKey, string>>;
  /** 显式声明的素材提交（只有调用方知道这目录是"谁的哪个提交"时才传）。 */
  readonly armsCommit?: string | null;
}

/** 组装一份引用块。 */
export async function buildReference(input: BuildReferenceInput): Promise<ReferenceBlock> {
  const { armsDir, arms, labels } = input;
  const gaps: string[] = [];
  const actual: Record<string, StreamActual> = {};
  for (const key of ['O', 'F', 'C'] as const) {
    const arm = arms[key];
    const stream = await probeStream(arm.file);
    actual[labels[key] ?? key] = {
      key: labels[key] ?? key,
      file: arm.file,
      relativeFile: path.relative(petRoot(), arm.file),
      sha256: arm.sha256,
      bytes: statSync(arm.file).size,
      stream,
    };
  }
  const manifestFile = path.join(armsDir, 'manifest.json');
  const manifestRef = existsSync(manifestFile) ? { file: path.relative(petRoot(), manifestFile), sha256: sha256File(manifestFile) } : null;
  if (manifestRef === null) gaps.push(`缺 ${path.relative(petRoot(), manifestFile)}：素材声明（crop/colorTags/PTS）无法引用`);

  const buildFile = path.join(armsDir, 'build-report.json');
  let buildReport: ReferenceBlock['buildReport'] = null;
  if (existsSync(buildFile)) {
    const raw = JSON.parse(readFileSync(buildFile, 'utf8')) as unknown;
    const statedCommands = collectStatedCommands(raw);
    buildReport = {
      file: path.relative(petRoot(), buildFile),
      sha256: sha256File(buildFile),
      bytes: statSync(buildFile).size,
      statedCommands,
      filters: collectFilters(raw),
    };
    if (statedCommands.length === 0) gaps.push(`${path.relative(petRoot(), buildFile)} 里没有 ffmpeg/ffprobe 命令行：编码命令无法从产物重建`);
  } else {
    gaps.push(`缺 ${path.relative(petRoot(), buildFile)}：本轮编码命令无法从产物反查（只有 manifest 声明）`);
  }

  const declared = arms.manifest?.colorTags ?? null;
  const differences: string[] = [];
  if (declared !== null) {
    for (const [label, entry] of Object.entries(actual)) {
      const stream = entry.stream;
      if (stream.color.matrix !== declared.matrix) differences.push(`${label} 实际 matrix=${String(stream.color.matrix)} != manifest ${declared.matrix}`);
      if (stream.color.range !== declared.range) differences.push(`${label} 实际 range=${String(stream.color.range)} != manifest ${declared.range}`);
      if (stream.color.primaries !== declared.primaries && declared.primaries !== 'unknown') {
        differences.push(`${label} 实际 primaries=${String(stream.color.primaries)} != manifest ${declared.primaries}`);
      }
      if (stream.color.transfer !== declared.transfer && declared.transfer !== 'unknown') {
        differences.push(`${label} 实际 transfer=${String(stream.color.transfer)} != manifest ${declared.transfer}`);
      }
    }
    if (declared.matrix !== arms.O.stream.color.matrix) differences.push(`manifest.matrix=${declared.matrix} 与原片实际 matrix=${String(arms.O.stream.color.matrix)} 不一致`);
    if (declared.range !== arms.O.stream.color.range) differences.push(`manifest.range=${declared.range} 与原片实际 range=${String(arms.O.stream.color.range)} 不一致`);
  } else {
    differences.push('没有可用 manifest：色彩标签只能报实测值，不能报声明值');
  }

  const sourceJsonFile = path.join(armsDir, 'SOURCE.json');
  let provenance: ReferenceBlock['armsProvenance'] = null;
  let provenanceCommit: string | null = null;
  if (existsSync(sourceJsonFile)) {
    const raw = JSON.parse(readFileSync(sourceJsonFile, 'utf8')) as { sourceCommit?: unknown; extractCommand?: unknown };
    provenanceCommit = typeof raw.sourceCommit === 'string' ? raw.sourceCommit : null;
    provenance = {
      file: path.relative(petRoot(), sourceJsonFile),
      sourceCommit: provenanceCommit,
      extractCommand: typeof raw.extractCommand === 'string' ? raw.extractCommand : null,
    };
  }

  const oActualFirst = Object.entries(actual)[0];
  const sourceFile = path.join(petRoot(), 'assets', 'idle.webm');
  const sourceSha = existsSync(sourceFile) ? sha256File(sourceFile) : '';
  const sourceProbe = existsSync(sourceFile) ? await probeStream(sourceFile) : null;
  if (sourceProbe === null) gaps.push('缺 assets/idle.webm：原片 sha 无法与本仓库比对');
  else if (sourceSha !== arms.O.sha256) differences.push(`本仓库 assets/idle.webm sha=${sourceSha} 与 O 臂 sha=${arms.O.sha256} 不同：O 不是当前工作区的原片`);
  return {
    sourceVideo: {
      path: 'assets/idle.webm',
      sha256: sourceSha,
      width: sourceProbe?.width ?? 0,
      height: sourceProbe?.height ?? 0,
      matchesOriginalArmSha: sourceSha !== '' && arms.O.sha256 === sourceSha,
    },
    manifest: manifestRef,
    buildReport,
    armsProvenance: provenance,
    actual,
    colorConsistency: { consistent: differences.length === 0, declared, differences },
    evaluationCommands: {
      probe: probeStreamCommand(oActualFirst?.[1].file ?? path.join(armsDir, 'O.webm')),
      decodeRgba: decodeRgbaCommand('<arm file>', '<workdir>/<label>.rgba'),
      decodePlanes: decodePlanesCommand('<arm file>', '<workdir>/<label>.yuva420p'),
    },
    ffmpeg: toolVersion('ffmpeg'),
    ffprobe: toolVersion('ffprobe'),
    armsCommit: input.armsCommit ?? provenanceCommit ?? null,
    alphaChannelNote:
      'WebM/VP9 的 alpha 存放在独立 BlockAdditional 中：ffprobe 对带 alpha 的文件仍报基础流 pix_fmt=yuv420p，' +
      '由 tag alpha_mode=1 声明；只有显式 -c:v libvpx-vp9 解码才会得到 alpha 平面（本装置解码命令已显式指定）。' +
      '所以「pix_fmt 不是 yuva420p」不能推出「没有 alpha」。',
    gaps,
  };
}
