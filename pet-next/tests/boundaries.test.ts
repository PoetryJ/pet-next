/**
 * 模块边界：core 不能引用运行时；pet-next 不能跨目录导入 dsh-pet。
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const coreRoot = path.join(petRoot, 'core');

const specifierPattern = /(?:from\s+|import\s*\(\s*|require\(\s*|import\s+)['"]([^'"]+)['"]/g;

export function specifiersOf(source: string): string[] {
  return [...source.matchAll(specifierPattern)].flatMap((match) => (match[1] ? [match[1]] : []));
}

export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

export function coreSpecifierAllowed(specifier: string, isTest: boolean): boolean {
  if (specifier.startsWith('.')) return true;
  if (!isTest) return false;
  return specifier === 'node:test' || specifier === 'node:assert' || specifier === 'node:assert/strict';
}

const runtimeWord = /\b(document|window|XMLHttpRequest|localStorage|fetch|process|require)\s*[(.]/;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('module boundaries', () => {
  test('core 只引用自己的相对模块，测试文件只能再引用 node:test 与 node:assert', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(coreRoot)) {
      const source = await readFile(file, 'utf8');
      const isTest = file.endsWith('.test.ts');
      for (const specifier of specifiersOf(source)) {
        if (!coreSpecifierAllowed(specifier, isTest)) {
          violations.push(`${path.relative(petRoot, file)} -> ${specifier}`);
        }
        if (specifier.startsWith('.')) {
          const resolved = path.normalize(path.join(path.dirname(file), specifier));
          if (resolved !== coreRoot && !resolved.startsWith(coreRoot + path.sep)) {
            violations.push(`${path.relative(petRoot, file)} escapes core via ${specifier}`);
          }
        }
      }
      if (!isTest && runtimeWord.test(stripComments(source))) {
        violations.push(`${path.relative(petRoot, file)} uses a runtime global`);
      }
    }
    assert.deepEqual(violations, []);
  });

  test('pet-next 的源码不能指向 dsh-pet，相对导入必须留在 pet-next 内', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles(petRoot)) {
      const source = await readFile(file, 'utf8');
      for (const specifier of specifiersOf(source)) {
        if (specifier.includes('dsh-pet')) violations.push(`${path.relative(petRoot, file)} -> ${specifier}`);
        if (!specifier.startsWith('.')) continue;
        const resolved = path.normalize(path.join(path.dirname(file), specifier));
        if (resolved !== petRoot && !resolved.startsWith(petRoot + path.sep)) {
          violations.push(`${path.relative(petRoot, file)} escapes pet-next via ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  test('检查器自己能认出越界导入', () => {
    assert.equal(coreSpecifierAllowed('node:fs', false), false);
    assert.equal(coreSpecifierAllowed('electron', true), false);
    assert.equal(coreSpecifierAllowed('node:test', true), true);
    const banned = ['..', '..', 'dsh-' + 'pet', 'src', 'shared', 'playback-lifecycle.ts'].join('/');
    assert.deepEqual(specifiersOf(`import x from '${banned}'`), [banned]);
    assert.equal(runtimeWord.test(stripComments('const el = document.querySelector("a")')), true);
    assert.equal(runtimeWord.test(stripComments('// document.querySelector')), false);
  });
});
