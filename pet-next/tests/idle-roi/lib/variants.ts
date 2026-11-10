/**
 * 三类候选的解析与评测。三类**必须分列**，不许混写成一个「下限」：
 *
 * 1. `v2-rgba`：`experiments/idle-roi/out-v2`，旧 RGBA 路径（YUV→RGB→lut→YUV）的候选字节。
 *    历史结论保留，但不作为本轮转正依据。
 * 2. `yuva-selfcontrol`：`out-v3-yuva` 里的原生 YUVA 直通自对照（不解 RGB、不裁边、不做阈值）。
 *    它回答「这条编码链本身动不动像素」，不是候选，也不代表 ROI 收益。
 * 3. `f3c3`：`out-v3-yuva` 里的 F3/C3，本轮真正要判的候选。
 *
 * 每类各一套门、各一套测量。跨类别只允许比较结论，不允许把某一类的数字挪去当另一类的证据。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadNamedArms, petRoot, type ArmKey, type Arms, type Manifest } from './arms.ts';
import {
  coverageGate,
  fToCGate,
  layoutGate,
  ocGate,
  ocGateAgainst,
  relabelGate,
  timelineGate,
  type GateResult,
} from './gates.ts';
import { measureComparison, type ComparisonMeasurement } from './measure.ts';
import { runMediaTool } from './tool.ts';
import { sha256File } from './arms.ts';
import { measurePlaneIdentity, type PlaneIdentityReport } from './planes.ts';
import { buildReference, type ReferenceBlock } from './reference.ts';

export type VariantCategory = 'v2-rgba' | 'yuva-selfcontrol' | 'f3c3';

/** 门的性质：契约阈值门 vs 「直通就是全等」的定义门。 */
export type GateKind = 'contract' | 'exactness';

export interface VariantDefinition {
  readonly category: VariantCategory;
  readonly label: string;
  readonly role: string;
  /** 显式目录覆盖用的环境变量。 */
  readonly envDir: string;
  /** 自对照文件覆盖用的环境变量（指向单个 webm，O.webm 必须同目录）。 */
  readonly envFile?: string;
  readonly defaultDirs: readonly string[];
  readonly fileCandidates: { readonly F: readonly string[]; readonly C: readonly string[] };
  readonly verifyCandidateSha: boolean;
  /** 是否作为本轮转正候选（决定 verdict.status 针对谁）。 */
  readonly candidate: boolean;
  /** 候选的前置类别。 */
  readonly prerequisiteOf?: VariantCategory;
}

export const VARIANT_DEFINITIONS: readonly VariantDefinition[] = [
  {
    category: 'v2-rgba',
    label: '原 v2（RGBA 路径）',
    role: '旧候选字节：alpha 阈值 + YUV→RGBA→lut→YUVA 重编码；保留作历史对照，不作为本轮转正依据',
    envDir: 'PET_NEXT_IDLE_ROI_ARMS_V2',
    defaultDirs: ['experiments/idle-roi/out-v2', 'tests/idle-roi/fixtures'],
    fileCandidates: { F: ['F.webm'], C: ['C.webm'] },
    verifyCandidateSha: true,
    candidate: false,
  },
  {
    category: 'yuva-selfcontrol',
    label: '原生 YUVA 直通自对照',
    role: '不解 RGB、不裁边、不做 alpha 阈值：只回答「这条编码链本身动不动 Y/U/V/A 与解码 RGB」',
    envDir: 'PET_NEXT_IDLE_ROI_ARMS_SELFCONTROL',
    envFile: 'PET_NEXT_IDLE_ROI_SELFCONTROL_FILE',
    defaultDirs: ['experiments/idle-roi/out-v3-yuva', 'tests/idle-roi/fixtures-v3'],
    fileCandidates: {
      F: ['S.webm', 'selfcontrol.webm', 'passthrough.webm', 'yuva-pass.webm', 'S-passthrough.webm', 'O-pass.webm'],
      C: ['S.webm', 'selfcontrol.webm', 'passthrough.webm', 'yuva-pass.webm', 'S-passthrough.webm', 'O-pass.webm'],
    },
    verifyCandidateSha: false,
    candidate: false,
    prerequisiteOf: 'f3c3',
  },
  {
    category: 'f3c3',
    label: 'F3/C3（原生 YUVA 候选）',
    role: '原生 YUVA 链上的全画布 F3 与 ROI C3；本轮唯一转正候选',
    envDir: 'PET_NEXT_IDLE_ROI_ARMS_F3C3',
    defaultDirs: ['experiments/idle-roi/out-v3-yuva', 'tests/idle-roi/fixtures-v3'],
    fileCandidates: { F: ['F3.webm', 'F.webm'], C: ['C3.webm', 'C.webm'] },
    verifyCandidateSha: true,
    candidate: true,
  },
];

