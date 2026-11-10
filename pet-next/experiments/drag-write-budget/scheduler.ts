/**
 * 实验入口：拖动写入预算调度器。
 *
 * 实现放在 `core/drag-write-budget/scheduler.ts`，这里只做 re-export，原因不是分层洁癖：
 * 仓库已有 `tests/boundaries.test.ts` 明确要求「产品目录（app/electron/core/adapters/scripts/tests）
 * 不得引用 experiments/ 或 assets-pipeline/」。候选要接进真实 `electron/main.ts` 与
 * `adapters/window/drag-write-budget.ts`，就必须有一个产品侧的实现位置；实验目录保留同名入口，
 * 单测与实验脚本仍按契约从 `experiments/drag-write-budget/scheduler.ts` 取同一份实现。
 *
 * 语义、类型与注入时钟契约见 `docs/M3-11-DRAG-WRITE-BUDGET.md` 第 2 节。
 * @module pet-next/experiments/drag-write-budget/scheduler
 */
export * from '../../core/drag-write-budget/scheduler.ts';
