/**
 * 播放状态判定：合法状态、终态与可上报集合，以及记录保留时长。
 *
 * 只回答「这个状态是什么、还能不能变」。
 * 必须始终成立：终态集合与可上报集合互斥，终态不可再变。
 * @module dsh-pet/src/host/playback/status
 */

/**
 * 播放回执（playback receipt）的纯逻辑层：播放记录表 + 状态机 + 等待者。
 *
 * 负责记录由渲染端上报驱动的状态：只有真正在播的那一端知道播完 / 失败 / 被打断。
 * 不猜：读视频时长再起定时器是错的——加载失败时根本没开始播，定时器却会照常走到「播完」。
 * 不负责 HTTP 与叶子写入；播放记录是每次点播各自的资源，不能塞进 1s 的全局广播。
 * 依赖无（单测能接管时钟），编号只保证一次运行内唯一。
 * 始终成立：终态不可再变、上报幂等；等待者被唤醒时也必须带回当时的记录。
 * 契约见 API.md 与 openapi.yaml。
 *
 * @module dsh-pet/src/host/playback
 */

/** 播放状态。accepted 由 host 写（受理），其余由渲染端上报。 */
export type PlaybackStatus = 'accepted' | 'playing' | 'ended' | 'failed' | 'cancelled';

/** 终态：到达后不可再变。 */
export const TERMINAL_STATUSES: readonly PlaybackStatus[] = ['ended', 'failed', 'cancelled'];

/** 渲染端允许上报的状态（accepted 是 host 的受理态，渲染端不许写）。 */
export const REPORTABLE_STATUSES: readonly PlaybackStatus[] = ['playing', 'ended', 'failed', 'cancelled'];

/** 终态记录保留时长（ms）：让调用方来得及查到最后状态，之后清理。 */
export const PLAYBACK_KEEP_MS = 60 * 1000;

/** `?timeout=` 上限（ms）：挂起等待的封顶时长，防止调用方把连接挂死。
 *  取值偏保守：DSH WebServer 是否对长期持有的响应设了空闲超时尚未核实，先压在 10s。 */
export const MAX_PLAYBACK_WAIT_MS = 10 * 1000;

/** 终态判定用集合。 */
const TERMINAL = new Set<string>(TERMINAL_STATUSES);

/** 可上报判定用集合。 */
const REPORTABLE = new Set<string>(REPORTABLE_STATUSES);

/** 该状态是不是终态。 */
export const isTerminalStatus = (s: string): boolean => TERMINAL.has(s);

/** 该字符串是不是合法状态名（含 host 侧的 accepted）——`?wait=` 的合法性校验用它。 */
export const isPlaybackStatus = (s: string): boolean => s === 'accepted' || REPORTABLE.has(s);

/** 该状态是否允许渲染端上报。 */
export const isReportableStatus = (s: string): boolean => REPORTABLE.has(s);