export interface ResolvedVariant {
  readonly definition: VariantDefinition;
  readonly armsDir: string;
  readonly files: { readonly O: string; readonly F: string; readonly C: string };
  readonly labels: Readonly<Record<ArmKey, string>>;
}

export function findDefinition(category: VariantCategory): VariantDefinition {
  const found = VARIANT_DEFINITIONS.find((item) => item.category === category);
  if (!found) throw new Error(`未知类别 ${category}`);
  return found;
}

/** 仓库内给相对路径，仓库外（临时目录）给绝对路径，避免出现 ../../../../ 这种看不清的串。 */
function displayPath(target: string): string {
  const relative = path.relative(petRoot(), target);
  return relative.startsWith('..') ? target : relative;
}

function absolute(candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.join(petRoot(), candidate);
}

function firstExisting(dir: string, names: readonly string[]): string | null {
  for (const name of names) {
    if (existsSync(path.join(dir, name))) return name;
  }
  return null;
}

/**
 * 解析一个类别的目录与文件名。
 *
 * 只有「显式指定」与「本类别候选名单里唯一命中」两种来源，不做目录遍历猜测：
 * v3 目录里同时躺着自对照与 C3，猜错一次就会把两类的数字混成一份。
 */
export function resolveVariant(definition: VariantDefinition): { resolved: ResolvedVariant | null; reasons: string[]; needsReproduction?: boolean } {
  const reasons: string[] = [];
  const overrideFile = definition.envFile === undefined ? undefined : process.env[definition.envFile];
  // 负责人统一用 PET_NEXT_IDLE_ROI_ARMS 指 v3 目录；v2 不吃这个变量（它有自己的历史字节）。
  const genericDir = definition.category === 'v2-rgba' ? undefined : process.env['PET_NEXT_IDLE_ROI_ARMS'];
  const overrideDir = process.env[definition.envDir] ?? genericDir;
  let armsDir: string | null;
  if (overrideFile !== undefined && overrideFile.length > 0) {
    const file = absolute(overrideFile);
    armsDir = path.dirname(file);
  } else if (overrideDir !== undefined && overrideDir.length > 0) {
    armsDir = absolute(overrideDir);
  } else {
    const found = definition.defaultDirs.map(absolute).find((dir) => existsSync(dir));
    armsDir = found ?? null;
  }
  if (armsDir === null) {
    reasons.push(`目录不存在：${definition.defaultDirs.join(' / ')}`);
    return { resolved: null, reasons };
  }
  let fName: string | null;
  let cName: string | null;
  if (overrideFile !== undefined && overrideFile.length > 0) {
    fName = path.basename(absolute(overrideFile));
    cName = fName;
  } else {
    fName = firstExisting(armsDir, definition.fileCandidates.F);
    cName = firstExisting(armsDir, definition.fileCandidates.C);
  }
  for (const required of ['O.webm', 'manifest.json']) {
    if (!existsSync(path.join(armsDir, required))) reasons.push(`${path.relative(petRoot(), armsDir)} 缺 ${required}`);
  }
  if (reasons.length > 0) return { resolved: null, reasons };
  const labels0: Record<ArmKey, string> =
    definition.category === 'yuva-selfcontrol'
      ? { O: 'O', F: 'S', C: 'S' }
      : definition.category === 'f3c3'
        ? { O: 'O', F: 'F3', C: 'C3' }
        : { O: 'O', F: 'F', C: 'C' };
  if (fName === null || cName === null) {
    if (definition.category === 'yuva-selfcontrol') {
      // 自对照文件常常只是自检产物、不随交付物提交；这条路径由构建记录里的命令本地复现。
      return {
        resolved: { definition, armsDir, files: { O: 'O.webm', F: '', C: '' }, labels: labels0 },
        reasons: [],
        needsReproduction: true,
      };
    }
    reasons.push(
      `${path.relative(petRoot(), armsDir)} 下缺候选文件（F 试过 ${definition.fileCandidates.F.join('/')}；C 试过 ${definition.fileCandidates.C.join('/')}）`,
    );
    return { resolved: null, reasons };
  }
  return { resolved: { definition, armsDir, files: { O: 'O.webm', F: fName, C: cName }, labels: labels0 }, reasons };
}

