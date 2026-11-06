/** scripts/test-run-context.mjs 的类型声明（M3-8 B 最小共享接口）。 */

export interface RunContextOptions {
  /** kebab-case，会进入目录名，便于从日志回溯到用例。 */
  readonly label: string;
  /** 运行类别（unit / e2e / bench ...），决定临时根下的第一层目录。 */
  readonly kind: string;
  /** 应用根，只写进 meta.json 供证据回溯，不改变路径布局。 */
  readonly appRoot?: string;
}

export interface RunSnapshot {
  readonly label: string;
  readonly kind: string;
  readonly dir: string;
  readonly logDir: string;
  readonly createdAt: string;
  readonly ports: readonly number[];
  readonly paths: {
    readonly configPath: string;
    readonly modelLogPath: string;
    readonly sshLogPath: string;
  };
  readonly files: {
    readonly metaExists: boolean;
    readonly configBytes: number;
    readonly modelLogBytes: number;
    readonly sshLogBytes: number;
    readonly logFiles: readonly string[];
  };
  readonly meta: Record<string, unknown> | null;
}

export interface RunResidual {
  readonly label: string;
  readonly kind: string;
  readonly dir: string;
  readonly createdAt: string;
  readonly cleanedAt: string;
  /** 端口全部释放才算 ok；文件残留只记录，不判失败（日志本来就要留）。 */
  readonly ok: boolean;
  readonly ports: { readonly allocated: readonly number[]; readonly stillListening: readonly number[] };
  readonly files: RunSnapshot['files'];
  readonly notes: readonly string[];
  /** ok=false 时默认保留目录当证据。 */
  readonly dirKept: boolean;
}

export interface RunContext {
  readonly dir: string;
  readonly logDir: string;
  /** PET_NEXT_REMOTE_CONFIG 的目标路径。 */
  readonly configPath: string;
  /** FAKE_MODEL_LOG 的目标路径。 */
  readonly modelLogPath: string;
  /** FAKE_SSH_LOG 的目标路径。 */
  readonly sshLogPath: string;
  /** 取一个空闲回环端口并登记，供本次运行的调试端口/隧道端口使用。 */
  freePort(): Promise<number>;
  /** 本次运行的子进程环境；不继承 NODE_OPTIONS，extra 可覆盖。 */
  env(extra?: Record<string, string | undefined>): Record<string, string | undefined>;
  snapshot(): RunSnapshot;
  /** 先算残留断言（写 residual.json 并返回），再只清本轮目录；ok=false 时默认保留目录。 */
  cleanup(options?: { keepDir?: boolean }): Promise<RunResidual>;
}

export function createRunContext(options: RunContextOptions): RunContext;

export interface OwnXvfb {
  /** 形如 ":120"，可直接给 DISPLAY。 */
  readonly display: string;
  /** /tmp/.X11-unix/X<n>。 */
  readonly socket: string;
  readonly pid: number | undefined;
  /** 只停本次启动的 Xvfb（按 pid），不按名字批量 kill。 */
  stop(): Promise<{ stopped: boolean; signal: string | null }>;
}

export function startOwnXvfb(options: { label: string }): Promise<OwnXvfb>;
