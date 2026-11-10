/**
 * 「真实模型外呼 0」的证据。
 *
 * 两层：
 * 1) 静态：生产目录不 import 任何网络模块，也不出现模型服务地址/密钥读取。
 * 2) 运行时：把 fetch 换成会自增计数并抛错的哨兵，整批轨迹仍全绿且计数为 0。
 *
 * 这不是「跑过一晚上没出事」，而是每次跑测试都会重新证明。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { evaluateDataset, loadDevTracks, loadExpectations } from './dataset.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_ROOT = join(HERE, '..');

/** 测试支撑目录不参与扫描（它们是测试数据构造器，不是运行时代码）。 */
const SKIP_DIRS = new Set(['tests', 'testing', 'node_modules', 'tmp', 'out', 'dev']);
const FORBIDDEN = [
  "from 'node:http'",
  'from "node:http"',
  "from 'node:https'",
  'from "node:https"',
  "from 'node:net'",
  'from "node:net"',
  "from 'node:dns'",
  'from "node:dns"',
  'undici',
  'XMLHttpRequest',
  'api.openai',
  '18872',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      out.push(...listFiles(path));
    } else if ((name.endsWith('.ts') || name.endsWith('.mjs')) && !name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('零外呼', () => {
  test('生产目录不引用网络模块或模型服务地址', () => {
    const offenders: string[] = [];
    for (const file of listFiles(EXPERIMENT_ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) {
          offenders.push(`${relative(EXPERIMENT_ROOT, file)} :: ${needle}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('fetch 哨兵一次也没被调用，整批轨迹仍全绿', () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error('network denied by experiment sentinel');
    }) as typeof globalThis.fetch;
    try {
      const { score } = evaluateDataset(loadDevTracks(), loadExpectations());
      assert.equal(score.failed, 0);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 0);
  });
});
