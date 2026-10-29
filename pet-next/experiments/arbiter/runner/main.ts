/**
 * `pnpm experiment:arbiter` 的入口。
 * 直接执行时写入原始日志并设置退出码。被导入时不跑实验，也不改退出码。
 * 不启动桌宠。协议见 docs/arbiter-protocol.md。
 * @module pet-next/experiments/arbiter/runner
 */
import { isDirectRun, NORMATIVE_EXAMPLES } from '../../../contracts/index.ts';
import { createBaseline } from '../baseline/index.ts';
import { createStateMachine } from '../state-machine/index.ts';
import { runExperiment } from './run-experiment.ts';

if (typeof createBaseline !== 'function' || typeof createStateMachine !== 'function' || NORMATIVE_EXAMPLES.length < 1) {
  throw new Error('仲裁入口缺少工厂或规范性例子');
}

if (isDirectRun(import.meta.url)) {
  try {
    process.exitCode = await runExperiment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
