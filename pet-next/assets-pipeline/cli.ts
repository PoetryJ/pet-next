/**
 * `pnpm assets:check` 的入口。
 * 直接执行时退出码 2，表示素材流水线还没接入。
 * 被测试导入时不改退出码，也不改写成品素材。
 * 契约见 `docs/product-contract.md`。
 * @module pet-next/assets-pipeline/cli
 */
import { isDirectRun } from '../contracts/direct-run.ts';

if (isDirectRun(import.meta.url)) {
  console.error('assets:check 尚未实现。这个退出码不是素材通过。');
  process.exitCode = 2;
}
