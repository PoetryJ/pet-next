/**
 * 崩溃注入钩子。只在测试进程里由环境变量触发，生产路径不设置变量就什么也不做。
 *
 * 用途：D 的恢复实验需要在「已写盘未确认」「快照已切换清单未切换」等精确位置
 * 让进程退出，而不是随机杀共享进程。
 *
 * @module pet-next/experiments/memory-consistency/storage/crash-hook
 */

/** 可注入的故障点。名字即语义，测试按名字断言。 */
export const CRASH_POINTS = [
  'append.before-write',
  'append.after-write.before-ack',
  'append.after-ack',
  'patch.before-write',
  'patch.after-write.before-ack',
  'patch.after-ack',
  'checkpoint.after-snapshot',
  'checkpoint.after-manifest.before-ack',
] as const;

export type CrashPoint = (typeof CRASH_POINTS)[number];

/** 退出码 97：本实验约定的「注入崩溃」。 */
export const CRASH_EXIT_CODE = 97;

/** 在指定点退出进程。未命中就正常返回。 */
export function crashAt(point: CrashPoint): void {
  const configured = process.env['MEMORY_STORE_CRASH_AT'];
  if (configured === undefined || configured !== point) return;
  process.exit(CRASH_EXIT_CODE);
}
