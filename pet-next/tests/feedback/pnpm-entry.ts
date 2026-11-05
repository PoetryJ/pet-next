/**
 * M3-7 A：跨平台 pnpm 入口解析（修复 WINDOWS-R1-REVIEW 第 23-28 行）。
 *
 * 根因：Windows 下没有可执行的 `pnpm` 文件，只有 pnpm.cmd/.ps1 包装器；
 * `spawn('pnpm')` 直接 ENOENT（.cmd 不是有效可执行格式，也不走 shell）。
 * 修法：统一改为「显式 Node + pnpm CLI 的 .cjs/.js 文件 argv」，
 * 两平台吃同一条路径，cwd/env/stdio 与退出码透传语义不变。
 *
 * 解析顺序：
 * 1. 环境变量 PET_NEXT_PNPM_CLI（指向 pnpm 的 .cjs/.js 文件；文件不存在直接报错，不静默回退）
 * 2. 项目内已知位置（tools/ 源码包布局与 node_modules/ 开发布局）
 * 3. 由当前 Node 可执行文件推导的全局安装（<prefix>/lib/node_modules/pnpm/bin/pnpm.cjs 等）
 * 4. 非 Windows 保留原 spawn('pnpm') 行为；Windows 明确报错并提示设置 PET_NEXT_PNPM_CLI
 *
 * 路径拼接一律按「目标平台」的规则做（platform === 'win32' 用 path.win32，其余用 path.posix），
 * 不用宿主 path：否则在 Windows 宿主上模拟 Unix 布局会拼出反斜杠，
 * 断言只能靠 skip 盖过去（REVIEW 第 23 行不许这么做）。
 *
 * 刻意不返回 '.cmd'/'.exe' 包装器：Windows 的 .cmd 无法被 spawn 直接拉起。
 * @module pet-next/tests/feedback/pnpm-entry
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 拉起 pnpm 命令所需的 command/args 前缀；调用方再拼 'chat:trial' 等参数。 */
export interface PnpmEntry {
  command: string;
  args: string[];
}

export interface PnpmEntryDeps {
  /** 文件存在性判断（单测注入）。 */
  exists?: (file: string) => boolean;
  /** 运行平台（单测注入 win32 验证 Windows 分支）。 */
  platform?: NodeJS.Platform;
  /** 环境变量快照（单测注入）。 */
  env?: Record<string, string | undefined>;
  /** 当前 Node 可执行文件路径（单测注入）。 */
  execPath?: string;
}

/** 项目内相对候选：源码包布局用 tools/，开发布局用 node_modules/。 */
const PROJECT_CLI_CANDIDATES = [
  'tools/node_modules/pnpm/bin/pnpm.cjs',
  'node_modules/pnpm/bin/pnpm.cjs',
  'node_modules/pnpm/bin/pnpm.js',
];

/** 目标平台的路径实现：只看目标平台，不看宿主。 */
function pathFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** 由 Node 可执行文件推导全局 pnpm CLI 的绝对路径候选（按目标平台规则拼接）。 */
function prefixCliCandidates(execPath: string, platform: NodeJS.Platform): string[] {
  const api = pathFor(platform);
  const execDir = api.dirname(execPath);
  return [
    // Windows/便携布局：<execDir>/node_modules/pnpm/bin/pnpm.cjs
    api.join(execDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    // Unix 全局布局：<prefix>/lib/node_modules/pnpm/bin/pnpm.cjs（execDir = <prefix>/bin）
    api.join(api.dirname(execDir), 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
  ];
}

/**
 * 解析 pnpm 入口。找不到 Windows 可用 CLI 文件时抛错（信息里给出可执行的下一步），
 * 不做「悄悄退回 spawn('pnpm')」这种在 Windows 必然失败的兜底。
 */
export function resolvePnpmEntry(petRoot: string, deps: PnpmEntryDeps = {}): PnpmEntry {
  const exists = deps.exists ?? existsSync;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const execPath = deps.execPath ?? process.execPath;
  const api = pathFor(platform);

  const explicit = env.PET_NEXT_PNPM_CLI?.trim();
  if (explicit) {
    if (!exists(explicit)) {
      throw new Error(
        `PET_NEXT_PNPM_CLI 指向的文件不存在：${explicit}。请指向 pnpm 的 .cjs/.js CLI 文件（不是 .cmd/.exe 包装器）。`,
      );
    }
    return { command: execPath, args: [explicit] };
  }

  for (const relative of PROJECT_CLI_CANDIDATES) {
    const file = api.join(petRoot, relative);
    if (exists(file)) return { command: execPath, args: [file] };
  }

  for (const file of prefixCliCandidates(execPath, platform)) {
    if (exists(file)) return { command: execPath, args: [file] };
  }

  if (platform === 'win32') {
    throw new Error(
      'Windows 下找不到 pnpm CLI 文件：请设置 PET_NEXT_PNPM_CLI 指向 pnpm 的 .cjs 文件（例如 tools/node_modules/pnpm/bin/pnpm.cjs），不要依赖 .cmd 包装器。',
    );
  }
  // 非 Windows：保留原行为（PATH 里的 pnpm 通常是可执行的 shell 脚本）。
  return { command: 'pnpm', args: [] };
}
