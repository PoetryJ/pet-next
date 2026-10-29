/**
 * 模块边界：core 不能引用运行时；pet-next 不能跨目录导入 dsh-pet。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPointerAdapter } from '../adapters/pointer/index.ts';
import {
  ARBITER_RANK,
  BEHAVIOR_LIMITS,
  BENCH_MODES,
  BENCH_ROUND_COUNT,
  BENCH_SAMPLE_COUNT,
  MEDIA_SLOT_COUNT,
  mulberry32,
  NORMATIVE_EXAMPLES,
  PLAYBACK_MODES,
  PRODUCT_BEHAVIOR_RULES,
  REQUIRED_BACKGROUNDS,
  REQUIRED_CONTRACT_CASES,
  REQUIRED_FIXTURE_NAMES,
  REQUIRED_PLATFORM_FLOWS,
  REQUIRED_PLATFORMS,
  REQUIRED_PROCESS_CASES,
  REQUIRED_SCALE_CASES,
  SUSTAINED_LOAD,
  parsePreview,
  previewUsesAcceptedPath,
  type QualityEvidence,
} from '../contracts/index.ts';
import { createBaseline } from '../experiments/arbiter/baseline/index.ts';
import { createStateMachine } from '../experiments/arbiter/state-machine/index.ts';
import { createProcessTracker } from './runner/index.ts';

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

const shippedAssets = {
  'assets/idle.webm': '6ebca6b20bcce978f5a52f8333212784b3a642d0b8803c630a455439ebb7df1a',
  'assets/reaction.webm': '9d73e16ca8d9abcfff96a41d9e98f632a241691ddf81b59538b16a6e77049861',
  'assets/placeholder.png': 'cef548d332264a6ffc9440679da983c0be61e34ed2b41f879fce150647d41dc8',
} as const;

type ForbidsKey<T, K extends string> = K extends keyof T ? never : true;

const evidenceOmitsBackgroundColor: ForbidsKey<QualityEvidence, 'backgroundColorString'> = true;

function inside(file: string, root: string): boolean {
  const normalized = path.normalize(file);
  const base = path.normalize(root);
  return normalized === base || normalized.startsWith(base + path.sep);
}

function leavesProduct(specifier: string): boolean {
  return (
    specifier.includes('experiments/') ||
    specifier.endsWith('/experiments') ||
    specifier === 'experiments' ||
    specifier.includes('assets-pipeline')
  );
}

function implementationSpecifierAllowed(specifier: string, file: string, implRoot: string): boolean {
  const isTest = file.endsWith('.test.ts');
  if (specifier.startsWith('.')) {
    const resolved = path.normalize(path.join(path.dirname(file), specifier));
    return inside(resolved, implRoot) || inside(resolved, path.join(petRoot, 'contracts'));
  }
  if (!isTest) return false;
  return specifier === 'node:test' || specifier === 'node:assert' || specifier === 'node:assert/strict';
}

const impureWord = /\b(document|window|XMLHttpRequest|localStorage|fetch|process|require)\s*[[(.]|\bDate\.now\b|\bperformance\.now\b|\bMath\.random\b|\belectron\b/;

function exampleNamed(name: (typeof NORMATIVE_EXAMPLES)[number]['name']) {
  const found = NORMATIVE_EXAMPLES.find((item) => item.name === name);
  assert.ok(found);
  return found;
}

describe('integration contracts', () => {
  test('成品素材字节不变', async () => {
    for (const [rel, expected] of Object.entries(shippedAssets)) {
      const bytes = await readFile(path.join(petRoot, rel));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, rel);
    }
  });

  test('页面指针仍走 screenX，或已接到指针适配器', async () => {
    const page = await readFile(path.join(petRoot, 'app/page.ts'), 'utf8');
    assert.equal(page.includes('x: ev.screenX') || page.includes('createPointerAdapter'), true);
    assert.equal(page.includes('experiments/'), false);
    assert.equal(page.includes('createMediaAdapter'), true);
    assert.equal(page.includes('adapters/media/two-slot'), false);
    assert.equal(page.includes('core/behavior'), false);
    const scripts = JSON.parse(await readFile(path.join(petRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    assert.equal(scripts.scripts.start, 'pnpm build && node scripts/start.mjs');
    assert.equal(scripts.scripts.verify, 'pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:e2e');
    assert.equal(scripts.scripts.test, 'node scripts/unit-tests.mjs');
    const unitTests = await readFile(path.join(petRoot, 'scripts/unit-tests.mjs'), 'utf8');
    for (const rel of ['core', 'adapters', 'app', 'tests', 'experiments', 'bench']) {
      assert.equal(unitTests.includes(`'${rel}'`), true, rel);
    }
    assert.equal(unitTests.includes('.e2e.test.ts'), true);
    assert.equal(
      scripts.scripts['test:e2e'],
      'node --experimental-strip-types --test --test-concurrency=1 --test-reporter spec tests/*.e2e.test.ts',
    );
    assert.equal(scripts.scripts['verify:windows'], 'powershell -File scripts/verify-windows.ps1');
    assert.equal(scripts.scripts['assets:check'], 'node --experimental-strip-types assets-pipeline/cli.ts');
    assert.equal(scripts.scripts['experiment:arbiter'], 'node --experimental-strip-types experiments/arbiter/runner/main.ts');
    assert.equal(scripts.scripts['experiment:arbiter:check'], 'node --experimental-strip-types experiments/arbiter/check/main.ts');
    assert.equal(scripts.scripts['experiment:arbiter:demo'], 'node --experimental-strip-types experiments/arbiter/demo/main.ts');
    assert.equal(scripts.scripts.start.includes('experiment'), false);
    assert.equal(scripts.scripts.verify.includes('experiment'), false);
    assert.equal(scripts.scripts.verify.includes('assets:check'), false);
    const start = await readFile(path.join(petRoot, 'scripts/start.mjs'), 'utf8');
    assert.equal(start.includes('experiments/'), false);
    assert.equal(start.includes('assets-pipeline'), false);
    const main = await readFile(path.join(petRoot, 'electron/main.ts'), 'utf8');
    assert.equal(main.includes('PREVIEW_ENV'), true);
    assert.equal(main.includes('query[PREVIEW_QUERY] = preview'), true);
    assert.equal(previewUsesAcceptedPath(parsePreview(undefined)), true);
  });

  test('现有 Electron 实测仍断言缩放 1 对照下的精确位移', async () => {
    const source = await readFile(path.join(petRoot, 'tests/electron.e2e.test.ts'), 'utf8');
    assert.equal(source.includes('beforeDrag.x + 40'), true);
    assert.equal(source.includes('beforeDrag.y + 16'), true);
    assert.equal(source.includes('(beforeDrag?.x ?? 0) + 24'), true);
    assert.equal(source.includes('(beforeDrag?.y ?? 0) + 10'), true);
  });

  test('产品目录不引用实验或素材流水线', async () => {
    const roots = ['app', 'electron', 'core', 'adapters', 'scripts', 'tests'];
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of await sourceFiles(path.join(petRoot, root))) {
        if (file.endsWith(`${path.sep}tests${path.sep}boundaries.test.ts`)) continue;
        const source = await readFile(file, 'utf8');
        for (const specifier of specifiersOf(source)) {
          if (leavesProduct(specifier)) violations.push(`${path.relative(petRoot, file)} -> ${specifier}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  test('实验和素材流水线不引用 Electron，也不指向桌宠入口', async () => {
    const violations: string[] = [];
    for (const root of ['experiments', 'assets-pipeline']) {
      for (const file of await sourceFiles(path.join(petRoot, root))) {
        const source = await readFile(file, 'utf8');
        if (source.includes('dist/electron/main.js') || source.includes('scripts/start.mjs')) {
          violations.push(path.relative(petRoot, file));
        }
        for (const specifier of specifiersOf(source)) {
          if (specifier === 'electron' || specifier.startsWith('electron/')) {
            violations.push(`${path.relative(petRoot, file)} -> ${specifier}`);
          }
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  test('基线与状态机只依赖契约，并且不读取时钟或宿主', async () => {
    const roots = ['experiments/arbiter/baseline', 'experiments/arbiter/state-machine'];
    const violations: string[] = [];
    for (const rel of roots) {
      const implRoot = path.join(petRoot, rel);
      for (const file of await sourceFiles(implRoot)) {
        const source = await readFile(file, 'utf8');
        const isTest = file.endsWith('.test.ts');
        for (const specifier of specifiersOf(source)) {
          if (!implementationSpecifierAllowed(specifier, file, implRoot)) {
            violations.push(`${path.relative(petRoot, file)} -> ${specifier}`);
          }
        }
        if (!isTest && impureWord.test(stripComments(source))) violations.push(path.relative(petRoot, file));
      }
    }
    assert.deepEqual(violations, []);
  });

  test('实验与素材入口被导入时不改退出码', async () => {
    const before = process.exitCode;
    await import('../experiments/arbiter/runner/main.ts');
    await import('../experiments/arbiter/check/main.ts');
    await import('../experiments/arbiter/demo/main.ts');
    await import('../assets-pipeline/cli.ts');
    assert.equal(process.exitCode, before);
  });

  test('缩放、进程、素材和仲裁的矩阵名称保持固定', () => {
    assert.equal(evidenceOmitsBackgroundColor, true);
    assert.deepEqual(REQUIRED_PLATFORMS, ['linux', 'win32']);
    assert.deepEqual(REQUIRED_PROCESS_CASES, ['spawn-failure', 'timeout', 'clean-exit', 'foreign-pid-survives']);
    assert.deepEqual(REQUIRED_BACKGROUNDS, ['light', 'dark', 'checker']);
    assert.deepEqual(
      REQUIRED_SCALE_CASES.map((item) => [item.id, item.origin, item.scaleFactor]),
      [
        ['default', 'default', null],
        ['simulated-100', 'simulated', 1],
        ['simulated-125', 'simulated', 1.25],
        ['simulated-150', 'simulated', 1.5],
        ['system-100', 'system', 1],
        ['system-125', 'system', 1.25],
        ['system-150', 'system', 1.5],
      ],
    );
    assert.equal(ARBITER_RANK.drag > ARBITER_RANK.click, true);
    assert.equal(ARBITER_RANK.click > ARBITER_RANK.auto, true);
    assert.equal(SUSTAINED_LOAD.fixture, 'sustained-high-priority');
    assert.equal(SUSTAINED_LOAD.seed, 20261029);
    assert.equal(SUSTAINED_LOAD.count, 100);
    assert.equal(SUSTAINED_LOAD.timeStepMs, 10);
    assert.equal(SUSTAINED_LOAD.ttlMs, 50);
    assert.equal(SUSTAINED_LOAD.dragBelow, 0.7);
    assert.equal(SUSTAINED_LOAD.clickBelow, 0.85);
    assert.equal(mulberry32(SUSTAINED_LOAD.seed)(), 0.850172859383747);
    assert.deepEqual(
      NORMATIVE_EXAMPLES.map((item) => item.name).sort(),
      REQUIRED_FIXTURE_NAMES.filter((name) => name !== 'sustained-high-priority').sort(),
    );
    for (const item of NORMATIVE_EXAMPLES) assert.equal(item.expected.length, item.inputs.length, item.name);
    assert.equal(typeof createProcessTracker, 'function');
    assert.equal(typeof createPointerAdapter, 'function');
    assert.equal(typeof createBaseline, 'function');
    assert.equal(typeof createStateMachine, 'function');
    assert.equal(MEDIA_SLOT_COUNT, 2);
    assert.deepEqual(PLAYBACK_MODES, ['single', 'two-slot', 'two-slot-preheat']);
    assert.deepEqual(BENCH_MODES, ['single', 'two-slot', 'two-slot-preheat']);
    assert.equal(BENCH_SAMPLE_COUNT, 30);
    assert.equal(BENCH_ROUND_COUNT, 3);
    assert.equal(BEHAVIOR_LIMITS.pending, 8);
    assert.equal(BEHAVIOR_LIMITS.history, 32);
    assert.deepEqual(PRODUCT_BEHAVIOR_RULES, [
      'drag-priority',
      'latest-click-overrides',
      'auto-only-when-idle',
      'no-auto-start-during-drag',
      'expired-auto-discarded',
      'idle-after-settle',
      'idempotent-request',
      'bounded-capacity',
    ]);
    assert.deepEqual(REQUIRED_CONTRACT_CASES, [
      'late-loaded',
      'late-ended',
      'duplicate-request',
      'consecutive-clicks',
      'load-failure',
      'callback-after-dispose',
      'preheat-races-click',
      'drag-blocks-auto',
      'expired-action',
      'bounded-history',
    ]);
    assert.deepEqual(REQUIRED_PLATFORM_FLOWS, ['click', 'drag', 'transparent', 'quit', 'process-cleanup']);
  });

  test('规范性例子锁住抢占、过期、旧回调和乱序', () => {
    const conflictClick = exampleNamed('conflict');
    assert.equal(conflictClick.expected[1]?.decisions[0]?.reason, 'preempted');
    assert.equal(conflictClick.expected[1]?.decisions[0]?.eventId, 'a');
    assert.equal(conflictClick.expected[1]?.decisions[1]?.reason, 'started');
    assert.equal(conflictClick.expected[1]?.decisions[1]?.eventId, 'b');
    assert.equal(conflictClick.expected[2]?.decisions[1]?.eventId, 'd');

    const expired = exampleNamed('expired');
    const born = expired.inputs[1];
    assert.ok(born);
    assert.equal(born.type, 'deliver');
    if (born.type === 'deliver') {
      assert.equal(born.nowMs, born.event.expiresAtMs);
      assert.equal(born.event.timeMs, born.event.expiresAtMs);
    }
    const waiting = expired.inputs[2];
    assert.ok(waiting && waiting.type === 'deliver' && waiting.event.id === 'a');
    if (waiting.type === 'deliver') assert.equal(waiting.event.expiresAtMs, 30);
    assert.equal(expired.expected[2]?.decisions[0]?.reason, 'drag-blocks-auto');
    assert.equal(expired.expected[3]?.decisions[0]?.reason, 'queued-lower-rank');
    assert.equal(expired.expected[3]?.decisions[0]?.eventId, 'c');
    const tail = expired.inputs[4];
    const tailExpected = expired.expected[4];
    assert.ok(tail && tail.type === 'complete' && tail.nowMs === 30);
    assert.equal(tailExpected?.queueLength, 0);
    assert.equal(tailExpected?.decisions[0]?.reason, 'expired');
    assert.equal(tailExpected?.decisions[0]?.eventId, 'a');
    assert.equal(tailExpected?.decisions[1]?.reason, 'completed');
    assert.equal(tailExpected?.decisions[1]?.actionId, 'd');
    assert.equal(tailExpected?.decisions[2]?.reason, 'started');
    assert.equal(tailExpected?.decisions[2]?.eventId, 'c');

    const cancel = exampleNamed('cancel');
    assert.equal(cancel.expected[3]?.decisions[0]?.reason, 'stale-completion');
    assert.equal(cancel.expected[3]?.decisions[0]?.eventId, null);
    assert.equal(cancel.expected[3]?.decisions[0]?.actionId, 'c1');
    assert.equal(cancel.expected[4]?.decisions[0]?.reason, 'completed');
    assert.equal(cancel.expected[4]?.decisions[0]?.actionId, 'c2');

    const duplicated = exampleNamed('duplicate');
    assert.equal(duplicated.expected[1]?.decisions[0]?.reason, 'duplicate');
    assert.equal(duplicated.expected[1]?.queueLength, 0);

    const reordered = exampleNamed('reordered');
    const late = reordered.inputs[0];
    const early = reordered.inputs[1];
    assert.ok(late?.type === 'deliver' && early?.type === 'deliver');
    if (late.type === 'deliver' && early.type === 'deliver') assert.ok(late.event.seq > early.event.seq);
    assert.equal(reordered.expected[1]?.decisions[0]?.reason, 'queued-same-rank');
    assert.equal(reordered.expected[2]?.decisions[1]?.eventId, 'early');

    const normal = exampleNamed('normal');
    assert.equal(normal.expected[1]?.queueLength, 1);
    assert.equal(normal.expected[1]?.decisions[0]?.reason, 'queued-lower-rank');
  });
});
