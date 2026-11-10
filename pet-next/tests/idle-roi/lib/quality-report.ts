/**
 * 报告组装：两个口径分开、三类分列、结论文字由结构化数据生成。
 *
 * 上一版报告的三处问题，这个文件逐条堵住：
 * 1. 把「自往返几何 2/1」当成「F–C 0/0」——现在每个数字都带 `comparison` 与 `scope` 标签，
 *    `worstAcrossFramesAndPlates` 与 `meanOverAllSamples` 是两个字段，永远不合并；
 * 2. `attribution.verdict` / `cropErrorAgainstF` 是写死的中文模板（"v1/crf12""都不过"），
 *    现在只由实测字段拼出来，实测变了文字就跟着变；
 * 3. 1.218 被当成全片平均——现在它只能出现在 `worstAcrossFramesAndPlates` 里，
 *    平均只能出现在 `meanOverAllSamples` 里，字段名不同，机器可查。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { GATE_THRESHOLDS, type GateResult } from './gates.ts';
import type { ComparisonMeasurement } from './measure.ts';
import type { GitState } from './reference.ts';
import { VARIANT_DEFINITIONS, findDefinition, type VariantEvaluation } from './variants.ts';

export interface VariantVerdict {
  readonly category: string;
  readonly label: string;
  readonly status: 'passed' | 'failed' | 'not-run';
  readonly pass: boolean;
  readonly failed: readonly string[];
  readonly reasons: readonly string[];
  readonly sha256: { readonly O: string; readonly F: string; readonly C: string } | null;
}

export interface VerdictBlock {
  readonly status: 'passed' | 'failed' | 'not-run';
  readonly pass: boolean;
  /** 这个状态是针对谁的（候选类别），不是"全部历史变体"的合计。 */
  readonly subject: string;
  readonly subjectLabel: string;
  readonly candidates: VariantVerdict | null;
  readonly prerequisites: readonly VariantVerdict[];
  readonly historical: readonly VariantVerdict[];
  /** 候选 + 前置的失败门（限定 id：`类别/门`）。 */
  readonly failed: readonly string[];
  readonly historicalFailed: readonly string[];
  readonly allVariantsPass: boolean;
  readonly decidedBy: string;
  readonly referencePolicy: string;
}

export interface PerformanceBlock {
  readonly allowed: boolean;
  readonly reason: string;
  readonly blockedBy: readonly string[];
}

export interface ComparisonRow {
  readonly category: string;
  readonly categoryLabel: string;
  readonly comparison: string;
  readonly reference: string;
  readonly candidate: string;
  readonly scope: string;
  readonly worstAcrossFramesAndPlates: {
    readonly foregroundMae: number;
    readonly foregroundP99: number;
    readonly foregroundMax: number;
    readonly frame: number;
    readonly plate: string | null;
    readonly edgeMae: number;
    readonly edgeP99: number;
    readonly alphaMax: number;
  };
  readonly meanOverAllSamples: {
    readonly foregroundMae: number;
    readonly foregroundP99: number;
    readonly foregroundMax: number;
    readonly samples: number;
    readonly edgeMae: number;
    readonly alphaMax: number;
  };
  readonly gate: { readonly id: string; readonly kind: string; readonly pass: boolean; readonly criteria: string } | null;
  readonly note: string;
}

export interface ReportInput {
  readonly variants: readonly VariantEvaluation[];
  readonly git: GitState;
  readonly harness: { readonly sha256: string; readonly files: ReadonlyArray<{ path: string; sha256: string; bytes: number }> };
  readonly environment: { readonly ffmpeg: string; readonly ffprobe: string; readonly node: string; readonly platform: string };
  readonly rerun: string;
  readonly keyFrame: { readonly frame: number; readonly pngs: readonly string[]; readonly pngCount: number; readonly category: string } | null;
  readonly roundtrip: { readonly ran: boolean; readonly reason: string; readonly data?: unknown };
}

function variantVerdict(variant: VariantEvaluation): VariantVerdict {
  if (variant.status !== 'evaluated') {
    return {
      category: variant.category,
      label: variant.label,
      status: 'not-run',
      pass: false,
      failed: [],
      reasons: variant.reasons,
      sha256: null,
    };
  }
  return {
    category: variant.category,
    label: variant.label,
    status: variant.localStatus.pass ? 'passed' : 'failed',
    pass: variant.localStatus.pass,
    failed: variant.localStatus.failed,
    reasons: [],
    sha256: variant.arms?.sha256 ?? null,
  };
}

