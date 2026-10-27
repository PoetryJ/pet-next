/**
 * 服务工厂：把本地模型配置与传输层拼成 StandaloneAiService。
 *
 * 不解析请求（归 ./request），不定义限额（归 ./limits）。
 * 必须始终成立：速率限制按窗口计数，超限直接拒绝而不是排队。
 * @module dsh-pet/src/standalone/ai-provider/create
 */
import { type StandaloneLogger } from '../context.ts';
import { createAiConfig } from '../ai-config.ts';
import { isAuthenticationFailure, isRateLimitFailure, sdkTextStream, type AiTransportEvent } from '../ai-transport.ts';
import type { StandaloneAiDependencies, StandaloneAiService } from './types.ts';
import { MAX_EVENTS, MAX_OUTPUT_CHARS, PROVIDER, RATE_WINDOW_MS, REQUESTS_PER_MINUTE } from './limits.ts';
import { abortable, parseRequest } from './request.ts';

/**
 * 创建独立模式 AI 服务。
 * @param home - DSH_HOME。
 * @param logger - 日志出口。
 * @param dependencies - 测试注入的传输与时钟。
 * @returns AI 服务。
 * @throws 设置无法安全读取时抛出。
 */
export function createStandaloneAi(
  home: string,
  logger: StandaloneLogger,
  dependencies: StandaloneAiDependencies = {},
): StandaloneAiService {
  let store: ReturnType<typeof createAiConfig>;
  try {
    store = createAiConfig(home);
  } catch {
    logger.error('Cannot securely load standalone AI settings.');
    // 持久化损坏或权限不安全时不能顺势启用环境里的旧凭据，宁可整体失败。
    throw new Error('Cannot securely load standalone AI settings.');
  }
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? Date.now;
  let disposed = false;
  let paused = false;
  let saving = false;
  let requests: ReadonlyArray<number> = [];
  let active: AbortController | undefined;
  const ready = () =>
    !disposed &&
    !paused &&
    !saving &&
    store.current().enabled &&
    !!store.current().model &&
    !!store.current().baseUrl &&
    !!store.current().apiKey;
  const selection = () => ({ provider: PROVIDER, model: ready() ? store.current().model : '' });

  async function* stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }> {
    if (!ready()) throw new Error('Standalone AI is not ready. Configure and enable the model first.');
    const settings = store.current();
    const { request, signal: callerSignal } = parseRequest(options, settings.model);
    if (callerSignal?.aborted) throw new Error('Standalone AI request cancelled.');
    if (active) throw new Error('Standalone AI is busy. Please wait.');
    const recent = requests.filter((time) => now() - time < RATE_WINDOW_MS);
    if (recent.length >= REQUESTS_PER_MINUTE) throw new Error('Standalone AI rate limit reached. Please wait.');
    requests = [...recent, now()];
    const controller = new AbortController();
    active = controller;
    const abort = () => controller.abort();
    callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    const iterator = sdkTextStream(settings, request, controller.signal, fetcher)[Symbol.asyncIterator]();
    let emitted = 0;
    let events = 0;
    try {
      while (true) {
        const part: IteratorResult<AiTransportEvent> = await abortable(iterator.next(), controller.signal);
        // 流式过程中设置可能被保存、服务也可能被释放，每次都重新确认。
        if (controller.signal.aborted || !ready()) throw new Error('Standalone AI request cancelled.');
        if (part.done) break;
        // 事件数也要有上限，防止对端用大量空块拖住进程。
        if (++events > MAX_EVENTS) throw new Error('Standalone AI response exceeds limits.');
        if (part.value.refusal) throw new Error('Standalone AI could not answer this request.');
        const text = part.value.text;
        if (!text) continue;
        emitted += text.length;
        if (emitted > MAX_OUTPUT_CHARS) throw new Error('Standalone AI response exceeds limits.');
        yield { type: 'text', text };
      }
      if (emitted === 0) throw new Error('Standalone AI returned no text.');
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        paused = true;
        logger.warn('Standalone AI authentication failed; save settings again to resume.');
        throw new Error('Standalone AI authentication failed. Check credentials and save settings again.', {
          cause: error,
        });
      }
      if (controller.signal.aborted) {
        throw new Error('Standalone AI request cancelled or timed out.', { cause: error });
      }
      if (isRateLimitFailure(error)) {
        throw new Error('Standalone AI provider rate limit reached. Please wait.', { cause: error });
      }
      // 只放行本层写的固定文案；SDK 错误可能带地址、请求头或正文。
      if (
        error instanceof Error &&
        [
          'Standalone AI could not answer this request.',
          'Standalone AI returned no text.',
          'Standalone AI response exceeds limits.',
        ].includes(error.message)
      )
        throw error;
      logger.warn('Standalone AI request failed.');
      throw new Error('Standalone AI request failed. Check the endpoint and model settings.', { cause: error });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
      controller.abort();
      if (active === controller) active = undefined;
      // return() 可能等待挂起的读取；只观察结果，绝不阻塞取消。
      void iterator.return?.().catch(() => logger.debug('Standalone AI transport closed.'));
    }
  }

  return {
    currentSelection: selection,
    listProviders: () => (ready() ? [{ id: PROVIDER, name: 'Standalone AI' }] : []),
    listModels: async (provider) =>
      ready() && provider === PROVIDER ? [{ id: settingsModel(), name: settingsModel() }] : [],
    resolveModelInfo: async (provider = PROVIDER, model = settingsModel(), signal) =>
      ready() && !signal?.aborted && provider === PROVIDER && model === settingsModel()
        ? { id: model, name: model }
        : undefined,
    stream,
    getSettings: () => store.publicSettings(),
    async saveSettings(input) {
      if (disposed) throw new Error('Standalone AI is disposed.');
      if (saving) throw new Error('Standalone AI settings are being saved.');
      saving = true;
      // 保存期间先中止在途请求，避免旧设置继续产生输出。
      active?.abort();
      try {
        const result = await store.save(input);
        if (!disposed) paused = false;
        return result;
      } catch (error) {
        paused = true;
        throw error;
      } finally {
        saving = false;
      }
    },
    isReady: ready,
    async testConnection(input: { protocol?: string; baseUrl?: string; model?: string; apiKey?: string }) {
      if (disposed) return { ok: false, message: '服务已关闭' };
      const current = store.current();
      const protocol = input.protocol === 'anthropic' ? 'anthropic' : (input.protocol ?? current.protocol);
      const baseUrl = (input.baseUrl !== undefined ? input.baseUrl : current.baseUrl).trim();
      const model = (input.model !== undefined ? input.model : current.model).trim();
      const apiKey = (input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : current.apiKey).trim();

      if (!baseUrl) {
        return { ok: false, message: '请先填写接口地址（Base URL）' };
      }
      if (!model) {
        return { ok: false, message: '请先填写模型名称' };
      }
      if (!apiKey) {
        return { ok: false, message: '请先填写 API 密钥' };
      }

      const testSettings = {
        protocol: protocol as 'openai-compatible' | 'anthropic',
        baseUrl,
        model,
        apiKey,
        enabled: true,
        automaticWhispers: false,
        whisperIntervalSec: 300,
        maxTokens: 32,
        timeoutMs: 15_000,
      };

      const controller = new AbortController();
      // 测试连接不复用正式通道：不污染限流、忙状态与暂停标记。
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const testStream = sdkTextStream(
          testSettings,
          { system: '', messages: [{ role: 'user', content: 'hi' }] },
          controller.signal,
          fetcher,
        );
        let reply = '';
        for await (const chunk of testStream) {
          if (chunk.refusal) {
            return { ok: false, message: '模型拒绝回答该测试请求' };
          }
          if (chunk.text) {
            reply += chunk.text;
            if (reply.length >= 40) break;
          }
        }
        if (!reply.trim()) {
          return { ok: true, message: '连接成功！接口已成功响应。', reply: '(模型返回了空白内容)' };
        }
        return { ok: true, message: '连接成功！模型响应正常。', reply: reply.trim() };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, message: '连接超时（15 秒未响应）：请检查网络连通性或服务器状态' };
        }
        if (isAuthenticationFailure(error)) {
          return { ok: false, message: '身份验证失败 (HTTP 401/403)：请检查 API 密钥是否正确' };
        }
        if (isRateLimitFailure(error)) {
          return { ok: false, message: '请求受限或配额超限 (HTTP 429)：请检查 API 账户余额或调用频率' };
        }
        const rawMsg = error instanceof Error ? error.message : String(error);
        if (rawMsg.includes('404')) {
          return { ok: false, message: '接口路径或模型不存在 (HTTP 404)：请检查接口地址（通常以 /v1 结尾）与模型名称' };
        }
        if (rawMsg.includes('ECONNREFUSED') || rawMsg.includes('fetch failed')) {
          return { ok: false, message: '无法连接到目标服务器：请检查地址与端口是否正确、服务器是否正在运行' };
        }
        return { ok: false, message: `连接失败：${rawMsg}` };
      } finally {
        clearTimeout(timer);
      }
    },
    canWhisper: () => ready() && store.current().automaticWhispers,
    dispose() {
      disposed = true;
      active?.abort();
    },
  };
  function settingsModel(): string {
    return store.current().model;
  }
}
