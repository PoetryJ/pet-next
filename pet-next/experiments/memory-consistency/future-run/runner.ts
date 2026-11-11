/**
 * 未来模型实验的 dry-run 执行器。
 *
 * 这一版**没有 live 传输**：不 import 任何网络模块，不读 API key，不探测模型地址。
 * provider 只能是注入的 stub（内存函数）。
 *
 * 三个数必须分开，禁止互相顶替（REVIEW F4c）：
 * - plannedOperations：计划里要做多少次操作；
 * - reservations：实际做成了多少次额度预留（每次调用前预留，失败也不退还）；
 * - providerAttempts：真实 stub 调用次数，每次都有 attemptId。
 * 旧实现把预留条目数叫 calls/attempts（528 vs 实际 120），那是把计划当成执行。
 *
 * 配额：每臂独立（manifest.frozen.totalUtf16BudgetPerArm），另有可选全局上限。
 * 超额在「动作发生之前」拒绝，不许借别的臂的余额，也不许静默重试。
 *
 * @module pet-next/experiments/memory-consistency/future-run/runner
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../runner/gate.ts';

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
    /** 可选全局上限；缺省表示只按臂限。 */
    readonly totalUtf16BudgetGlobal?: number;
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

/** 计划中的一次操作（纯数据，不产生副作用）。 */
export interface PlannedOperation {
  readonly armId: string;
  readonly sampleIndex: number;
  readonly kind: CallKind;
  readonly cost: number;
  /** 这一操作是否真的会调用 provider stub。 */
  readonly invokesProvider: boolean;
}

/** 一次额度预留。 */
export interface Reservation {
  readonly armId: string;
  readonly sampleIndex: number;
  readonly kind: CallKind;
  readonly reservedUtf16: number;
}

/** 一次真实 provider 尝试。 */
export interface Attempt {
  readonly attemptId: string;
  readonly armId: string;
  readonly sampleIndex: number;
  readonly outcome: 'ok' | 'failed';
  readonly failure?: string;
}

/** 计划执行结果。 */
export interface DryRunResult {
  readonly exitCode: number;
  readonly arms: number;
  readonly samples: number;
  readonly plannedOperations: number;
  readonly reservations: readonly Reservation[];
  readonly attempts: readonly Attempt[];
  readonly providerAttempts: number;
  readonly failures: number;
  readonly perArmPlanned: Readonly<Record<string, number>>;
  readonly perArmReserved: Readonly<Record<string, number>>;
  readonly globalReserved: number;
  readonly armBudget: number;
  readonly globalBudget: number | null;
  readonly exceededArms: readonly string[];
  readonly exceededGlobal: boolean;
  readonly implicitRetries: number;
  readonly notes: readonly string[];
}

/** 注入的 stub provider。只有它能让 dry-run 产生「回答」。 */
export type FakeProvider = (input: { readonly armId: string; readonly sampleIndex: number }) => { readonly text: string } | { readonly error: string };

/** 按 manifest 生成完整计划。纯函数，可单独核对条数。 */
export function planOperations(manifest: FutureManifest): PlannedOperation[] {
  const budget = manifest.frozen.characterBudgets;
  const plan: PlannedOperation[] = [];
  for (const arm of manifest.arms) {
    const consolidate = arm.backgroundConsolidation
      ? manifest.callsPerSample.consolidate.whenBackground
      : manifest.callsPerSample.consolidate.otherwise;
    for (let sample = 0; sample < manifest.frozen.samples; sample += 1) {
      for (let index = 0; index < manifest.callsPerSample.read; index += 1) {
        plan.push({ armId: arm.id, sampleIndex: sample, kind: 'read', cost: 0, invokesProvider: false });
      }
      for (let index = 0; index < manifest.callsPerSample.retrieve; index += 1) {
        plan.push({
          armId: arm.id,
          sampleIndex: sample,
          kind: 'retrieve',
          cost: budget.contextUtf16Units,
          invokesProvider: true,
        });
      }
      for (let index = 0; index < manifest.callsPerSample.memoryWrite; index += 1) {
        plan.push({ armId: arm.id, sampleIndex: sample, kind: 'memory-write', cost: budget.noteUtf16Units, invokesProvider: false });
      }
      for (let index = 0; index < consolidate; index += 1) {
        plan.push({ armId: arm.id, sampleIndex: sample, kind: 'consolidate', cost: budget.noteUtf16Units, invokesProvider: false });
      }
      for (let index = 0; index < manifest.callsPerSample.score; index += 1) {
        plan.push({ armId: arm.id, sampleIndex: sample, kind: 'score', cost: budget.responseUtf16Units, invokesProvider: false });
      }
    }
  }
  return plan;
}