function qualified(category: string, failed: readonly string[]): string[] {
  return failed.map((gate) => `${category}/${gate}`);
}

/** 一句话结论：只由失败列表拼出来，不含任何写死的"不过/都不过"。 */
function verdictSentence(subject: VariantVerdict | null, prerequisites: readonly VariantVerdict[]): string {
  if (subject === null) return '候选类别未定义';
  if (subject.status === 'not-run') return `${subject.label} 未评测：${subject.reasons.join('；') || '三臂未就绪'}`;
  const blocked = prerequisites.filter((item) => item.status !== 'passed');
  const parts: string[] = [];
  parts.push(subject.pass ? `候选 ${subject.label} 全门通过` : `候选 ${subject.label} 未过 ${subject.failed.join(', ')}`);
  if (prerequisites.length > 0) {
    parts.push(
      blocked.length === 0
        ? `前置 ${prerequisites.map((item) => item.label).join('、')} 通过`
        : `前置 ${blocked.map((item) => `${item.label}（未过 ${item.failed.join(', ') || item.status}）`).join('、')}`,
    );
  }
  return parts.join('；');
}

function round(value: number, digits = 4): number {
  return Number(value.toFixed(digits));
}

function toComparisonRow(variant: VariantEvaluation, id: string, measurement: ComparisonMeasurement, gate: GateResult | undefined): ComparisonRow {
  const worst = measurement.worstAcrossFramesAndPlates;
  const mean = measurement.meanOverAllSamples;
  return {
    category: variant.category,
    categoryLabel: variant.label,
    comparison: id,
    reference: measurement.reference,
    candidate: measurement.candidate,
    scope: 'worst = 各帧/各底最差；mean = 48 帧 × 3 底池化；两列口径不同，不得互相替代',
    worstAcrossFramesAndPlates: {
      foregroundMae: round(worst.foregroundMae.mae),
      foregroundP99: worst.foregroundP99.p99,
      foregroundMax: worst.foregroundMax.max,
      frame: worst.foregroundMae.frame,
      plate: worst.foregroundMae.plate,
      edgeMae: round(worst.edgeMae.mae),
      edgeP99: worst.edgeP99.p99,
      alphaMax: worst.alpha.max,
    },
    meanOverAllSamples: {
      foregroundMae: round(mean.foreground.mae),
      foregroundP99: mean.foreground.p99,
      foregroundMax: mean.foreground.max,
      samples: mean.foreground.samples,
      edgeMae: round(mean.edge.mae),
      alphaMax: mean.alpha.max,
    },
    gate: gate === undefined ? null : { id: gate.id, kind: String(variant.gateKinds[gate.id] ?? 'contract'), pass: gate.pass, criteria: gate.criteria },
    note:
      id.startsWith('o-to-')
        ? '以 O 为参照：这是采用候选相对原片的总损失'
        : id.includes('f3-to-c3') || id === 'f-to-c'
          ? '以 F 为参照：只量裁边/还原本身；F 自身相对 O 的偏离见同一类别下的 O→F 行'
          : '自对照',
  };
}

function comparisonRows(variants: readonly VariantEvaluation[]): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  for (const variant of variants) {
    for (const [id, measurement] of Object.entries(variant.measurements)) {
      const gate = variant.gates.find((item) => item.id === id);
      rows.push(toComparisonRow(variant, id, measurement, gate));
    }
  }
  return rows;
}

