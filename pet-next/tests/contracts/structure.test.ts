/**
 * 结构核对和统一验收的收集范围。不改集成独占的脚本。
 * @module pet-next/tests/contracts/structure
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REQUIRED_CONTRACT_CASES } from '../../contracts/coverage.ts';
import { verifyReach } from './verify-reach.ts';
import { wiringReport } from './wiring.ts';

const petRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const here = path.dirname(fileURLToPath(import.meta.url));

const specifierPattern = /(?:from\s+|import\s*\(\s*|require\(\s*|import\s+)['"]([^'"]+)['"]/g;

describe('契约测试的边界', () => {
  test('用例只依赖契约和本目录替身', async () => {
    const violations: string[] = [];
    for (const file of await readdir(here)) {
      if (!file.endsWith('.ts')) continue;
      const source = stripComments(await readFile(path.join(here, file), 'utf8'));
      for (const specifier of specifiersOf(source)) {
        const allowed =
          specifier.startsWith('node:') ||
          specifier.startsWith('../../contracts/') ||
          (specifier.startsWith('./') && !specifier.includes('..'));
        if (!allowed) violations.push(`${file} -> ${specifier}`);
      }
    }
    assert.deepEqual(violations, []);
  });

  test('本目录不使用固定 sleep', async () => {
    const banned = new RegExp(String.raw`\bset${'Timeout'}\b|\bset${'Interval'}\b|\bsleep\s*\(`);
    const hits: string[] = [];
    for (const file of await readdir(here)) {
      if (!file.endsWith('.ts')) continue;
      const source = stripComments(await readFile(path.join(here, file), 'utf8'));
      if (banned.test(source)) hits.push(file);
    }
    assert.deepEqual(hits, []);
  });

  test('B 和 C 仍未接入，行为目录没有契约导入、时钟或随机数', async () => {
    const report = await wiringReport(petRoot);
    const violations: string[] = [];
    for (const rel of report.behavior.implementationFiles) {
      const source = stripComments(await readFile(path.join(petRoot, rel), 'utf8'));
      if (/\bDate\.now\b|\bMath\.random\b|\bperformance\.now\b|\belectron\b|\bdocument\b|\bwindow\b/.test(source)) {
        violations.push(rel);
      }
      for (const specifier of specifiersOf(source)) {
        if (specifier.includes('contracts') || specifier === 'electron' || specifier.startsWith('electron/')) {
          violations.push(`${rel} -> ${specifier}`);
        }
      }
    }
    assert.deepEqual(
      {
        mediaSource: report.media.source,
        behaviorSource: report.behavior.source,
        mediaFiles: report.media.implementationFiles,
        behaviorFiles: report.behavior.implementationFiles,
        behaviorViolations: violations,
      },
      {
        mediaSource: 'contract-double',
        behaviorSource: 'contract-double',
        mediaFiles: [],
        behaviorFiles: [],
        behaviorViolations: [],
      },
      'B 或 C 的实现已经出现。把 NEEDS_REAL 里的同一批断言接到真实工厂，不要删断言，也不要继续只跑替身。',
    );
    const marked = [...new Set([...report.media.cases, ...report.behavior.cases])].sort();
    assert.deepEqual(marked, [...REQUIRED_CONTRACT_CASES].sort());
    assert.equal(await dirExists(path.join(petRoot, 'core/behavior')), true);
  });

  test('现有产品测试和实验测试都能被 verify 收集到', async () => {
    const reach = await verifyReach(petRoot);
    for (const root of ['core', 'adapters', 'app', 'tests', 'experiments', 'bench']) {
      assert.equal(reach.unitRoots.includes(root), true, root);
    }
    for (const rel of [
      'core/playback/playback.test.ts',
      'core/interaction/interaction.test.ts',
      'adapters/media/adapter.test.ts',
      'tests/boundaries.test.ts',
      'tests/runner/runner.test.ts',
      'tests/electron.e2e.test.ts',
      'tests/drag-scale.e2e.test.ts',
      'experiments/arbiter/baseline/index.test.ts',
      'experiments/arbiter/state-machine/index.test.ts',
      'experiments/arbiter/runner/main.test.ts',
      'experiments/arbiter/tests/oracle.test.ts',
      'experiments/arbiter/tests/heldout.test.ts',
      'experiments/arbiter/fixtures/catalog.test.ts',
      'assets-pipeline/assess-quality.test.ts',
      'assets-pipeline/encode-alpha.test.ts',
      'tests/contracts/cases.test.ts',
    ]) {
      assert.equal(reach.found.includes(rel), true, `缺少 ${rel}`);
      assert.equal(reach.missed.includes(rel), false, `verify 跑不到 ${rel}`);
    }
    assert.deepEqual(reach.missed, []);
  });
});

function specifiersOf(source: string): string[] {
  return [...source.matchAll(specifierPattern)].flatMap((match) => (match[1] ? [match[1]] : []));
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.includes('owner.txt');
  } catch {
    return false;
  }
}
