/**
 * 判断某个模块是不是这次 node 进程的入口。
 * @module pet-next/contracts/direct-run
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 入口脚本与 `moduleUrl` 指向同一文件时为真。
 *
 * @param moduleUrl - 调用方自己的 `import.meta.url`。
 * @returns 被别人 import 时为假，避免占位入口改掉调用方的退出码。
 */
export function isDirectRun(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return moduleUrl === pathToFileURL(path.resolve(entry)).href;
}
