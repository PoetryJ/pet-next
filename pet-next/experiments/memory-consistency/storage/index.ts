/**
 * 存储层门面。
 *
 * @module pet-next/experiments/memory-consistency/storage
 */
export { JsonlStore, isSamePayload } from './store.ts';
export { CRASH_POINTS, CRASH_EXIT_CODE, crashAt, type CrashPoint } from './crash-hook.ts';
