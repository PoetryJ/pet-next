/**
 * 真实 B/C 还没落地时，用例打在契约替身上，并在这里点名待接入的用例。
 * 实现文件一旦出现，结构测试会失败，提示把同一批断言接到真实工厂。
 * @module pet-next/tests/contracts/wiring
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { RequiredContractCase } from '../../contracts/coverage.ts';

/** 仍需换成真实模块的用例。替身通过不等于 B 或 C 已接入。 */
export const NEEDS_REAL = {
  B: [
    'late-loaded',
    'late-ended',
    'duplicate-request',
    'consecutive-clicks',
    'load-failure',
    'callback-after-dispose',
    'preheat-races-click',
    'bounded-history',
  ],
  C: [
    'late-loaded',
    'late-ended',
    'duplicate-request',
    'consecutive-clicks',
    'load-failure',
    'drag-blocks-auto',
    'expired-action',
    'bounded-history',
  ],
} as const satisfies Record<'B' | 'C', readonly RequiredContractCase[]>;

export interface WiringSide {
  source: 'contract-double';
  needsReal: 'B' | 'C';
  /** 相对 `pet-next`。非空表示实现已在目录里，但这批用例还没接上。 */
  implementationFiles: readonly string[];
  cases: readonly RequiredContractCase[];
}

/** 扫描实现目录。`owner.txt` 和测试不算实现。 */
export async function implementationFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'owner.txt' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await implementationFiles(full)));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files.sort();
}

export async function wiringReport(petRoot: string): Promise<{ media: WiringSide; behavior: WiringSide }> {
  const toRel = async (dir: string): Promise<string[]> => {
    const files = await implementationFiles(dir);
    return files.map((file) => path.relative(petRoot, file).split(path.sep).join('/'));
  };
  return {
    media: {
      source: 'contract-double',
      needsReal: 'B',
      implementationFiles: await toRel(path.join(petRoot, 'adapters/media/two-slot')),
      cases: NEEDS_REAL.B,
    },
    behavior: {
      source: 'contract-double',
      needsReal: 'C',
      implementationFiles: await toRel(path.join(petRoot, 'core/behavior')),
      cases: NEEDS_REAL.C,
    },
  };
}
