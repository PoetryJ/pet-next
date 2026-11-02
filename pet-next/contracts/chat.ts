/**
 * M3-0 文字对话预览的冻结接口：IPC 协议、Provider 形状与全队共用常量。
 * 由集成负责人冻结；改动需全员同步。core/chat 按边界规则自含同形状类型，不引用本文件。
 * 原理：纯状态机会话；Provider 是可替换适配器；请求 id 隔离取消后的迟到结果。
 * @module pet-next/contracts/chat
 */

/** 单条输入上限（字符）。所有层共用，超出即拒，不截断。 */
export const CHAT_MAX_INPUT_CHARS = 500;
/** 单次请求总超时（毫秒）。主进程计时，到点取消 Provider 并按 timeout 报告。 */
export const CHAT_TOTAL_TIMEOUT_MS = 15_000;
/** 回复文本上限（字符）。Provider 返回超出时截断到该长度。 */
export const CHAT_MAX_RESULT_CHARS = 2_000;
/** 请求 id 形状。渲染层生成，主进程校验。 */
export const CHAT_ID_PATTERN = /^chat-[a-z0-9-]{1,48}$/;

/** IPC：invoke 通道，页面 -> 主进程发送一条消息。 */
export const CHAT_SEND_CHANNEL = 'chat:send';
/** IPC：单向通道，页面 -> 主进程取消在途请求。 */
export const CHAT_CANCEL_CHANNEL = 'chat:cancel';

/** 预览开关：主进程环境变量存在且非空时，页面查询带 chat=preview 并挂载面板。 */
export const CHAT_PREVIEW_ENV = 'PET_NEXT_CHAT_PREVIEW';
/** 页面查询参数名。 */
export const CHAT_PREVIEW_QUERY = 'chat';
/** 预览令牌值。 */
export const CHAT_PREVIEW_TOKEN = 'preview';
/** 主进程环境变量：本地假服务地址（http://127.0.0.1:port）。未设置时面板发送立即报 provider-error。 */
export const CHAT_FAKE_URL_ENV = 'PET_NEXT_CHAT_FAKE_URL';

/* ===== M3-1：真实模型（Qwen）模式 =====
 * 冻结：Provider 接口、15s 总超时、单在途、取消隔离不变；只新增模式与只读展示信息。
 * 真实模式不静默降级为演示回复；页面永远拿不到地址与凭据。
 */

/** M3-1 运行模式：demo=fake 对照；local=连接现有 Qwen 服务。 */
export type ChatMode = 'demo' | 'local';
/** 页面查询参数中的 local 令牌。 */
export const CHAT_LOCAL_TOKEN = 'local';
/** 主进程环境变量：local 模式开关（真实服务）。与 CHAT_PREVIEW_ENV 互斥，同时设置时 local 优先并 warn。 */
export const CHAT_LOCAL_ENV = 'PET_NEXT_CHAT_LOCAL';
/** IPC：invoke 通道，页面获取只读展示信息（mode/model），不含地址与凭据。 */
export const CHAT_INFO_CHANNEL = 'chat:info';

/** 只读展示信息。demo 模式不给 model；local 模式给真实模型名。 */
export interface ChatDisplayInfo {
  mode: ChatMode;
  model?: string;
}

/** 真实服务配置环境变量（主进程读取）。 */
export const QWEN_BASE_URL_ENV = 'PET_NEXT_QWEN_BASE_URL';
export const QWEN_MODEL_ENV = 'PET_NEXT_QWEN_MODEL';
/** 已验证服务默认值（可在环境变量覆盖）。 */
export const QWEN_DEFAULT_BASE_URL = 'http://127.0.0.1:18872/v1';
export const QWEN_DEFAULT_MODEL = 'qwen3.8-27b';

/** 冻结请求参数：单轮、非流式、关闭 thinking。 */
export const QWEN_MAX_TOKENS = 96;
export const QWEN_TEMPERATURE = 0.2;
/** 冻结系统提示词。 */
export const QWEN_SYSTEM_PROMPT =
  '你是友善的桌面宠物，用一到两句简短中文自然回应，通常不超过80字。只做文字交流，不声称已执行提醒、打开软件等操作。';

/** 一次真实调用的主进程测量信息（不进渲染层；供验收脚本与日志）。 */
export interface QwenCallMeta {
  id: string;
  model: string;
  /** HTTP 状态；网络层失败时缺省。 */
  status?: number;
  /** 完整回复延迟（毫秒，请求发出到响应文本就绪）。 */
  latencyMs?: number;
  finishReason?: string;
  /** finish_reason === 'length'：界面按截断处理，不冒充完整回复。 */
  truncated?: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** 服务未给 usage 时为 true（不编造）。 */
  usageUnknown?: boolean;
  error?: string;
}

/** 真实模型 Provider：保留最近一次调用的测量信息，不改 core 返回文本的接口。 */
export interface QwenChatProvider extends ChatProvider {
  readonly model: string;
  readonly lastMeta: QwenCallMeta | null;
}

/** 错误码。empty/too-long 为输入校验；busy 为已有在途；timeout/provider-error 为链路；bad-request 为 IPC 载荷不合法。 */
export type ChatErrorCode = 'empty' | 'too-long' | 'busy' | 'timeout' | 'provider-error' | 'bad-request';

/** 页面提交的载荷。 */
export interface ChatSendRequest {
  id: string;
  text: string;
}

/** 发送结果。ok/cancelled/error 三态；text 仅 ok 时给出；code 仅 error 时给出。 */
export interface ChatSendResult {
  id: string;
  status: 'ok' | 'cancelled' | 'error';
  text?: string;
  code?: ChatErrorCode;
}

/** 可替换模型适配器。signal 触发后必须停止并 reject/短返回，不得继续占用。 */
export interface ChatProvider {
  complete(input: { id: string; text: string; signal: AbortSignal }): Promise<string>;
}
