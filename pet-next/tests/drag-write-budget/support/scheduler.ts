/**
 * B 的纯调度器（`experiments/drag-write-budget/`）公开面加载器。
 *
 * 冻结契约第 5 节只给了目录（`experiments/drag-write-budget/**`），没给文件名，
 * 所以这里按已知可能的入口顺序探测；命中第一个导出 `createWriteBudget` 的文件即用。
 * 找不到就带原因跳过——调度器语义（第 2 节）不重复测成白盒，只走公开 API。
 * @module pet-next/tests/drag-write-budget/support/scheduler
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { DragPosition, WriteBudgetStats } from './contract.ts';

export interface SchedulerOptions {
  now(): number;
  schedule(delayMs: number, run: () => void): unknown;
  cancel(handle: unknown): void;
  write(position: DragPosition): void;
  budgetMs?: number;
}

/** 契约第 2 节：调度器公开面。 */
export interface WriteBudget {
  begin(): void;
  submit(position: DragPosition): void;
  end(): void;
  cancel(): void;
  dispose(): void;
  readonly stats: WriteBudgetStats;
}

export type SchedulerFactory = (options: SchedulerOptions) => WriteBudget;

const PROBE_PATHS = [
  'experiments/drag-write-budget/write-budget.ts',
  'experiments/drag-write-budget/index.ts',
  'experiments/drag-write-budget/scheduler.ts',
  'experiments/drag-write-budget/budget.ts',
  'experiments/drag-write-budget/write-budget/index.ts',
] as const;

export interface SchedulerGate {
  readonly factory: SchedulerFactory | null;
  readonly file: string;
  readonly reason: string;
}

export async function loadScheduler(): Promise<SchedulerGate> {
  const probed: string[] = [];
  for (const relative of PROBE_PATHS) {
    const url = new URL(`../../../${relative}`, import.meta.url);
    probed.push(relative);
    if (!existsSync(fileURLToPath(url))) continue;
    let module: Record<string, unknown>;
    try {
      module = (await import(url.href)) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? (error.message ?? String(error)) : String(error);
      return { factory: null, file: relative, reason: `${relative} 无法加载：${message}` };
    }
    const factory = module['createWriteBudget'];
    if (typeof factory === 'function') {
      return { factory: factory as SchedulerFactory, file: relative, reason: '' };
    }
    return { factory: null, file: relative, reason: `${relative} 未导出 createWriteBudget（契约第 2 节）` };
  }
  return { factory: null, file: '', reason: `未找到纯调度器模块（已探测：${probed.join(', ')}；等待 B）` };
}

/** 签名漂移时给出契约人话。 */
export function expectSchedulerShape(value: unknown): WriteBudget {
  const record = value as Record<string, unknown> | null;
  if (typeof record !== 'object' || record === null) throw new Error('createWriteBudget 未返回对象');
  const missing: string[] = [];
  for (const name of ['begin', 'submit', 'end', 'cancel', 'dispose']) {
    if (typeof record[name] !== 'function') missing.push(name);
  }
  if (typeof record['stats'] !== 'object' || record['stats'] === null) missing.push('stats');
  if (missing.length > 0) throw new Error(`调度器缺少契约成员：${missing.join(', ')}（契约第 2 节）`);
  return value as WriteBudget;
}