export interface VariantEvaluation {
  readonly category: VariantCategory;
  readonly label: string;
  readonly role: string;
  readonly candidate: boolean;
  readonly status: 'evaluated' | 'not-run';
  readonly reasons: readonly string[];
  readonly armsDir: string | null;
  readonly files: ResolvedVariant['files'] | null;
  readonly labels: Readonly<Record<ArmKey, string>> | null;
  readonly arms: {
    readonly sha256: { readonly O: string; readonly F: string; readonly C: string };
    readonly bytes: { readonly O: number; readonly F: number; readonly C: number };
    readonly frameCount: { readonly O: number; readonly F: number; readonly C: number };
    readonly manifest: Manifest | null;
  } | null;
  readonly reference: ReferenceBlock | null;
  readonly gates: readonly GateResult[];
  readonly gateKinds: Readonly<Record<string, GateKind>>;
  readonly measurements: Readonly<Record<string, ComparisonMeasurement>>;
  readonly planes: PlaneIdentityReport | null;
  /** 自对照文件的来源（提交内文件 / 由构建记录里的命令本地复现）。 */
  readonly selfControl: {
    readonly source: 'committed-file' | 'reproduced-from-build-report' | 'none';
    readonly file: string | null;
    readonly sha256: string | null;
    readonly recordedSha256: string | null;
    readonly shaMatchesRecorded: boolean | null;
    readonly command: readonly string[] | null;
    readonly note: string;
  } | null;
  /** 已加载的三臂（只在进程内用：关键帧 PNG 需要重读原帧；不进 JSON）。 */
  readonly armsObject: Arms | null;
  readonly localStatus: { readonly pass: boolean; readonly failed: readonly string[] };
  readonly cost: {
    readonly bytes: { readonly O: number; readonly F: number; readonly C: number };
    readonly bytesVsSource: { readonly F: number; readonly C: number };
    readonly candidateVsFullCanvas: { readonly deltaBytes: number; readonly ratio: number };
    readonly decodedArea: { readonly cropArea: number; readonly canvasArea: number; readonly retainedRatio: number };
    readonly note: string;
  } | null;
}

function notRun(definition: VariantDefinition, reasons: readonly string[]): VariantEvaluation {
  return {
    category: definition.category,
    label: definition.label,
    role: definition.role,
    candidate: definition.candidate,
    status: 'not-run',
    reasons,
    armsDir: null,
    files: null,
    labels: null,
    arms: null,
    reference: null,
    gates: [],
    gateKinds: {},
    measurements: {},
    planes: null,
    selfControl: null,
    armsObject: null,
    localStatus: { pass: false, failed: [] },
    cost: null,
  };
}

/**
 * 自对照文件解析：优先用已提交文件；没有就按构建记录里的 passthrough 命令**本地复现**。
 *
 * 为什么要复现：B 的 `passthrough.webm` 是自检产物、不落交付物，提交里根本没有这份字节。
 * 「不信声明、只认字节」在这里只有两条路——要么拿不到就报 not-run（等于没法独立核验），
 * 要么用同一份 ffmpeg + 记录里那条完整命令重跑一次，再用重跑出来的字节做平面比较。
 * 后者是可审计的：命令、产物 sha、与 B 记录 sha 是否一致，全部落进报告。
 */
