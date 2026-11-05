/**
 * M3-7 D：源码试用包双击入口（启动.cmd -> node scripts/launch-trial.mjs）。
 * 薄入口，只做三件事：预检（Node 版本 / 构建产物）、设置 PET_NEXT_LAUNCHER=1、
 * spawn Electron（electron 路径解析与 scripts/start.mjs 同方式；Linux 附
 * --no-sandbox --disable-dev-shm-usage；stdio inherit；退出码/信号透传）。
 * 边界：不自动下载 Node、不代替构建（缺产物提示用户跑 pnpm install && pnpm build）、
 * 不设 ELECTRON_RUN_AS_NODE、不动 GPU 开关、不后台常驻。
 * 全部 IO 可注入，单测见 tests/launcher/launch-trial.test.ts。
 * 运行：node scripts/launch-trial.mjs（双击 启动.cmd 等价命令）。
 * @module pet-next/scripts/launch-trial
 */
import { spawn as realSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 契约镜像：contracts/launcher.ts 的 LAUNCHER_MODE_ENV（launch-trial 由 cmd 直接用
 * node 运行，无 --experimental-strip-types，不能 import .ts）。tests/launcher/ 单测锁漂移。
 */
export const LAUNCHER_MODE_ENV = 'PET_NEXT_LAUNCHER';

/** 与 package.json engines / scripts/chat-remote-core.mjs MIN_NODE 对齐。 */
export const MIN_NODE = { major: 22, minor: 12 };

/** 构建缺失的统一提示：入口不代替构建，避免隐藏 pnpm build。 */
export const NO_BUILD_HINT = '请先在终端运行 pnpm install && pnpm build，然后重新双击启动';

/** Node 版本检查：通过返回 null；否则返回可读中文错误（不自动下载任何东西）。 */
export function nodeVersionProblem(nodeVersion = process.versions.node) {
  const [majorText, minorText] = String(nodeVersion).split('.');
  const major = Number(majorText);
  const minor = Number(minorText ?? 0);
  const tooLow =
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < MIN_NODE.major ||
    (major === MIN_NODE.major && minor < MIN_NODE.minor);
  if (!tooLow) return null;
  return `Node 版本过低（${nodeVersion}），需要 ${MIN_NODE.major}.${MIN_NODE.minor} 或更新；` +
    '请到 https://nodejs.org 安装后重试（本入口不会自动下载）';
}

/**
 * Electron 参数：Linux 容器无用户命名空间时附 --no-sandbox（同 scripts/start.mjs）。
 * PET_NEXT_CHAT_DEBUG_PORT 是数字时追加 --remote-debugging-port（与 scripts/chat-local-core.mjs
 * 的 e2e 调试约定一致；缺省不追加，不影响普通双击）。
 */
export function buildLauncherArgs(platform, mainPath, debugPort = null) {
  const args = [];
  if (platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
  if (debugPort !== null) args.push(`--remote-debugging-port=${debugPort}`);
  args.push(mainPath);
  return args;
}

/** 调试端口解析：空/非法返回 null（非法值忽略，不阻断启动，不退出）。 */
export function resolveDebugPort(raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (text === '') return null;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** 解析 electron 可执行文件（与 chat-demo-core.mjs resolveElectronPath 同方式）。 */
export function resolveElectron(petRoot = PET_ROOT) {
  const require = createRequire(path.join(petRoot, 'package.json'));
  const resolved = require('electron');
  if (typeof resolved !== 'string' || resolved.length === 0) {
    throw new Error(`electron 可执行文件解析失败：require('electron') 返回 ${String(resolved)}`);
  }
  return resolved;
}

/**
 * 跑一次双击入口。返回退出码（不直接 process.exit，便于单测）。
 * @param {object} [options] 全部可注入（单测给假 spawn/假 fs/假版本号，不真起 Electron）
 * @returns {Promise<number>}
 */
export async function runLaunchTrial(options = {}) {
  const {
    nodeVersion = process.versions.node,
    platform = process.platform,
    petRoot = PET_ROOT,
    electronPath = null,
    spawn = realSpawn,
    env = process.env,
    log = (line) => console.log(line),
    logError = (line) => console.error(line),
    exists = (file) => existsSync(file),
    /** 子进程被信号结束时透传（默认自signal；单测注入记录器）。 */
    onChildSignal = (signal) => process.kill(process.pid, signal),
  } = options;

  // 1) Node 版本预检：可读中文错误 + 非零退出，不自动下载。
  const versionProblem = nodeVersionProblem(nodeVersion);
  if (versionProblem !== null) {
    logError(`[launch-trial] ${versionProblem}`);
    return 1;
  }

  // 2) 构建产物预检：源码试用定位允许缺失，但必须提示用户自己构建。
  const mainPath = path.join(petRoot, 'dist/electron/main.js');
  if (!exists(mainPath)) {
    logError(`[launch-trial] 缺少构建产物 ${path.relative(petRoot, mainPath)}：${NO_BUILD_HINT}`);
    return 1;
  }

  // 3) 解析 Electron（依赖未安装时报可操作错误，不抛栈）。
  let electron = electronPath;
  if (electron === null) {
    try {
      electron = resolveElectron(petRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(`[launch-trial] 依赖未安装（${message}）：${NO_BUILD_HINT}`);
      return 1;
    }
  }

  // 4) launcher 模式开关 + spawn；唯一新增 env 是 PET_NEXT_LAUNCHER=1。
  //    ELECTRON_RUN_AS_NODE 是外部残留时会让 Electron 退化成 node，显式清掉（除此之外不动）。
  const childEnv = { ...env, [LAUNCHER_MODE_ENV]: '1' };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const debugPort = resolveDebugPort(env.PET_NEXT_CHAT_DEBUG_PORT);
  if (debugPort === null && String(env.PET_NEXT_CHAT_DEBUG_PORT ?? '').trim() !== '') {
    log(`[launch-trial] 忽略非法 PET_NEXT_CHAT_DEBUG_PORT=${String(env.PET_NEXT_CHAT_DEBUG_PORT)}`);
  }
  const args = buildLauncherArgs(platform, mainPath, debugPort);
  log(`[launch-trial] 启动 ${path.relative(petRoot, mainPath)}（launcher 模式，首次启动配置向导）`);
  const child = spawn(electron, args, { stdio: 'inherit', env: childEnv });
  return await new Promise((resolve) => {
    child.on('error', (error) => {
      logError(`[launch-trial] Electron 启动失败：${error instanceof Error ? error.message : String(error)}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) onChildSignal(signal);
      resolve(code ?? 0);
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) process.exit(await runLaunchTrial());
