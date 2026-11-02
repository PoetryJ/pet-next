/**
 * M3-1 主进程真实服务（Qwen）配置：解析地址/模型，并在接线前探测服务可用性。
 *
 * 边界：
 * - 地址只允许 loopback（http/https），拒绝 0.0.0.0 与外网地址，也拒绝 URL 里带凭据；
 * - 配置非法或服务不可用一律返回显式错误，绝不静默降级成演示回复；
 * - 本模块不引用 electron，可在纯 node 单测里直接跑；探测的 fetch 一律可注入。
 * @module pet-next/electron/chat-config
 */
import {
  QWEN_BASE_URL_ENV,
  QWEN_DEFAULT_BASE_URL,
  QWEN_DEFAULT_MODEL,
  QWEN_MODEL_ENV,
} from '../contracts/chat.ts';

/** 真实服务配置：baseUrl 不带尾部斜杠，model 已去空白。 */
export interface QwenConfig {
  baseUrl: string;
  model: string;
}

/** 解析结果：要么拿到配置，要么拿到可读错误。 */
export type QwenConfigResult =
  | { ok: true; config: QwenConfig }
  | { ok: false; error: string };

/** 探测结果：失败时尽量带上服务实际提供的模型列表，便于定位。 */
export type QwenProbeResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string; models?: string[] };

/** fetch 响应的最小形状：单测注入假响应即可，不依赖 undici/DOM 具体实现。 */
export interface QwenHttpResponse {
  status?: number;
  ok?: boolean;
  json?: () => Promise<unknown>;
}

/** 可注入的 fetch 形状。 */
export type QwenFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<QwenHttpResponse>;

/** 探测超时：服务未起来时快速失败，不让入口干等。 */
export const QWEN_PROBE_TIMEOUT_MS = 5_000;

/** loopback 主机名白名单（URL.parse 后 IPv6 主机名带方括号）。 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 环境变量缺失（undefined 或键不存在）走默认值；显式给了空串则按非法处理，不偷偷兜底。 */
function readOptional(env: Record<string, string | undefined>, name: string): { given: boolean; text: string } {
  const raw = env[name];
  if (raw === undefined) return { given: false, text: '' };
  return { given: true, text: raw.trim() };
}

type BaseUrlResult = { ok: true; baseUrl: string } | { ok: false; error: string };

function parseBaseUrl(env: Record<string, string | undefined>): BaseUrlResult {
  const read = readOptional(env, QWEN_BASE_URL_ENV);
  if (!read.given) return { ok: true, baseUrl: QWEN_DEFAULT_BASE_URL };
  if (read.text === '') return { ok: false, error: `${QWEN_BASE_URL_ENV} 为空` };

  let url: URL;
  try {
    url = new URL(read.text);
  } catch {
    return { ok: false, error: `${QWEN_BASE_URL_ENV} 不是合法 URL：${read.text}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `${QWEN_BASE_URL_ENV} 只支持 http/https，收到 ${url.protocol}` };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: `${QWEN_BASE_URL_ENV} 不允许包含凭据` };
  }
  if (!isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      error: `${QWEN_BASE_URL_ENV} 必须是本机 loopback（127.0.0.1 / localhost / [::1]），收到 ${url.hostname}`,
    };
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, error: `${QWEN_BASE_URL_ENV} 不能带查询串或片段：${read.text}` };
  }
  // 统一去尾部斜杠，保证 `${baseUrl}/models` 不会出现双斜杠。
  return { ok: true, baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/**
 * 读 QWEN_BASE_URL_ENV / QWEN_MODEL_ENV 得到真实服务配置。
 * @param env 进程环境（单测注入普通对象）
 */
export function resolveQwenConfig(env: Record<string, string | undefined>): QwenConfigResult {
  const base = parseBaseUrl(env);
  if (!base.ok) return base;

  const modelRead = readOptional(env, QWEN_MODEL_ENV);
  if (!modelRead.given) return { ok: true, config: { baseUrl: base.baseUrl, model: QWEN_DEFAULT_MODEL } };
  if (modelRead.text === '') return { ok: false, error: `${QWEN_MODEL_ENV} 为空` };
  return { ok: true, config: { baseUrl: base.baseUrl, model: modelRead.text } };
}

/** 从 `/models` 响应体里取模型 id 列表；形状不对就给空数组（不编造）。 */
function modelIdsOf(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

/**
 * 启动前探测：GET `${baseUrl}/models`，要求 200 且列表里含配置的 model id。
 * 网络错误、非 200、缺模型都返回 ok:false 与明确 error，由调用方给出可读提示后非零退出。
 */
export async function probeQwenService(
  config: QwenConfig,
  fetchImpl: QwenFetch = (url, init) => fetch(url, init),
  timeoutMs: number = QWEN_PROBE_TIMEOUT_MS,
): Promise<QwenProbeResult> {
  const url = `${config.baseUrl}/models`;
  let response: QwenHttpResponse;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, error: `无法连接 ${config.baseUrl}：${messageOf(error)}` };
  }

  const status = typeof response?.status === 'number' ? response.status : undefined;
  if (status !== 200) {
    return { ok: false, error: `${url} 返回 ${status === undefined ? '未知状态' : String(status)}` };
  }

  let body: unknown;
  try {
    body = typeof response.json === 'function' ? await response.json() : undefined;
  } catch (error) {
    return { ok: false, error: `${url} 响应不是合法 JSON：${messageOf(error)}` };
  }

  const models = modelIdsOf(body);
  if (!models.includes(config.model)) {
    const available = models.length > 0 ? models.join(', ') : '空';
    return { ok: false, error: `服务未提供模型 ${config.model}（可用：${available}）`, models };
  }
  return { ok: true, models };
}
