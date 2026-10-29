/**
 * `pnpm experiment:arbiter:check` 的入口。
 * 直接执行时写出核对结果并设置退出码。被导入时不跑核对，也不改退出码。
 * 不启动桌宠。协议见 docs/arbiter-protocol.md。
 * @module pet-next/experiments/arbiter/check
 */
import { isDirectRun, NORMATIVE_EXAMPLES } from '../../../contracts/index.ts';
import { createBaseline } from '../baseline/index.ts';
import { createStateMachine } from '../state-machine/index.ts';
import { runCheck } from './run-check.ts';

if (typeof createBaseline !== 'function' || typeof createStateMachine !== 'function' || NORMATIVE_EXAMPLES.length < 1) {
  throw new Error('仲裁协议占位不完整');
}

if (isDirectRun(import.meta.url)) {
  try {
    process.exitCode = await runCheck();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
