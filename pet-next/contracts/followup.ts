/**
 * 跟进任务桌宠预览：公共契约（冻结于 final-demo 第 0.5 小时）。
 *
 * 角色：
 * - 宿主 host（Node 24 独立进程，experiments/task-followup/service/host.ts）唯一拥有 runtime/SQLite、
 *   结果目录 watcher、RealClock 调度、恢复与 HTTP API（只绑 127.0.0.1，带随机 token）。
 * - Electron 主进程（electron/followup-bridge.ts）只是客户端：启动/复用宿主、轮询概览、
 *   把“当前待决定 decision”推给桌宠页面、打开任务面板与受控报告查看窗。
 * - 任务面板（experiments/task-followup/demo/panel.html，由宿主提供）是客户端，状态全部来自宿主。
 * - 桌宠页面（app/followup-pet.ts）只显示入口/角标/气泡；它不能 present/answer。
 *
 * 不是通用 RPC：只有下面列出的端点与 IPC 通道。判断逻辑是本地规则原型（scripted-rule P3），
 * 不是模型理解。
 * @module pet-next/contracts/followup
 */

/** 预览开关：只有显式设置时 Electron 才装配跟进能力；默认 main 运行模式不变。 */
export const FOLLOWUP_PREVIEW_ENV = 'PET_FOLLOWUP_PREVIEW';
/** 宿主工作区（任务库、结果目录、产物都在其中）。 */
export const FOLLOWUP_WORKSPACE_ENV = 'PET_FOLLOWUP_WORKSPACE';
/** 运行宿主的 Node 24 可执行文件（启动入口已做版本预检）。 */
export const FOLLOWUP_NODE_ENV = 'PET_FOLLOWUP_NODE';
/** 有标识的短等待演示配置（RealClock，只缩短 minGap/wakeAfter；不改静默/阈值/冷却）。 */
export const FOLLOWUP_DEMO_WAIT_ENV = 'PET_FOLLOWUP_DEMO_SHORT_WAIT';
/** 页面查询参数：桌宠页面据此挂载跟进入口。 */
export const FOLLOWUP_QUERY = 'followup';

/** 宿主 → 父进程 IPC：就绪（同时在 stdout 打一行 `HOST_READY {json}`）。 */
export const HOST_READY_MESSAGE = 'pet-followup:host-ready';
/** 父进程 → 宿主 IPC：合作停止（沿用 R5.1 协议常量）。 */
export const HOST_STOP_REQUEST = 'pet-followup:stop';
/** 宿主 → 父进程 IPC：已保存并关闭 DB 的停止回执。 */
export const HOST_STOP_RECEIPT = 'pet-followup:service-stopped';
/** 宿主拒绝重复启动时的退出码（同一工作区已有存活宿主）。 */
export const HOST_DUPLICATE_EXIT = 9;
/** HTTP 鉴权头；面板页面 URL 以 `?token=` 携带同一 token。 */
export const HOST_TOKEN_HEADER = 'x-followup-token';

/** 宿主锁/状态文件：<workspace>/state/host.json */
export interface HostLock {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly workspace: string;
  readonly startedAt: string;
  readonly state: 'starting' | 'ready' | 'stopping' | 'stopped';
  readonly updatedAt: string;
}

export interface HostReady {
  readonly type: typeof HOST_READY_MESSAGE;
  readonly pid: number;
  readonly port: number;
  readonly token: string;
  readonly workspace: string;
  readonly reused?: boolean;
}

/** 唯一支持的任务模板。 */
export const FOLLOWUP_TEMPLATE = 'local-test-results' as const;
export type FollowupTemplate = typeof FOLLOWUP_TEMPLATE;

/** 面板分组（由宿主根据 runtime 状态计算，页面不自行推断）。 */
export type TaskBucket = 'waiting' | 'needs_decision' | 'done' | 'cancelled' | 'blocked';

/** 当前有效 decision（= runtime 的 open attention）。按钮必须带回 attentionId/decisionId/taskRevision。 */
export interface DecisionView {
  readonly attentionId: string;
  readonly decisionId: string;
  readonly taskRevision: number;
  readonly question: string;
  readonly options: readonly { readonly id: string; readonly label: string }[];
  readonly queuedAt: string | null;
  readonly deliveredAt: string | null;
  readonly presentedAt: string | null;
}