/** 归因：全部由实测字段生成。 */
function attributionBlock(variants: readonly VariantEvaluation[], rows: readonly ComparisonRow[]): Record<string, unknown> {
  const statements: string[] = [];
  for (const variant of variants) {
    if (variant.status !== 'evaluated') {
      statements.push(`${variant.label}：未评测（${variant.reasons.join('；')}）`);
      continue;
    }
    const failed = variant.gates.filter((gate) => !gate.pass).map((gate) => gate.id);
    statements.push(`${variant.label}：${failed.length === 0 ? '全门通过' : `未过 ${failed.join(', ')}`}`);
    for (const [id, measurement] of Object.entries(variant.measurements)) {
      const worst = measurement.worstAcrossFramesAndPlates;
      const mean = measurement.meanOverAllSamples;
      statements.push(
        `${variant.label} ${id}：最差（帧 ${worst.foregroundMae.frame} / ${String(worst.foregroundMae.plate)}）前景 MAE ${round(worst.foregroundMae.mae, 3)}、P99 ${worst.foregroundP99.p99}；全片池化（${mean.foreground.samples} 样本）前景 MAE ${round(mean.foreground.mae, 3)}、P99 ${mean.foreground.p99}`,
      );
    }
  }

  // 裁边增量：同类别内 O→C 与 O→F 相减，两个口径各减各的，不跨类别。
  const increment: Array<Record<string, unknown>> = [];
  for (const variant of variants) {
    const keys = Object.keys(variant.measurements);
    const ocKey = keys.find((key) => /^o-to-c/.test(key));
    const ofKey = keys.find((key) => /^o-to-f/.test(key));
    if (ocKey === undefined || ofKey === undefined) continue;
    const oc = variant.measurements[ocKey]!;
    const of = variant.measurements[ofKey]!;
    const worstDelta = round(oc.worstAcrossFramesAndPlates.foregroundMae.mae - of.worstAcrossFramesAndPlates.foregroundMae.mae, 4);
    const meanDelta = round(oc.meanOverAllSamples.foreground.mae - of.meanOverAllSamples.foreground.mae, 4);
    increment.push({
      category: variant.category,
      worstDeltaMaeLsb: worstDelta,
      meanDeltaMaeLsb: meanDelta,
      statement: `${variant.label}：最差口径下裁边增量 ${worstDelta} LSB；池化口径下 ${meanDelta} LSB（两个口径分开算，不能拿其中一个当另一个）`,
      caution:
        worstDelta === 0 && meanDelta !== 0
          ? '最差口径相等而池化口径不等：说明最差点落在同一帧/同一底，最大值相等不能证明两臂逐帧相同'
          : null,
    });
    statements.push(String(increment[increment.length - 1]!.statement));
  }

  const selfControl = variants.find((variant) => variant.category === 'yuva-selfcontrol');
  const geometry = selfControl === null || selfControl === undefined ? null : selfControl.planes;

  /**
   * 旧的 `cropErrorAgainstF` 是一句写死的「几何本身为 0，但这批 v1 字节用 crf 12…」，
   * 一半是过期档位、一半是没读实测。现在它由 F–C 门与两口径增量算出来。
   */
  const cropErrorAgainstF = variants
    .filter((variant) => variant.status === 'evaluated')
    .map((variant) => {
      const keys = Object.keys(variant.measurements);
      const fKey = keys.find((key) => key === 'f3-to-c3' || key === 'f-to-c');
      const ocKey = keys.find((key) => /^o-to-c/.test(key));
      const ofKey = keys.find((key) => /^o-to-f/.test(key));
      const f2c = fKey === undefined ? undefined : variant.measurements[fKey];
      const oc = ocKey === undefined ? undefined : variant.measurements[ocKey];
      const of = ofKey === undefined ? undefined : variant.measurements[ofKey];
      const gate = fKey === undefined ? undefined : variant.gates.find((item) => item.id === fKey);
      const worstInc = oc === undefined || of === undefined ? null : round(oc.worstAcrossFramesAndPlates.foregroundMae.mae - of.worstAcrossFramesAndPlates.foregroundMae.mae, 4);
      const meanInc = oc === undefined || of === undefined ? null : round(oc.meanOverAllSamples.foreground.mae - of.meanOverAllSamples.foreground.mae, 4);
      if (f2c === undefined || gate === undefined) {
        return { category: variant.category, available: false, statement: `${variant.label}：没有 F–C 成对测量，裁边误差不成立` };
      }
      const channelMax = f2c.worstAcrossFramesAndPlates.foregroundMax.max;
      const alphaMax = f2c.worstAcrossFramesAndPlates.alpha.max;
      return {
        category: variant.category,
        available: true,
        gate: { id: gate.id, pass: gate.pass, criteria: gate.criteria },
        worstChannelMaxLsb: channelMax,
        worstAlphaMaxLsb: alphaMax,
        cropIncrement: { worstDeltaMaeLsb: worstInc, meanDeltaMaeLsb: meanInc },
        statement: `${variant.label}：${gate.id} 实测每通道最大差 ${channelMax} LSB、alpha 最大差 ${alphaMax}（判据 ≤2/≤2，${gate.pass ? '通过' : '不过'}）；同类别内 O→C 与 O→F 之差（裁边增量）最差口径 ${String(worstInc)} LSB、池化口径 ${String(meanInc)} LSB`,
      };
    });

  return {
    basis: '每条结论都由本文件里的 comparisons/measurements 字段生成，没有写死的档位或"都不过"',
    statements,
    cropIncrement: increment,
    cropErrorAgainstF,
    costOfF: variants
      .filter((variant) => variant.status === 'evaluated')
      .map((variant) => {
        const ofKey = Object.keys(variant.measurements).find((key) => /^o-to-f/.test(key));
        if (ofKey === undefined) {
          return {
            category: variant.category,
            available: false,
            statement: `${variant.label}：没有 F 臂（自对照不造 F），所以「F 的偏离」不适用；它自己的参照就是 O，见 o-to-s 行`,
          };
        }
        const of = variant.measurements[ofKey]!;
        return {
          category: variant.category,
          available: true,
          statement: `F 自身相对 O 的偏离（这是把 F 当唯一参照时会消失的代价）：最差前景 MAE ${round(of.worstAcrossFramesAndPlates.foregroundMae.mae, 3)}、池化前景 MAE ${round(of.meanOverAllSamples.foreground.mae, 3)}`,
          worst: of.worstAcrossFramesAndPlates,
          meanOverAllSamples: of.meanOverAllSamples,
        };
      }),
    selfControlPlanes: geometry,
    referencePolicy:
      'O 参照（O→候选）判总损失，F 参照（F→候选）判裁边增量；两条门各自都要过，不用 F 参照替代 O 参照，也不把 F 的偏离从报告里拿掉',
  };
}

