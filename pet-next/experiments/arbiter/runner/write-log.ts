/**
 * 把原始运行日志写到 `experiments/arbiter/out`。不解释规则。
 */
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArbiterRunLog } from '../../../contracts/arbiter.ts';

/** runner 默认写出的目录。 */
export function defaultOutDir(): string {
  return fileURLToPath(new URL('../out/', import.meta.url));
}

/**
 * 写入 `<out>/<implementation>/<fixture>.json`。
 *
 * @param outDir - 日志根目录。
 * @param log - 一次夹具运行。
 * @returns 写出的文件路径。
 */
export async function writeRunLog(outDir: string, log: ArbiterRunLog): Promise<string> {
  const dir = path.join(outDir, log.implementation);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${log.fixture}.json`);
  await writeFile(file, `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * 状态机仍是占位时留下的标记，并清掉该目录里过期的夹具日志。
 *
 * @param outDir - 日志根目录。
 */
export async function writeUnimplementedStatus(outDir: string): Promise<void> {
  const dir = path.join(outDir, 'state-machine');
  await mkdir(dir, { recursive: true });
  const names = await readdir(dir);
  await Promise.all(
    names.filter((name) => name.endsWith('.json') && name !== 'status.json').map((name) => unlink(path.join(dir, name))),
  );
  await writeFile(path.join(dir, 'status.json'), `${JSON.stringify({ status: 'not-implemented' }, null, 2)}\n`, 'utf8');
}

/**
 * 状态机已经跑起来时去掉占位标记。文件本来不存在则忽略。
 *
 * @param outDir - 日志根目录。
 */
export async function removeUnimplementedStatus(outDir: string): Promise<void> {
  try {
    await unlink(path.join(outDir, 'state-machine', 'status.json'));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
