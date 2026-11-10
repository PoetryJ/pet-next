/**
 * 候选适配器的**公开面**形状（docs/M3-11-DRAG-WRITE-BUDGET.md 第 2/3 节）。
 *
 * 这里只声明"验收方按冻结契约期望的公开 API"，不复制任何实现，也不 import 候选内部私有函数。
 * 候选文件缺失或形状不符时由用例带原因跳过/失败，而不是让本目录的单元测试整体崩掉。
 * @module pet-next/tests/drag-write-budget/support/contract
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { WindowHost } from '../../../adapters/window/types.ts';

export interface DragPosition {
  readonly x: number;
  readonly y: number;
}

/** 契约第 2 节：注入的单调时钟。 */
export interface WriteBudgetClock {
  now(): number;
  schedule(delayMs: number, run: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface WriteBudgetStats {
  readonly submitted: number;
  readonly written: number;
  readonly coalesced: number;
  readonly duplicateDropped: number;
  readonly flushes: number;
}

/** 契约第 3 节：带拖动生命周期与统计的窗口控制器。 */
export interface BudgetedWindowController {
  moveBy(dx: number, dy: number): void;
  quit(): void;
  endDrag(): void;
  noteGeometryChanged(): void;
  dispose(): void;
  readonly stats: WriteBudgetStats;
}

export type BudgetedFactory = (
  host: WindowHost,
  options?: { budgetMs?: number; clock?: Partial<WriteBudgetClock> },
) => BudgetedWindowController;

export const CANDIDATE_FILE = fileURLToPath(
  new URL('../../../adapters/window/drag-write-budget.ts', import.meta.url),
);

export interface CandidateGate {
  readonly factory: BudgetedFactory | null;
  /** 为空表示可用；否则是跳过的原因（写进测试报告）。 */
  readonly reason: string;
}

/**
 * 动态加载候选适配器。用变量说明符是为了让 `tsc`/lint 不静态依赖一个可能还不存在的文件：
 * 缺口只在运行期体现，并且带明确原因，不会污染全仓 typecheck。
 */
export async function loadCandidate(): Promise<CandidateGate> {
  if (!existsSync(CANDIDATE_FILE)) {
    return { factory: null, reason: `候选适配器未落地：${CANDIDATE_FILE} 不存在（等待 C）` };
  }
  const url = new URL('../../../adapters/window/drag-write-budget.ts', import.meta.url).href;
  let module: Record<string, unknown>;
  try {
    module = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? (error.message ?? String(error)) : String(error);
    return { factory: null, reason: `候选适配器无法加载：${message}` };
  }
  const factory = module['createBudgetedWindowController'];
  if (typeof factory !== 'function') {
    return { factory: null, reason: '候选模块未导出 createBudgetedWindowController（契约第 3 节）' };
  }
  return { factory: factory as BudgetedFactory, reason: '' };
}

/** 把候选返回值挡成契约形状；签名漂移时给出契约人话，而不是 undefined 崩栈。 */
export function expectShape(controller: unknown): BudgetedWindowController {
  const record = controller as Record<string, unknown> | null;
  const missing: string[] = [];
  if (typeof record !== 'object' || record === null) throw new Error('createBudgetedWindowController 未返回对象');
  for (const name of ['moveBy', 'quit', 'endDrag', 'noteGeometryChanged', 'dispose']) {
    if (typeof record[name] !== 'function') missing.push(name);
  }
  const stats = record['stats'];
  if (typeof stats !== 'object' || stats === null) missing.push('stats');
  if (missing.length > 0) {
    throw new Error(`候选控制器缺少契约成员：${missing.join(', ')}（契约第 3 节）`);
  }
  return controller as BudgetedWindowController;
}