/** 产物引用：只能是该任务当前 analysis（artifacts/<ticketId>/ 下，SHA 与回执一致）。 */
export interface ReportRef {
  readonly path: string;
  readonly sha256: string;
  readonly receiptId: string | null;
  readonly verified: boolean;
}

export interface TaskView {
  readonly ticketId: string;
  readonly title: string;
  readonly goal: string;
  readonly template: FollowupTemplate | null;
  /** 绑定的结果目录（相对工作区）与绝对路径。 */
  readonly dir: string | null;
  readonly dirAbs: string | null;
  readonly status: 'active' | 'completed' | 'cancelled' | 'failed';
  readonly stage: string;
  readonly bucket: TaskBucket;
  readonly taskRevision: number;
  readonly result: {
    readonly runId: string;
    readonly revision: number;
    readonly status: string;
    readonly metrics: { readonly total: number; readonly passed: number; readonly failed: number };
    readonly resultPath: string | null;
    readonly resultFileSha: string;
  } | null;
  readonly decision: DecisionView | null;
  /** 问题已写库但仍在等待送达（例如静默时段）时的下一次唤醒。 */
  readonly nextWakeAt: string | null;
  readonly report: ReportRef | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastNote: string | null;
}

export interface Overview {
  readonly ok: true;
  readonly now: string;
  readonly pid: number;
  readonly workspace: string;
  readonly judgment: string;
  readonly demoConfig: string | null;
  readonly timezone: string;
  readonly tasks: readonly TaskView[];
  /** 需要用户决定的任务（bucket=needs_decision 且问题已送达），按送达时间排序。 */
  readonly pending: readonly { readonly ticketId: string; readonly title: string; readonly decision: DecisionView }[];
}

/**
 * HTTP 端点（全部需要 token；POST body 为 JSON）：
 *   GET  /panel?token=&ticket=          任务面板 HTML
 *   GET  /report-view?token=&ticket=    受控报告查看页（只读、HTML 转义）
 *   GET  /api/health                    {ok,pid,workspace,clock:'real',timezone,demoConfig}
 *   GET  /api/overview                  Overview
 *   GET  /api/task?ticket=              TaskView + diagnostics/notifications/wakeJobs（开发区）
 *   GET  /api/report?ticket=            ReportRef + content（只读当前任务受控文件）
 *   POST /api/tasks    {title,goal?,dir,template}   创建委托并绑定目录（自动开始观察）
 *   POST /api/answer   {ticketId,attentionId,decisionId,taskRevision,optionId}
 *   POST /api/cancel   {ticketId}
 *   POST /api/present  {ticketId,attentionId}   仅可见面板渲染出该问题时调用
 *   POST /api/pet-shown {ticketId,decisionId}   桌宠气泡显示日志（不算 present）
 *   POST /api/shutdown                          合作停止（复用宿主时由退出流程调用）
 */
export const FOLLOWUP_ENDPOINTS = [
  'GET /panel',
  'GET /report-view',
  'GET /api/health',
  'GET /api/overview',
  'GET /api/task',
  'GET /api/report',
  'POST /api/tasks',
  'POST /api/answer',
  'POST /api/cancel',
  'POST /api/present',
  'POST /api/pet-shown',
  'POST /api/shutdown',
] as const;

/** Electron IPC 通道（preload 内联镜像同名常量）。 */
export const FOLLOWUP_STATE_CHANNEL = 'followup:state';
export const FOLLOWUP_OPEN_PANEL_CHANNEL = 'followup:open-panel';
export const FOLLOWUP_SHOWN_CHANNEL = 'followup:shown';
export const FOLLOWUP_PICK_DIR_CHANNEL = 'followup:pick-dir';
export const FOLLOWUP_OPEN_REPORT_CHANNEL = 'followup:open-report';
export const FOLLOWUP_REVEAL_REPORT_CHANNEL = 'followup:reveal-report';
export const FOLLOWUP_QUIT_CHANNEL = 'followup:quit';

/** 主进程推给桌宠页面的最小状态。 */
export interface PetFollowupState {
  readonly connected: boolean;
  readonly error: string | null;
  readonly pendingCount: number;
  readonly activeCount: number;
  readonly top: { readonly ticketId: string; readonly title: string; readonly decisionId: string; readonly question: string } | null;
}