export interface AssembledReport {
  readonly report: Record<string, unknown>;
  readonly verdict: VerdictBlock;
  readonly performance: PerformanceBlock;
}

export function assembleReport(input: ReportInput): AssembledReport {
  const candidateDefinition = VARIANT_DEFINITIONS.find((definition) => definition.candidate === true);
  const candidateVariant = candidateDefinition === undefined ? undefined : input.variants.find((variant) => variant.category === candidateDefinition.category);
  const candidate = candidateVariant === undefined ? null : variantVerdict(candidateVariant);
  const prereqCategories = VARIANT_DEFINITIONS.filter((definition) => definition.prerequisiteOf === (candidateDefinition?.category ?? '')).map(
    (definition) => definition.category,
  );
  const prerequisites = input.variants.filter((variant) => prereqCategories.includes(variant.category)).map(variantVerdict);
  const historical = input.variants.filter((variant) => !variant.candidate && !prereqCategories.includes(variant.category)).map(variantVerdict);
  const failed = [...(candidate === null ? [] : qualified(candidate.category, candidate.failed)), ...prerequisites.flatMap((item) => qualified(item.category, item.failed))];
  const historicalFailed = historical.flatMap((item) => qualified(item.category, item.failed));
  const blockPrereqs = prerequisites.filter((item) => item.status !== 'passed');
  const status: VerdictBlock['status'] =
    candidate === null || candidate.status === 'not-run'
      ? 'not-run'
      : candidate.pass && blockPrereqs.length === 0
        ? 'passed'
        : 'failed';
  const verdict: VerdictBlock = {
    status,
    pass: status === 'passed',
    subject: candidateDefinition?.category ?? 'unknown',
    subjectLabel: candidateDefinition?.label ?? 'unknown',
    candidates: candidate,
    prerequisites,
    historical,
    failed,
    historicalFailed,
    allVariantsPass: input.variants.every((variant) => variant.status === 'evaluated' && variant.localStatus.pass),
    decidedBy: verdictSentence(candidate, prerequisites),
    referencePolicy: '候选必须同时过 O 参照门与 F 参照门；O→F 的代价单独报，不作为放宽 O 参照的理由',
  };
  const blockedBy = [
    ...(candidate === null || candidate.status === 'not-run' ? [`${candidateDefinition?.category ?? '候选'} 未评测`] : qualified(candidate.category, candidate.failed)),
    ...blockPrereqs.flatMap((item) => (item.status === 'not-run' ? [`${item.category} 未评测`] : qualified(item.category, item.failed))),
  ];
  const performance: PerformanceBlock = {
    allowed: status === 'passed',
    reason:
      status === 'passed'
        ? '候选与前置全门通过：可以进入条件性性能测量（仍不自动转正）'
        : `禁止进入性能：${blockedBy.length === 0 ? '画质门未通过' : blockedBy.join(', ')}`,
    blockedBy,
  };

  const rows = comparisonRows(input.variants);
  const report: Record<string, unknown> = {
    schemaVersion: 2,
    kind: 'idle-roi-quality',
    status: verdict.status,
    generatedAt: new Date().toISOString(),
    subject: verdict.subject,
    units: 'LSB (1 LSB = 1/255 of full scale)；PTS 单位 ms',
    thresholds: GATE_THRESHOLDS,
    evaluationCode: {
      commit: input.git.commit,
      branch: input.git.branch,
      dirty: input.git.dirty,
      dirtyPaths: input.git.dirtyPaths,
      harnessSha256: input.harness.sha256,
      files: input.harness.files,
      note: 'commit 是跑评测时的 HEAD；harnessSha256 是装置源码内容指纹，两者一起才能钉死"哪一版代码"',
    },
    verdict,
    performance,
    variants: input.variants.map((variant) => ({
      category: variant.category,
      label: variant.label,
      role: variant.role,
      candidate: variant.candidate,
      status: variant.status,
      reasons: variant.reasons,
      armsDir: variant.armsDir === null ? null : path.relative(process.cwd(), variant.armsDir),
      files: variant.files,
      labels: variant.labels,
      arms: variant.arms,
      gateKinds: variant.gateKinds,
      gates: variant.gates,
      measurements: variant.measurements,
      planes: variant.planes,
      selfControl: variant.selfControl,
      reference: variant.reference,
      cost: variant.cost,
      localStatus: variant.localStatus,
    })),
    /** 三类分列表：一行一个 (类别, 比较)，最差与平均各占一列。 */
    comparisons: rows,
    attribution: attributionBlock(input.variants, rows),
    roundtrip: input.roundtrip,
    environment: input.environment,
    keyFrame: input.keyFrame,
    rerun: input.rerun,
  };
  return { report, verdict, performance };
}

