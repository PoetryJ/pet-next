/**
 * 对照 `pnpm verify` 实际会启动的文件，找出没有任何入口会跑到的测试。
 * 不修改 `scripts/unit-tests.mjs`。漏掉的路径交给集成。
 * @module pet-next/tests/contracts/verify-reach
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const skipDirs = new Set(['node_modules', 'dist', 'out', 'logs', 'coverage']);

export interface VerifyReach {
  /** 仓库里现有的测试，相对 `pet-next`。 */
  found: readonly string[];
  /** 单元测试、e2e glob 或素材套件都不会执行的测试。 */
  missed: readonly string[];
  unitRoots: readonly string[];
}

/** 按当前脚本规则收集会跑到的测试，并列出漏掉的。 */
export async function verifyReach(petRoot: string): Promise<VerifyReach> {
  const unitSource = await readFile(path.join(petRoot, 'scripts/unit-tests.mjs'), 'utf8');
  const rootsMatch = unitSource.match(/const roots = \[([^\]]*)\]/);
  const rootsBody = rootsMatch?.[1];
  if (!rootsBody) throw new Error('无法从 scripts/unit-tests.mjs 读出测试根目录');
  const unitRoots = [...rootsBody.matchAll(/'([^']+)'/g)].flatMap((match) => (match[1] ? [match[1]] : []));

  const pkg = JSON.parse(await readFile(path.join(petRoot, 'package.json'), 'utf8')) as {
    scripts?: { 'test:e2e'?: string };
  };
  const e2eScript = pkg.scripts?.['test:e2e'];
  if (!e2eScript) throw new Error('package.json 没有 test:e2e');
  const e2eArgs = e2eScript.split(/\s+/).filter((part) => part.includes('/') || part.endsWith('.ts'));

  const suite = await readFile(path.join(petRoot, 'tests/assets/unit-suite.test.ts'), 'utf8');
  const pipelineFiles = [...suite.matchAll(/'([^']+\.test\.ts)'/g)].flatMap((match) => (match[1] ? [match[1]] : []));

  const found: string[] = [];
  await walk(petRoot, petRoot, found);
  found.sort();
  const missed = found.filter((rel) => !isReached(rel, unitRoots, e2eArgs, pipelineFiles));
  return { found, missed, unitRoots };
}

function isReached(
  rel: string,
  unitRoots: readonly string[],
  e2eArgs: readonly string[],
  pipelineFiles: readonly string[],
): boolean {
  if (rel.endsWith('.test.ts') && !rel.endsWith('.e2e.test.ts')) {
    if (unitRoots.some((root) => rel === root || rel.startsWith(`${root}/`))) return true;
  }
  if (e2eArgs.some((pattern) => matchArg(pattern, rel))) return true;
  return pipelineFiles.some((name) => rel === `assets-pipeline/${name}`);
}

function matchArg(pattern: string, rel: string): boolean {
  if (!pattern.includes('*')) return pattern === rel;
  const body = pattern.split('*').map(escapeRegex).join('[^/]*');
  return new RegExp(`^${body}$`).test(rel);
}

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, root, out);
      continue;
    }
    if (!entry.name.endsWith('.test.ts')) continue;
    out.push(path.relative(root, full).split(path.sep).join('/'));
  }
}