async function resolveSelfControlFile(
  resolved: ResolvedVariant,
  workDir: string,
  needsReproduction: boolean,
): Promise<{
  file: string | null;
  meta: NonNullable<VariantEvaluation['selfControl']>;
}> {
  if (!needsReproduction) {
    const file = path.isAbsolute(resolved.files.C) ? resolved.files.C : path.join(resolved.armsDir, resolved.files.C);
    return {
      file,
      meta: {
        source: 'committed-file',
        file: path.relative(petRoot(), file),
        sha256: sha256File(file),
        recordedSha256: null,
        shaMatchesRecorded: null,
        command: null,
        note: '使用随提交落盘的自对照字节',
      },
    };
  }
  const buildFile = path.join(resolved.armsDir, 'build-report.json');
  if (!existsSync(buildFile)) {
    return {
      file: null,
      meta: {
        source: 'none',
        file: null,
        sha256: null,
        recordedSha256: null,
        shaMatchesRecorded: null,
        command: null,
        note: '既没有自对照文件，也没有 build-report.json：无法复现，判定为 not-run（不接受「B 说全等」作为证据）',
      },
    };
  }
  const raw = JSON.parse(readFileSync(buildFile, 'utf8')) as unknown;
  const commands: Array<{ jsonPath: string; command: readonly string[] }> = [];
  const walk = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      if (node.length > 0 && node.every((item) => typeof item === 'string') && node[0] === 'ffmpeg') {
        commands.push({ jsonPath: pointer, command: node as string[] });
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
  const score = (item: { jsonPath: string; command: readonly string[] }): number => {
    const text = item.command.join(' ');
    if (/\brgba\b/.test(text)) return -100;
    if (/lutyuv|alphaextract|drawtext/.test(text)) return -50;
    let value = 0;
    if (/passthrough/i.test(item.jsonPath) || /passthrough/i.test(text)) value += 100;
    if (/format=yuva420p/.test(text)) value += 20;
    return value;
  };
  const best = commands.map((item) => ({ item, value: score(item) })).sort((left, right) => right.value - left.value)[0];
  if (best === undefined || best.value <= 0) {
    return {
      file: null,
      meta: {
        source: 'none',
        file: null,
        sha256: null,
        recordedSha256: null,
        shaMatchesRecorded: null,
        command: null,
        note: `build-report.json 里没有「不解 RGB 的 yuva420p 直通」命令（挖到 ${commands.length} 条 ffmpeg 命令）：无法复现，判定 not-run`,
      },
    };
  }
  const command = [...best.item.command];
  const inputIndex = command.indexOf('-i');
  const oPath = path.join(resolved.armsDir, 'O.webm');
  if (inputIndex >= 0 && inputIndex + 1 < command.length) command[inputIndex + 1] = oPath;
  const output = path.join(workDir, 'selfcontrol-passthrough.webm');
  command[command.length - 1] = output;
  await runMediaTool(command, 300_000);
  const sha = sha256File(output);
  const recorded = ((): string | null => {
    const node = raw as { selfControl?: { sha256?: unknown } };
    const value = node.selfControl?.sha256;
    return typeof value === 'string' ? value : null;
  })();
  return {
    file: output,
    meta: {
      source: 'reproduced-from-build-report',
      file: output,
      sha256: sha,
      recordedSha256: recorded,
      shaMatchesRecorded: recorded === null ? null : recorded === sha,
      command,
      note: `由 ${displayPath(buildFile)}${best.item.jsonPath} 的命令本地复现（输入换成本目录 O.webm、输出换到临时目录）；B 的 passthrough.webm 未随提交落盘`,
    },
  };
}

/** 自对照的两条定义门：Y/U/V/A 平面全等；解码 RGB（整帧，含透明区）与 alpha 全等。 */
function selfControlGates(measurement: ComparisonMeasurement, planes: PlaneIdentityReport): GateResult[] {
  const planeFailures = planes.identical
    ? []
    : (['Y', 'U', 'V', 'A'] as const)
        .filter((plane) => planes.perPlane[plane].max !== 0)
        .map((plane) => `${plane} 平面全片最大差 ${planes.perPlane[plane].max} LSB（最差帧 ${planes.worst[plane].frame}，差异样本 ${planes.perPlane[plane].differing}）`);
  const planesGate: GateResult = {
    id: 'planes-identity',
    title: 'Y/U/V/A 平面直通全等',
    criteria: '不经 RGB：全 48 帧 Y/U/V/A 四平面逐字节 max 差 = 0（「直通」的定义，不是 §6 阈值）',
    pass: planes.identical,
    failures: planeFailures,
    metrics: { maxOverPlanes: planes.maxOverPlanes, perPlane: planes.perPlane, worstFrame: planes.worst, layout: planes.layout },
  };
  const rgbWorst = measurement.worstAcrossFramesAndPlates.wholeFrameMax;
  const alphaWorst = measurement.worstAcrossFramesAndPlates.alpha;
  const rgbPass = rgbWorst.max === 0 && alphaWorst.max === 0;
  const rgbGate: GateResult = {
    id: 'decoded-rgb-identity',
    title: '解码 RGB 与 alpha 全等',
    criteria: '同解码器解回 RGBA 后整帧（含 alpha<=1 的透明区）逐像素 max 差 = 0，alpha max 差 = 0',
    pass: rgbPass,
    failures: rgbPass
      ? []
      : [
          `整帧 RGB 最大差 ${rgbWorst.max} LSB（帧 ${rgbWorst.frame}，底 ${String(rgbWorst.plate)}）`,
          `alpha 最大差 ${alphaWorst.max} LSB（帧 ${alphaWorst.frame}）`,
        ],
    metrics: {
      worstWholeFrameMax: rgbWorst,
      worstAlpha: alphaWorst,
      worstAcrossFramesAndPlates: measurement.worstAcrossFramesAndPlates,
      meanOverAllSamples: measurement.meanOverAllSamples,
    },
  };
  return [planesGate, rgbGate];
}

/** 评测一个类别：门 + 测量 + 引用 + 代价。任何加载问题都变成 not-run，不猜数据。 */
export async function evaluateVariant(definition: VariantDefinition, workDir: string): Promise<VariantEvaluation> {
  const { resolved, reasons, needsReproduction } = resolveVariant(definition);
  if (resolved === null) return notRun(definition, reasons);
  let files = resolved.files;
  let selfControl: VariantEvaluation['selfControl'] = null;
  if (definition.category === 'yuva-selfcontrol') {
    const sc = await resolveSelfControlFile(resolved, workDir, needsReproduction === true);
    if (sc.file === null) return notRun(definition, [sc.meta.note]);
    selfControl = sc.meta;
    files = { ...files, F: sc.file, C: sc.file };
  }
  const loaded = await loadNamedArms(resolved.armsDir, workDir, files, {
    label: definition.category,
    verifyCandidateSha: definition.verifyCandidateSha,
  });
  if (!loaded.arms) return notRun(definition, loaded.problems);
  const arms = loaded.arms;
  const gates: GateResult[] = [coverageGate(arms), timelineGate(arms), layoutGate(arms)];
  const gateKinds: Record<string, GateKind> = { coverage: 'contract', timeline: 'contract', layout: 'contract' };
  const measurements: Record<string, ComparisonMeasurement> = {};
  let planes: PlaneIdentityReport | null = null;

  if (definition.category === 'yuva-selfcontrol') {
    const oToS = measureComparison(arms, 'O', 'C', 'o-to-s');
    measurements['o-to-s'] = oToS;
    const contract = ocGateAgainst(arms, 'O', 'C', 'o-to-s', 'O–S 三种底合成（契约阈值同口径）', { reference: 'O', candidate: 'S' });
    gates.push(contract);
    gateKinds['o-to-s'] = 'contract';
    planes = await measurePlaneIdentity(arms.O.file, arms.C.file, workDir, 'selfcontrol');
    for (const gate of selfControlGates(oToS, planes)) {
      gates.push(gate);
      gateKinds[gate.id] = 'exactness';
    }
  } else {
    const rawFToC = fToCGate(arms);
    const rawOc = ocGate(arms);
    if (definition.category === 'f3c3') {
      const f3c3 = relabelGate(rawFToC, 'f3-to-c3', 'F3–C3 原画布一致', { reference: 'F3', candidate: 'C3' });
      gates.push(f3c3);
      gateKinds['f3-to-c3'] = 'contract';
      const oToC3 = ocGateAgainst(arms, 'O', 'C', 'o-to-c3', 'O–C3 三种底合成', { reference: 'O', candidate: 'C3' });
      gates.push(oToC3);
      gateKinds['o-to-c3'] = 'contract';
      measurements['f3-to-c3'] = measurementFromGate(f3c3, 'F3', 'C3');
      measurements['o-to-c3'] = measurementFromGate(oToC3, 'O', 'C3');
      measurements['o-to-f3'] = measureComparison(arms, 'O', 'F', 'o-to-f3');
    } else {
      gates.push(rawFToC);
      gateKinds['f-to-c'] = 'contract';
      gates.push(rawOc);
      gateKinds['o-to-c'] = 'contract';
      measurements['f-to-c'] = measurementFromGate(rawFToC, 'F', 'C');
      measurements['o-to-c'] = measurementFromGate(rawOc, 'O', 'C');
      measurements['o-to-f'] = measureComparison(arms, 'O', 'F', 'o-to-f');
    }
  }

  const failed = gates.filter((gate) => !gate.pass).map((gate) => gate.id);
  const labels = resolved.labels;
  const reference = await buildReference({
    armsDir: resolved.armsDir,
    arms,
    labels,
    // 旧 v2 字节的来源由它自己的 fixtures/SOURCE.json 记；B 的提交只对 v3 两类成立。
    armsCommit: definition.category === 'v2-rgba' ? null : (process.env['PET_NEXT_IDLE_ROI_ARMS_COMMIT'] ?? null),
  });
  const bytes = { O: statSync(arms.O.file).size, F: statSync(arms.F.file).size, C: statSync(arms.C.file).size };
  const cropArea = arms.crop.width * arms.crop.height;
  const canvasArea = arms.originalCanvas.width * arms.originalCanvas.height;
  return {
    category: definition.category,
    label: definition.label,
    role: definition.role,
    candidate: definition.candidate,
    status: 'evaluated',
    reasons: [],
    armsDir: resolved.armsDir,
    files,
    labels,
    arms: {
      sha256: { O: arms.O.sha256, F: arms.F.sha256, C: arms.C.sha256 },
      bytes,
      frameCount: { O: arms.O.raw.frameCount, F: arms.F.raw.frameCount, C: arms.C.raw.frameCount },
      manifest: arms.manifest,
    },
    reference,
    gates,
    gateKinds,
    measurements,
    planes,
    selfControl,
    armsObject: arms,
    localStatus: { pass: failed.length === 0, failed },
    cost: {
      bytes,
      bytesVsSource: { F: bytes.F - bytes.O, C: bytes.C - bytes.O },
      candidateVsFullCanvas: { deltaBytes: bytes.C - bytes.F, ratio: Number((bytes.C / bytes.F).toFixed(4)) },
      decodedArea: { cropArea, canvasArea, retainedRatio: Number((cropArea / canvasArea).toFixed(6)) },
      note:
        definition.category === 'yuva-selfcontrol'
          ? '自对照不裁边：C 槽位就是全画布直通文件，这里的体积差不代表 ROI 收益'
          : `ROI 省的是解码像素面积（${((cropArea / canvasArea) * 100).toFixed(1)}%），不是文件体积：C ${bytes.C} 字节 vs F ${bytes.F} 字节（${bytes.C > bytes.F ? '+' : ''}${bytes.C - bytes.F}）`,
    },
  };
}

/**
 * 从门的 metrics 里取回同一份测量。
 *
 * 门必须自己算一遍（不许信任外部传入的"结论"）；报告再算一遍不但慢，还可能因为两处实现漂移
 * 出现两个不同的数，所以直接取门算出的那一份。
 */
function measurementFromGate(gate: GateResult, reference: string, candidate: string): ComparisonMeasurement {
  const worst = gate.metrics.worstAcrossFramesAndPlates as ComparisonMeasurement['worstAcrossFramesAndPlates'] | undefined;
  const mean = gate.metrics.meanOverAllSamples as ComparisonMeasurement['meanOverAllSamples'] | undefined;
  const perFrame = gate.metrics.perFrame as ComparisonMeasurement['perFrame'] | undefined;
  if (!worst || !mean || !perFrame) throw new Error(`门 ${gate.id} 没带 worst/mean/perFrame，报告无法分列两个口径`);
  return {
    id: gate.id,
    reference: reference as ArmKey,
    candidate: candidate as ArmKey,
    restoredFromCrop: gate.metrics.restoredFromCrop === true,
    crop: (gate.metrics.crop as ComparisonMeasurement['crop']) ?? null,
    frames: perFrame.length,
    samplesNote: 'worst = 逐帧逐底取最差；mean = 48 帧 × 3 底全部样本池化（单一直方图）',
    worstAcrossFramesAndPlates: worst,
    meanOverAllSamples: mean,
    perFrame,
  };
}
