/**
 * `pnpm experiment:arbiter:check` 的入口。
 * 直接执行时退出码 2，表示核对器还没接入。
 * 被测试导入时不改退出码，也不启动桌宠。
 * 协议见 `docs/arbiter-protocol.md`。
 * @module pet-next/experiments/arbiter/check
 */
import { isDirectRun, NORMATIVE_EXAMPLES } from '../../../contracts/index.ts';
import { createBaseline } from '../baseline/index.ts';
import { createStateMachine } from '../state-machine/index.ts';

if (typeof createBaseline !== 'function' || typeof createStateMachine !== 'function' || NORMATIVE_EXAMPLES.length < 1) {
  throw new Error('仲裁协议占位不完整');
}

if (isDirectRun(import.meta.url)) {
  console.error('experiment:arbiter:check 尚未实现。这个退出码不是规则通过。');
  process.exitCode = 2;
}
