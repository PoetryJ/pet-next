/**
 * 未来模型实验的 dry-run 执行器。
 *
 * 这一版**没有 live 传输**：不 import 任何网络模块，不读 API key，不探测模型地址。
 * provider 只能是注入的 FakeProvider（内存函数）。因此本文只能产出「调用清单与预算占用」，
 * 不能产出任何模型效果数字。
 *
 * @module pet-next/experiments/memory-consistency/future-run/runner
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = join(HERE, 'manifest.json');

/** 调用种类。判分/读取/检索/写入/整理分开计，不能混成一个数。 */
export type CallKind = 'read' | 'retrieve' | 'memory-write' | 'consolidate' | 'score';

/** 未来 manifest 的结构。 */
export interface FutureManifest {
  readonly schemaVersion: string;
  readonly frozen: {
    readonly samples: number;
    readonly characterBudgets: {
      readonly contextUtf16Units: number;
      readonly responseUtf16Units: number;
      readonly noteUtf16Units: number;
    };
    /** 每臂允许预留的字符上限（不是 token，也不报价）。 */
    readonly totalUtf16BudgetPerArm: number;
  };
  readonly arms: readonly {
    readonly id: string;
    readonly evidenceConstraint: boolean;
    readonly backgroundConsolidation: boolean;
    readonly role: string;
  }[];
  readonly callsPerSample: {
    readonly read: number;
    readonly retrieve: number;
    readonly memoryWrite: number;
    readonly consolidate: { readonly whenBackground: number; readonly otherwise: number };
    readonly score: number;
  };
  readonly reservationPolicy: {
    readonly reserveBeforeCall: boolean;
    readonly implicitRetries: number;
    readonly failureCountsAsAttempt: boolean;
    readonly overBudgetExitCode: number;
  };
}

/** 预算占用记录。 */
export interface Reservation {
  readonly armId: string;
  readonly sampleIndex: number;
  readonly kind: CallKind;
  readonly reservedUtf16: number;
  readonly attempts: number;
  readonly outcome: 'ok' | 'failed' | 'skipped';
}

/** 计划执行结果。 */
export interface DryRunResult {
  readonly exitCode: number;
  readonly arms: number;
  readonly samples: number;
  readonly calls: number;
  readonly callsByKind: Readonly<Record<CallKind, number>>;
  readonly reservedUtf16: number;
  readonly budgetUtf16: number;
  readonly attempts: number;
  readonly implicitRetries: number;
  readonly failures: number;
  readonly reservations: readonly Reservation[];
  readonly notes: readonly string[];
}

/** 注入的假 provider。只有它能让 dry-run 产生「回答」。 */
export type FakeProvider = (input: { readonly armId: string; readonly sampleIndex: number }) => { readonly text: string } | { readonly error: string };

/** 预算上限来自 manifest 的每臂上限，不按计划结果反推。 */
function armBudget(manifest: FutureManifest): number {
  return manifest.frozen.totalUtf16BudgetPerArm * manifest.arms.length;
}

/**
 * 跑计划。overBudgetUtf16 用来模拟「预算不足」的自检；正常路径应为 0。
 * provider 失败只计一次 attempt，不重试。
 */
