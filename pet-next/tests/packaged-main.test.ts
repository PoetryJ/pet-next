/**
 * M3-10 打包入口单元层：锁「先设 launcher 再动态 import main」这条唯一顺序约束。
 *
 * 为什么必须用源码/产物静态断言而不是运行时断言：main 的 launcher 分支在
 * `app.whenReady()` 回调里才读 env，静态 import 提前执行 main 模块体也照样能命中
 * ——运行时看起来一样，但约束已被破坏（main 顶层若新增 env 读取就会静默退回桌宠页）。
 * 因此这里直接比对「赋值下标 < 动态 import 下标」，并禁止静态 import main。
 * 产物断言在 dist 未构建时跳过（`pnpm build` 之后由 e2e / verify 覆盖）。
 * @module pet-next/tests/packaged-main
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const petRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourcePath = path.join(petRoot, 'electron/packaged-main.ts');
const bundlePath = path.join(petRoot, 'dist/electron/packaged-main.js');

/** 与 main 的 launcher 分支共用同一个常量（contracts/launcher.ts re-export）。 */
const MODE_ENV = 'PET_NEXT_LAUNCHER';

const read = (file: string): string => readFileSync(file, 'utf8');

/** 静态 import 才算违规：`import ... from './main'` / `import './main'`；`await import(` 是唯一允许形态。 */
function staticMainImport(text: string): string | null {
  const match = /^\s*import\s+(?:[^;]*?\s+from\s+)?['"]\.\/main(?:\.ts|\.js)?['"]/m.exec(text);
  return match === null ? null : match[0].trim();
}

test('源码：先写 LAUNCHER_MODE_ENV=1，再动态 import 既有 main', () => {
  const source = read(sourcePath);
  const assign = source.indexOf(`process.env[LAUNCHER_MODE_ENV] = '1'`);
  const dynamicImport = source.indexOf(`await import('./main.ts')`);
  assert.ok(assign >= 0, '源码必须给 LAUNCHER_MODE_ENV 赋 "1"');
  assert.ok(dynamicImport >= 0, "源码必须用 await import('./main.ts') 加载既有 main");
  assert.ok(assign < dynamicImport, `赋值必须早于动态 import（assign=${assign}, import=${dynamicImport}）`);
});

test('源码：不得静态 import main（会被提升到 env 赋值之前）', () => {
  const source = read(sourcePath);
  assert.equal(staticMainImport(source), null, '打包入口不得静态 import main');
  const staticImportCount = (source.match(/^\s*import\s/mg) ?? []).length;
  assert.equal(
    staticImportCount,
    1,
    `打包入口只允许 1 条静态 import（contracts 常量），实际 ${staticImportCount} 条`,
  );
});

test('源码：launcher 开关只认 contracts 的常量，不重写 main 的窗口/退出逻辑', () => {
  const source = read(sourcePath);
  assert.match(
    source,
    /import\s*\{\s*LAUNCHER_MODE_ENV\s*\}\s*from\s*'\.\.\/contracts\/launcher\.ts'/,
    'LAUNCHER_MODE_ENV 必须来自 contracts/launcher.ts（单一来源）',
  );
  for (const forbidden of ['new BrowserWindow', 'app.whenReady', 'app.on(', 'ipcMain', 'loadFile']) {
    assert.equal(source.includes(forbidden), false, `打包入口不得复制 main 的窗口/退出逻辑：${forbidden}`);
  }
  assert.equal(source.includes('process.cwd()'), false, '打包入口不得读 cwd 定位资源');
});

test('产物：dist/electron/packaged-main.js 与 main 同级且 import 路径重写为 ./main.js', (t) => {
  if (!existsSync(bundlePath)) {
    t.skip('未构建：先 pnpm build（并确认 tsconfig include 已含 electron/packaged-main.ts）');
    return;
  }
  const bundle = read(bundlePath);
  assert.ok(bundle.includes('await import("./main.js")'), '产物必须动态 import 同目录的 ./main.js');
  assert.equal(staticMainImport(bundle), null, '产物不得静态 import ./main.js');
  const assign = bundle.indexOf('process.env[LAUNCHER_MODE_ENV] = ');
  const dynamicImport = bundle.indexOf('await import("./main.js")');
  assert.ok(assign >= 0 && dynamicImport >= 0 && assign < dynamicImport, '产物里赋值必须先于动态 import');
  assert.equal(bundle.includes('new BrowserWindow'), false, '产物不得含窗口创建逻辑（仍只来自 main.js）');
  assert.ok(MODE_ENV === 'PET_NEXT_LAUNCHER', 'launcher 开关常量漂移');
});
