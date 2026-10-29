/**
 * 自动动作提议器。时间来自注入时钟，下标来自注入随机数。
 * 不生成请求身份，也不读取 `Date.now` 或 `Math.random`。
 * @module pet-next/core/behavior/propose
 */
import { indexFromRandom } from './policy.ts';
import type { AutoCandidate, BehaviorDeps, BehaviorInput } from './types.ts';

/**
 * 从候选里挑一条已经可以开始、且尚未过期的自动动作。
 * 合格者只有一条时不调用 `random`。返回值是入参中的那个对象。
 */
export function selectDueAuto(
  candidates: readonly AutoCandidate[],
  nowMs: number,
  random: () => number,
): AutoCandidate | null {
  if (!Number.isFinite(nowMs)) return null;
  const due: AutoCandidate[] = [];
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.readyAtMs) || !Number.isFinite(candidate.expiresAtMs)) continue;
    if (candidate.readyAtMs <= nowMs && nowMs < candidate.expiresAtMs) due.push(candidate);
  }
  if (due.length === 0) return null;
  return due[indexFromRandom(due.length, random)] ?? null;
}

/**
 * 读取注入时钟，再挑选下一条自动动作。
 * 没有合格候选时返回 null。合格者不足两条时不调用 `random`。
 * 调用方负责把返回值交给调度器。本函数不改调度状态。
 */
export function proposeNextAuto(
  candidates: readonly AutoCandidate[],
  deps: BehaviorDeps,
): Extract<BehaviorInput, { type: 'auto' }> | null {
  const nowMs = deps.nowMs();
  const selected = selectDueAuto(candidates, nowMs, deps.random);
  if (selected === null) return null;
  return {
    type: 'auto',
    requestId: selected.requestId,
    nowMs,
    expiresAtMs: selected.expiresAtMs,
  };
}
