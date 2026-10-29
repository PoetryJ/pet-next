/**
 * 契约用例接到真实 B/C 之后，这里不再留下待接入名单。
 * 实现目录空了才会回到替身，并重新点名同一批用例。
 * @module pet-next/tests/contracts/wiring
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { RequiredContractCase } from '../../contracts/coverage.ts';

/** 实现已接入。名单为空表示 `cases.test.ts` 打在真实工厂上。 */
export const NEEDS_REAL = {
  B: [],
  C: [],
} as const satisfies Record<'B' | 'C', readonly RequiredContractCase[]>;

const PENDING_WHEN_MISSING = {
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
  source: 'real' | 'contract-double';
  needsReal: 'B' | 'C';
  /** 相对 `pet-next`。非空表示实现已在目录里。 */
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
  const mediaFiles = await toRel(path.join(petRoot, 'adapters/media/two-slot'));
  const behaviorFiles = await toRel(path.join(petRoot, 'core/behavior'));
  return {
    media: {
      source: mediaFiles.length > 0 ? 'real' : 'contract-double',
      needsReal: 'B',
      implementationFiles: mediaFiles,
      cases: mediaFiles.length > 0 ? NEEDS_REAL.B : PENDING_WHEN_MISSING.B,
    },
    behavior: {
      source: behaviorFiles.length > 0 ? 'real' : 'contract-double',
      needsReal: 'C',
      implementationFiles: behaviorFiles,
      cases: behaviorFiles.length > 0 ? NEEDS_REAL.C : PENDING_WHEN_MISSING.C,
    },
  };
}
