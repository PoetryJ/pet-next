/**
 * 账本门面。B/D 只从这里拿纯接口，不直接 import 内部文件。
 *
 * @module pet-next/experiments/memory-consistency/ledger
 */
export { reduce, stepEvent, orderEvents, type StepOutcome } from './reduce.ts';
export {
  applyPatch,
  validatePatch,
  recomputeDependencies,
  type ApplyOutcome,
  type PatchOptions,
  type RecomputedDependencies,
} from './patch.ts';
export { activeNotes, invalidateNotes, type InvalidationOutcome } from './invalidate.ts';
export { validateEventShape, isSettlementKind, reasonCode, type ShapeProblem } from './shape.ts';
