#!/usr/bin/env node
/**
 * M3-10：Windows x64 便携包构建（构建端工具，用户端不需要 Node/pnpm）。
 *
 *   pnpm package:portable --platform=win32 --arch=x64
 *
 * 流程：现有 build → 最小运行闭包 staging → 固定 @electron/packager 20.3.0 + Electron 43.3.0
 *      → asar=false 目录 → ZIP + manifest（Git SHA/版本/逐文件 SHA/ZIP SHA）。
 *
 * 只在构建机运行；不访问模型、不发 HTTP、不调用 18872。
 * @module pet-next/scripts/package-portable
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const petRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(petRoot, '..');

/** dist 下允许进入运行包的白名单；tests/experiments/assets-pipeline 属开发内容。 */
export const RUNTIME_DIRS = ['adapters', 'core', 'contracts', 'electron', 'app', 'assets'];
/** 任何层级出现这些目录/后缀都视为泄漏，构建直接失败。 */
export const FORBIDDEN_SEGMENTS = new Set(['node_modules', 'tests', 'bench', 'chat-evidence', 'experiments', 'assets-pipeline', '.git']);
const FORBIDDEN_FILE = /(^|\/)(\.env($|\.)|id_rsa|known_hosts)|\.(pem|key)$/;

/**
 * 是否禁止进入 staging（相对 dist 的 POSIX 路径）。
 * @param {string} rel
 * @returns {boolean}
 */
export function isForbiddenStagingPath(rel) {
  const parts = rel.split('/');
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) return true;
  if (FORBIDDEN_FILE.test(rel)) return true;
  // 测试产物与 source map 不是运行时依赖。
  if (/\.test\.js(\.map)?$/.test(rel)) return true;
  if (/\.map$/.test(rel)) return true;
  return false;
}

