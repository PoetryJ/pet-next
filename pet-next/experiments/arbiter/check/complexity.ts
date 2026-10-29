/**
 * 用目录行数表示实现复杂度。测试文件不计入。
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** 一边的行数和它是否带进了第三方模块。 */
export interface Complexity {
  lines: number;
  files: readonly { path: string; lines: number }[];
  thirdPartyImports: readonly string[];
}

const IMPORT_FROM = /(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]/g;

/**
 * 统计一个实现目录。口径与 `wc -l` 相同，只数换行符。
 *
 * @param directory - `baseline` 或 `state-machine` 的绝对路径。
 * @returns 非测试 TypeScript 的行数，以及非相对、非 `node:` 的导入。
 */
export async function measureComplexity(directory: string): Promise<Complexity> {
  const files = (await typescriptSources(directory)).sort();
  const counted: { path: string; lines: number }[] = [];
  const imports = new Set<string>();
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    counted.push({ path: file, lines: newlineCount(source) });
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
      imports.add(specifier);
    }
  }
  return {
    lines: counted.reduce((sum, file) => sum + file.lines, 0),
    files: counted,
    thirdPartyImports: [...imports].sort(),
  };
}

async function typescriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptSources(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

function newlineCount(source: string): number {
  let count = 0;
  for (const char of source) {
    if (char === '\n') count += 1;
  }
  return count;
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_FROM)].flatMap((match) => (match[1] ? [match[1]] : []));
}
