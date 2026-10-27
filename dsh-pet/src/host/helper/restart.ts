/**
 * 重启策略：退避间隔、熔断条件与「跑稳了没有」的判定。
 *
 * 不启动也不停止进程，只给 ./child 提供纯计算的决策。
 * 必须始终成立：退避单调不减，熔断后不再自动重试。
 * @module dsh-pet/src/host/helper/restart
 */

/** 停止 helper 的等待上限（ms）：超过就升级 SIGKILL。 */
export const HELPER_STOP_TIMEOUT_MS = 3000;

/** SIGKILL 之后还给进程多久退出（ms）；到点仍未退出就放弃等待，绝不无限挂住调用方。 */
export const HELPER_STOP_GRACE_MS = 1000;

/** 稳定运行判定阈值：Helper 连续无崩溃运行 ≥ 3 分钟后，重启失败计数清零。 */
export const HELPER_STABLE_MS = 3 * 60 * 1000;

/**
 * 指数退避：第 n 次（0 起）失败后等待 base × 2ⁿ，封顶 30s。
 * 默认 base 750ms，序列 750 → 1500 → 3000 → … → 30000。
 */
export function restartBackoffDelayMs(consecutiveFailures: number, baseMs = 750): number {
  const MAX = 30_000;
  const raw = baseMs * 2 ** Math.max(0, consecutiveFailures);
  return Math.min(raw, MAX);
}

/** 熔断判定：连续崩溃 ≥ limit（默认 12，按默认退避累计约 3 分钟）次后不再自动重启。 */
export function shouldCircuitBreak(consecutiveFailures: number, limit = 12): boolean {
  return consecutiveFailures >= limit;
}

/** 稳定运行判定：距上次拉起 ≥ HELPER_STABLE_MS 视为一次「成功运行」，可清零计数。 */
export function helperRunIsStable(elapsedMs: number): boolean {
  return elapsedMs >= HELPER_STABLE_MS;
}

/** 退避基值（ms）：默认 750 与旧版首延一致，DSH_PET_RESTART_BASE_MS 可调。 */
export const RESTART_BASE_MS_DEFAULT = 750;

/** 熔断阈值（连续崩溃次数）：默认 12，DSH_PET_RESTART_MAX_FAILURES 可调。 */
export const RESTART_MAX_FAILURES_DEFAULT = 12;

/** 非负整数 env 解析（非法/未设回落默认），供重启参数读取共用。 */
export function envPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 等子进程真正退出：已经退出（exitCode / signalCode 有值）→ 立即 resolve，不挂监听；只等 `exit`，
 * `close` 只代表 stdio 管道关闭，远早于进程真正退出；到 timeoutMs 调 onTimeout()（调用方升级
 * SIGKILL），再给 HELPER_STOP_GRACE_MS 宽限；宽限到点仍未退出就 resolve——调用方绝不能被无限挂住。
 */
export function waitForChildExit(
  child: import('node:child_process').ChildProcess,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let giveUpTimer: NodeJS.Timeout | undefined;
    const done = (): void => {
      clearTimeout(killTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      child.removeListener('exit', done);
      resolve();
    };
    const killTimer = setTimeout(() => {
      onTimeout();
      giveUpTimer = setTimeout(done, HELPER_STOP_GRACE_MS);
      giveUpTimer.unref?.();
    }, timeoutMs);
    killTimer.unref?.();
    child.once('exit', done);
  });
}