function value(name, fallback) {
  const hit = process.argv.slice(2).find((item) => item.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

const platform = value('platform', 'win32');
const arch = value('arch', 'x64');
const outDir = path.resolve(value('out', path.join(repoRoot, 'dist-portable')));
const electronZipDir = path.resolve(
  value('electron-zip-dir', process.env.PET_NEXT_ELECTRON_ZIP_DIR ?? path.join(repoRoot, '.cache', 'electron')),
);
const electronVersion = '43.3.0';
const packagerVersion = '20.3.0';
const zipName = `PetNext-${platform}-${arch}`;

if (platform !== 'win32' || arch !== 'x64') {
  console.error(`本轮只支持 win32/x64，收到 ${platform}/${arch}`);
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: petRoot,
    env: { ...process.env, NODE_OPTIONS: '' },
    encoding: 'utf8',
    timeout: options.timeout ?? 900_000,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} 失败（exit=${String(result.status)}）\nstdout:${result.stdout ?? ''}\nstderr:${result.stderr ?? ''}`,
    );
  }
  return result;
}

function runPnpm(args) {
  const cli = process.env.PET_NEXT_PNPM_CLI
    ?? [path.join(petRoot, 'node_modules/pnpm/bin/pnpm.cjs'), path.join(petRoot, 'tools/node_modules/pnpm/bin/pnpm.cjs')].find((file) => existsSync(file));
  if (cli !== undefined) return run(process.execPath, [cli, ...args]);
  return run('pnpm', args);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** 复制 dist 的最小运行闭包并返回文件清单；禁止项直接抛错。 */
export async function stageRuntime(stageDir, distDir) {
  const copied = [];
  for (const dirName of RUNTIME_DIRS) {
    const source = path.join(distDir, dirName);
    if (!existsSync(source)) throw new Error(`缺少 dist/${dirName}（先 pnpm build）`);
    const files = await walk(source);
    for (const rel of files) {
      const fromDist = `${dirName}/${rel}`;
      if (isForbiddenStagingPath(fromDist)) continue;
      const target = path.join(stageDir, 'dist', dirName, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(source, rel), target);
      copied.push(`dist/${fromDist}`);
    }
  }
  return copied.sort();
}

async function main() {
  const started = Date.now();
  await mkdir(outDir, { recursive: true });
  const staging = path.join(outDir, 'staging');
  const rawOut = path.join(outDir, 'raw');
  await rm(staging, { recursive: true, force: true });
  await rm(rawOut, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  // 1) 现有 build（含 packaged-main；缺文件直接失败）。
  runPnpm(['build']);
  if (!existsSync(path.join(petRoot, 'dist/electron/packaged-main.js'))) {
    throw new Error('dist/electron/packaged-main.js 不存在：先合入 B 的便携入口并 build');
  }

  // 2) 最小运行闭包。
  const staged = await stageRuntime(staging, path.join(petRoot, 'dist'));
  const pkg = JSON.parse(await readFile(path.join(petRoot, 'package.json'), 'utf8'));
  const stagePackage = {
    name: 'pet-next',
    productName: 'PetNext',
    version: pkg.version,
    private: true,
    description: '单宠物、单屏的透明置顶桌宠（Windows x64 便携试用版）。',
    type: 'module',
    main: 'dist/electron/packaged-main.js',
    license: 'MIT',
    author: 'PC2005-cloud',
    maintainer: 'PoetryJ',
  };
  await writeFile(path.join(staging, 'package.json'), `${JSON.stringify(stagePackage, null, 2)}\n`);
  for (const name of ['LICENSE', 'README.md']) {
    const source = path.join(petRoot, name);
    if (!existsSync(source)) throw new Error(`缺少 ${name}（保留 MIT/原作者归属）`);
    await cp(source, path.join(staging, name));
  }
  // 双保险：staging 内不得出现禁止项（含包内历史残留）。
  for (const rel of await walk(staging)) {
    if (isForbiddenStagingPath(rel)) throw new Error(`staging 泄漏禁止项：${rel}`);
  }

  // 3) 固定版本 packager（asar=false；Windows ZIP 来自已校验缓存）。
  const zipPath = path.join(electronZipDir, `electron-v${electronVersion}-win32-x64.zip`);
  if (!existsSync(zipPath)) throw new Error(`缺少 Windows Electron ZIP：${zipPath}`);
  const zipSha = sha256(await readFile(zipPath));
  const sumsFile = path.join(electronZipDir, 'SHASUMS256.txt');
  if (existsSync(sumsFile)) {
    const line = (await readFile(sumsFile, 'utf8'))
      .split('\n')
      .find((item) => item.includes(`electron-v${electronVersion}-win32-x64.zip`));
    if (line === undefined || !line.includes(zipSha)) {
      throw new Error(`Windows Electron ZIP SHA 校验失败：${zipSha}`);
    }
  }
  const [packagedDir] = await packager({
    dir: staging,
    out: rawOut,
    name: 'PetNext',
    platform,
    arch,
    electronVersion,
    electronZipDir,
    asar: false,
    overwrite: true,
    prune: false,
    appVersion: pkg.version,
    buildVersion: pkg.version,
    win32metadata: {
      CompanyName: 'PoetryJ',
      FileDescription: 'PetNext',
      ProductName: 'PetNext',
      OriginalFilename: 'PetNext.exe',
      InternalName: 'PetNext',
    },
  });
  if (packagedDir === undefined || !existsSync(path.join(packagedDir, 'PetNext.exe'))) {
    throw new Error(`packager 未产出 PetNext.exe：${String(packagedDir)}`);
  }

  // 4) ZIP（构建端 python3，不进入用户运行时）。
  const zipFile = path.join(outDir, `${zipName}.zip`);
  await rm(zipFile, { force: true });
  const top = path.basename(packagedDir);
  run('python3', ['-c', `
import os, sys, zipfile
root, out, top = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root)
            z.write(full, os.path.join(top, rel))
`, packagedDir, zipFile, top]);

  const files = (await walk(packagedDir)).sort();
  const manifest = {
    schema: 'pet-next-portable-manifest/1',
    gitSha: run('git', ['rev-parse', 'HEAD']).stdout.trim(),
    builtAt: new Date().toISOString(),
    platform,
    arch,
    name: 'PetNext',
    appVersion: pkg.version,
    electronVersion,
    packagerVersion,
    asar: false,
    electronZip: { file: zipPath, sha256: zipSha, bytes: (await stat(zipPath)).size },
    staging: { entries: staged.length, files: staged },
    package: { entries: files.length, bytes: (await Promise.all(files.map(async (rel) => (await stat(path.join(packagedDir, rel))).size))).reduce((a, b) => a + b, 0) },
    zip: { file: path.basename(zipFile), bytes: (await stat(zipFile)).size, sha256: sha256(await readFile(zipFile)) },
    files: await Promise.all(files.map(async (rel) => ({ path: `${top}/${rel}`, bytes: (await stat(path.join(packagedDir, rel))).size, sha256: sha256(await readFile(path.join(packagedDir, rel))) }))),
    buildSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
    notes: '构建端产物；用户运行端不需要 Node/pnpm/源码。SSH 模式仍依赖系统 OpenSSH 与用户凭据。',
  };
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    event: 'portable-built',
    zip: zipFile,
    zipSha256: manifest.zip.sha256,
    zipBytes: manifest.zip.bytes,
    entries: manifest.package.entries,
    buildSeconds: manifest.buildSeconds,
  }));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(`[package-portable] 失败：${String(error)}`);
    process.exit(1);
  }
}
