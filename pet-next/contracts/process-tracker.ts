/**
 * 测试进程树的跟踪与清理契约。实现放在 `tests/runner`，由 Agent A 编写。
 * 不负责窗口、素材或仲裁。默认启动路径不引用本模块。
 * 一次 `start` 只跟踪它返回的那棵树。日志保留命令、覆盖环境、退出码和原始输出。
 * @module pet-next/contracts/process-tracker
 */

/** 本轮要留下记录的平台。 */
export const REQUIRED_PLATFORMS = ['linux', 'win32'] as const;

/** 进程清理必须覆盖的用例名。 */
export const REQUIRED_PROCESS_CASES = ['spawn-failure', 'timeout', 'clean-exit', 'foreign-pid-survives'] as const;

export type PlatformStatus = 'passed' | 'failed' | 'not-run';

export interface TrackedCommand {
  command: string;
  args: readonly string[];
  cwd: string;
  /**
   * 环境覆盖项。日志只可写入这些键。
   * 值会原样进入日志，调用方不要把密钥放进来。
   */
  env: Readonly<Record<string, string>>;
  /** 超时，毫秒，有限且大于 0。到点后跟踪器结束进程树，并把 `timedOut` 记为 true。 */
  timeoutMs: number;
}

export interface TrackedProcess {
  /** 无法启动时为 null。 */
  readonly pid: number | null;
  readonly command: TrackedCommand;
  /** 调用 `start` 的时刻，毫秒。 */
  readonly startedAtMs: number;
  /** 自然退出、超时或 `dispose` 完成时 resolve，重复等待得到同一次结果。 */
  readonly finished: Promise<ProcessRunLog>;
}

export interface ProcessRunLog {
  platform: NodeJS.Platform;
  command: string;
  args: readonly string[];
  cwd: string;
  /** 只含 {@link TrackedCommand.env}。 */
  env: Readonly<Record<string, string>>;
  /** 进程是否曾经启动。可执行文件不存在时为 false。 */
  started: boolean;
  pid: number | null;
  startedAtMs: number;
  finishedAtMs: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** 实际发送过结束信号的 pid，只应来自这棵树。 */
  signaledPids: readonly number[];
}

export interface ProcessTracker {
  /**
   * 启动并跟踪一棵新进程树。
   *
   * @param command - 可执行文件、参数、工作目录、环境覆盖和超时。
   * @returns 已跟踪的进程。无法启动时 `pid` 为 null，`finished` 已经完成。
   * @throws {TypeError} `timeoutMs` 不是有限正数时。
   */
  start(command: TrackedCommand): Promise<TrackedProcess>;
  /**
   * 结束这棵进程树并返回同一次日志。
   *
   * @param tracked - `start` 返回的对象。
   * @returns 与 `tracked.finished` 相同的结果。重复调用不再发信号。
   */
  dispose(tracked: TrackedProcess): Promise<ProcessRunLog>;
}

export interface PlatformMatrixEntry {
  platform: (typeof REQUIRED_PLATFORMS)[number];
  caseId: (typeof REQUIRED_PROCESS_CASES)[number];
  status: PlatformStatus;
  /** `passed` 时为 null。`not-run` 时写明缺执行器或未跑。 */
  reason: string | null;
  command: string;
  exitCode: number | null;
  /** 相对 `pet-next` 的原始日志或一键脚本路径。 */
  evidencePath: string;
}
