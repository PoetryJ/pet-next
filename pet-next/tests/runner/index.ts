/**
 * 测试进程树的实现目录。默认启动和当前 Electron 实测都不引用这里。
 * @module pet-next/tests/runner
 */
import type { ProcessTracker } from '../../contracts/process-tracker.ts';

/** 进程树工厂。Agent A 实现 `start` 与 `dispose`。导入本模块不会启动进程。 */
export function createProcessTracker(): ProcessTracker {
  throw new Error('process tracker 尚未实现');
}