function emptyResult(manifest: FutureManifest, plan: number): DryRunResult {
  const perArmPlanned: Record<string, number> = {};
  for (const arm of manifest.arms) perArmPlanned[arm.id] = 0;
  return {
    exitCode: 0,
    arms: manifest.arms.length,
    samples: manifest.frozen.samples,
    plannedOperations: plan,
    reservations: [],
    attempts: [],
    providerAttempts: 0,
    failures: 0,
    perArmPlanned,
    perArmReserved: { ...perArmPlanned },
    globalReserved: 0,
    armBudget: manifest.frozen.totalUtf16BudgetPerArm,
    globalBudget: manifest.frozen.totalUtf16BudgetGlobal ?? null,
    exceededArms: [],
    exceededGlobal: false,
    implicitRetries: manifest.reservationPolicy.implicitRetries,
    notes: [],
  };
}

/**
 * 跑计划。stub 失败只计一次 attempt，不重试、不退还额度。
 * exitCode：0 正常；3 预算不足（动作前拒绝）；4 provider 失败。
 */
export function dryRun(manifest: FutureManifest, provider: FakeProvider): DryRunResult {
  const plan = planOperations(manifest);
  const base = emptyResult(manifest, plan.length);
  const perArmPlanned: Record<string, number> = { ...base.perArmPlanned };
  for (const op of plan) perArmPlanned[op.armId] = (perArmPlanned[op.armId] ?? 0) + 1;

  const reservations: Reservation[] = [];
  const attempts: Attempt[] = [];
  const perArmReserved: Record<string, number> = {};
  for (const arm of manifest.arms) perArmReserved[arm.id] = 0;
  const exceededArms = new Set<string>();
  let globalReserved = 0;
  let exceededGlobal = false;
  let failures = 0;
  let attemptSeq = 0;

  for (const op of plan) {
    if (exceededArms.has(op.armId)) continue;
    if (exceededGlobal) continue;

    const armUsed = perArmReserved[op.armId] ?? 0;
    if (armUsed + op.cost > manifest.frozen.totalUtf16BudgetPerArm) {
      // 动作发生前拒绝；不借别臂余额，也不把这一条算成 attempt。
      exceededArms.add(op.armId);
      continue;
    }
    const globalBudget = manifest.frozen.totalUtf16BudgetGlobal;
    if (globalBudget !== undefined && globalReserved + op.cost > globalBudget) {
      exceededGlobal = true;
      continue;
    }

    perArmReserved[op.armId] = armUsed + op.cost;
    globalReserved += op.cost;
    reservations.push({ armId: op.armId, sampleIndex: op.sampleIndex, kind: op.kind, reservedUtf16: op.cost });

    if (!op.invokesProvider) continue;
    attemptSeq += 1;
    const answer = provider({ armId: op.armId, sampleIndex: op.sampleIndex });
    if ('error' in answer) {
      failures += 1;
      attempts.push({
        attemptId: `attempt-${String(attemptSeq).padStart(4, '0')}`,
        armId: op.armId,
        sampleIndex: op.sampleIndex,
        outcome: 'failed',
        failure: answer.error,
      });
      // 失败后不重试、不退额度；该样本余下操作不再执行。
      continue;
    }
    attempts.push({
      attemptId: `attempt-${String(attemptSeq).padStart(4, '0')}`,
      armId: op.armId,
      sampleIndex: op.sampleIndex,
      outcome: 'ok',
    });
  }

  const exitCode = exceededArms.size > 0 || exceededGlobal ? 3 : failures > 0 ? 4 : 0;
  return {
    ...base,
    exitCode,
    reservations,
    attempts,
    providerAttempts: attempts.length,
    failures,
    perArmPlanned: { ...perArmPlanned },
    perArmReserved: { ...perArmReserved },
    globalReserved,
    exceededArms: [...exceededArms].sort(),
    exceededGlobal,
    notes: [
      'dry-run 只算计划、预留与 stub 尝试；没有任何真实模型请求。',
      '字符预算不是 token 预算，也没有报价。',
      exceededArms.size > 0 ? `超额臂在动作前被拒：${[...exceededArms].sort().join(',')}` : '',
    ].filter((item) => item !== ''),
  };
}

/** 读取冻结 manifest。 */
export function loadManifest(path = MANIFEST_PATH): FutureManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as FutureManifest;
}

/** 默认 stub provider：确定性文本，不访问任何外部服务。 */
export const cannedProvider: FakeProvider = (input) => ({ text: `arm=${input.armId} sample=${input.sampleIndex} 的 stub 回答` });

if (isMainModule(process.argv[1], import.meta.url)) {
  const manifest = loadManifest();
  const result = dryRun(manifest, cannedProvider);
  process.stdout.write(
    `${JSON.stringify(
      {
        exitCode: result.exitCode,
        plannedOperations: result.plannedOperations,
        reservations: result.reservations.length,
        providerAttempts: result.providerAttempts,
        globalReserved: result.globalReserved,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(result.exitCode);
}
