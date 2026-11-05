/**
 * scripts/launch-trial.mjs 的类型声明。
 * 用途：tests/** 在 tsconfig include 内会被 tsc 检查；从 .ts import 相对 .mjs 时
 * 由本声明提供类型（node 运行时忽略本文件）。与实现保持同步，形状见 tests/launcher/。
 */

/** 与 contracts/launcher.ts LAUNCHER_MODE_ENV 一致（单测锁漂移）。 */
export declare const LAUNCHER_MODE_ENV: string;
/** pet-next 根目录（scripts/ 的上一级）。 */
export declare const PET_ROOT: string;
/** 最低 Node 版本（22.12，与 package.json engines 对齐）。 */
export declare const MIN_NODE: { major: number; minor: number };
/** 构建缺失时的统一提示文案。 */
export declare const NO_BUILD_HINT: string;

/** Node 版本检查：通过返回 null；否则返回可读中文错误。 */
export declare function nodeVersionProblem(nodeVersion?: string): string | null;

/** Electron 参数（Linux 附 --no-sandbox --disable-dev-shm-usage，末位是 main.js）。 */
export declare function buildLauncherArgs(platform: string, mainPath: string): string[];

/** 解析 electron 可执行文件（createRequire('electron')）。 */
export declare function resolveElectron(petRoot?: string): string;

/** 子进程句柄（单测注入假 spawn 时只需 on/error/exit 形状）。 */
export interface LaunchChild {
  on(event: string, listener: (...args: never[]) => void): LaunchChild;
}

export interface LaunchTrialOptions {
  /** 缺省 process.versions.node；单测注入低版本字符串。 */
  nodeVersion?: string;
  /** 缺省 process.platform；单测注入 'linux'/'win32'。 */
  platform?: string;
  petRoot?: string;
  /** 注入假 electron 路径；缺省走 resolveElectron(petRoot)。 */
  electronPath?: string | null;
  /** 注入假 spawn（返回带 on('error'/'exit') 的假子进程）。 */
  spawn?: (command: string, args: string[], options: { stdio: string; env: NodeJS.ProcessEnv }) => LaunchChild;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  logError?: (line: string) => void;
  exists?: (file: string) => boolean;
  /** 子进程被信号结束时调用；缺省对自己发同一信号。 */
  onChildSignal?: (signal: string) => void;
}

/** 跑一次双击入口；返回退出码（不直接 process.exit）。 */
export declare function runLaunchTrial(options?: LaunchTrialOptions): Promise<number>;
