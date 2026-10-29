/**
 * `pnpm experiment:arbiter:demo` 的入口。
 * 直接执行时写出可切换两种策略的演示页。`--serve` 时在本机提供该页。
 * 被导入时不改退出码，也不启动桌宠。
 * 协议见 docs/arbiter-protocol.md。
 * @module pet-next/experiments/arbiter/demo
 */
import { isDirectRun, NORMATIVE_EXAMPLES } from '../../../contracts/index.ts';
import { createBaseline } from '../baseline/index.ts';
import { createStateMachine } from '../state-machine/index.ts';
import { buildDemo } from './build-demo.ts';
import { serveDemo } from './serve.ts';

if (typeof createBaseline !== 'function' || typeof createStateMachine !== 'function' || NORMATIVE_EXAMPLES.length < 1) {
  throw new Error('仲裁协议占位不完整');
}

function portFromArgv(argv: readonly string[]): number {
  const index = argv.indexOf('--port');
  if (index === -1) return 0;
  const raw = argv[index + 1];
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port 需要 0 到 65535 的整数');
  }
  return port;
}

if (isDirectRun(import.meta.url)) {
  try {
    const built = await buildDemo();
    if (built.code !== 0 || built.model === null) {
      console.error(built.message);
      process.exitCode = built.code;
    } else if (process.argv.includes('--serve')) {
      const url = await serveDemo(built.model, portFromArgv(process.argv));
      console.log(`${built.message}\n本机页面：${url.href}`);
    } else {
      console.log(built.message);
      process.exitCode = 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