export function writeReport(file: string, report: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}

/** 给测试与 status 脚本共用的「每门 pass/fail + 数值」摘要。 */
export function gateSummary(variant: VariantEvaluation): Array<{ id: string; kind: string; pass: boolean; keyNumbers: Record<string, unknown> }> {
  return variant.gates.map((gate) => {
    const worst = gate.metrics.worstAcrossFramesAndPlates as
      | {
          foregroundMae?: { mae: number; frame: number; plate: string | null };
          foregroundP99?: { p99: number };
          edgeMae?: { mae: number; frame: number; plate: string | null };
          alpha?: { max: number };
          wholeFrameMax?: { max: number };
        }
      | undefined;
    const mean = gate.metrics.meanOverAllSamples as { foreground?: { mae: number; p99: number }; alpha?: { max: number } } | undefined;
    const maxOverPlanes = gate.metrics.maxOverPlanes as number | undefined;
    const perArm = gate.metrics.perArm as Record<string, { outsideOpaque: number; insideOpaque: number }> | undefined;
    const centroidDelta = gate.metrics.centroidDelta as number | undefined;
    const perFrameMaxDelta = gate.metrics.perFrameMaxDelta as number | undefined;
    const perArmTimeline = gate.metrics.perArm as Record<string, { maxPtsDeltaMs: number; durationDeltaMs: number }> | undefined;
    const keyNumbers: Record<string, unknown> =
      perArm !== undefined
        ? {
            outsideOpaque: Object.fromEntries(Object.entries(perArm).map(([key, value]) => [key, value.outsideOpaque])),
            insideOpaque: Object.fromEntries(Object.entries(perArm).map(([key, value]) => [key, value.insideOpaque])),
          }
        : perArmTimeline !== undefined
          ? {
              maxPtsDeltaMs: Object.fromEntries(Object.entries(perArmTimeline).map(([key, value]) => [key, value.maxPtsDeltaMs])),
              durationDeltaMs: Object.fromEntries(Object.entries(perArmTimeline).map(([key, value]) => [key, value.durationDeltaMs])),
            }
          : centroidDelta !== undefined
            ? { centroidDeltaPx: round(centroidDelta, 4), perFrameBboxMaxDeltaPx: perFrameMaxDelta ?? null }
            : {
                worstForegroundMae: worst?.foregroundMae === undefined ? (gate.metrics.worstCompositeMax ?? null) : round(worst.foregroundMae.mae, 4),
                worstForegroundP99: worst?.foregroundP99?.p99 ?? null,
                worstEdgeMae: worst?.edgeMae === undefined ? null : round(worst.edgeMae.mae, 4),
                worstAlphaMax: worst?.alpha?.max ?? gate.metrics.worstAlphaMax ?? null,
                worstWholeFrameMax: worst?.wholeFrameMax?.max ?? null,
                maxOverPlanes: maxOverPlanes ?? null,
                meanForegroundMae: mean?.foreground === undefined ? null : round(mean.foreground.mae, 4),
                meanForegroundP99: mean?.foreground?.p99 ?? null,
              };
    return { id: gate.id, kind: String(variant.gateKinds[gate.id] ?? 'contract'), pass: gate.pass, keyNumbers };
  });
}

export { findDefinition };