export function dryRun(
  manifest: FutureManifest,
  provider: FakeProvider,
  options: { readonly overBudgetUtf16?: number } = {},
): DryRunResult {
  const reservations: Reservation[] = [];
  const callsByKind: Record<CallKind, number> = { read: 0, retrieve: 0, 'memory-write': 0, consolidate: 0, score: 0 };
  const budget = armBudget(manifest) + (options.overBudgetUtf16 ?? 0);
  let reserved = 0;
  let failures = 0;

  const reserve = (armId: string, sampleIndex: number, kind: CallKind, amount: number): boolean => {
    if (reserved + amount > budget) return false;
    reserved += amount;
    callsByKind[kind] += 1;
    reservations.push({ armId, sampleIndex, kind, reservedUtf16: amount, attempts: 1, outcome: 'ok' });
    return true;
  };

  for (const arm of manifest.arms) {
    const consolidateCalls = arm.backgroundConsolidation ? manifest.callsPerSample.consolidate.whenBackground : manifest.callsPerSample.consolidate.otherwise;
    for (let sample = 0; sample < manifest.frozen.samples; sample += 1) {
      if (!reserve(arm.id, sample, 'read', 0)) return overBudget(reservations, callsByKind, reserved, budget, failures, manifest.arms.length, manifest.frozen.samples);
      if (!reserve(arm.id, sample, 'retrieve', manifest.frozen.characterBudgets.contextUtf16Units)) {
        return overBudget(reservations, callsByKind, reserved, budget, failures, manifest.arms.length, manifest.frozen.samples);
      }
      const answer = provider({ armId: arm.id, sampleIndex: sample });
      if ('error' in answer) {
        failures += 1;
        reservations.push({
          armId: arm.id,
          sampleIndex: sample,
          kind: 'memory-write',
          reservedUtf16: 0,
          attempts: 0,
          outcome: 'failed',
        });
        continue;
      }
      if (!reserve(arm.id, sample, 'memory-write', manifest.frozen.characterBudgets.noteUtf16Units)) {
        return overBudget(reservations, callsByKind, reserved, budget, failures, manifest.arms.length, manifest.frozen.samples);
      }
      for (let i = 0; i < consolidateCalls; i += 1) {
        if (!reserve(arm.id, sample, 'consolidate', manifest.frozen.characterBudgets.noteUtf16Units)) {
          return overBudget(reservations, callsByKind, reserved, budget, failures, manifest.arms.length, manifest.frozen.samples);
        }
      }
      if (!reserve(arm.id, sample, 'score', manifest.frozen.characterBudgets.responseUtf16Units)) {
        return overBudget(reservations, callsByKind, reserved, budget, failures, manifest.arms.length, manifest.frozen.samples);
      }
    }
  }

  return {
    exitCode: 0,
    arms: manifest.arms.length,
    samples: manifest.frozen.samples,
    calls: reservations.length,
    callsByKind,
    reservedUtf16: reserved,
    budgetUtf16: budget,
    attempts: reservations.reduce((sum, item) => sum + item.attempts, 0),
    implicitRetries: manifest.reservationPolicy.implicitRetries,
    failures,
    reservations,
    notes: [
      'dry-run 只算调用与预算；没有任何真实模型请求。',
      '字符预算不是 token 预算，也没有报价。',
    ],
  };
}

function overBudget(
  reservations: Reservation[],
  callsByKind: Record<CallKind, number>,
  reserved: number,
  budget: number,
  failures: number,
  arms: number,
  samples: number,
): DryRunResult {
  return {
    exitCode: 3,
    arms,
    samples,
    calls: reservations.length,
    callsByKind,
    reservedUtf16: reserved,
    budgetUtf16: budget,
    attempts: reservations.reduce((sum, item) => sum + item.attempts, 0),
    implicitRetries: 0,
    failures,
    reservations,
    notes: ['预算不足：在预留阶段就停止，未发起任何后续调用。'],
  };
}

/** 读取冻结 manifest。 */
export function loadManifest(path = MANIFEST_PATH): FutureManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as FutureManifest;
}

/** 默认假 provider：确定性文本，不访问任何外部服务。 */
export const cannedProvider: FakeProvider = (input) => ({ text: `arm=${input.armId} sample=${input.sampleIndex} 的假回答` });

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const manifest = loadManifest();
  const result = dryRun(manifest, cannedProvider);
  process.stdout.write(`${JSON.stringify({ exitCode: result.exitCode, calls: result.calls, reservedUtf16: result.reservedUtf16, budgetUtf16: result.budgetUtf16 }, null, 2)}\n`);
  process.exit(result.exitCode);
}
