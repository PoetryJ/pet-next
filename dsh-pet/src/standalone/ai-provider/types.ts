/**
 * 独立 AI 服务的对外形状：服务能力与创建时的依赖。
 *
 * 纯类型，不含实现。
 * 必须始终成立：字段全部 readonly，调用方不得改写服务内部状态。
 * @module dsh-pet/src/standalone/ai-provider/types
 */
import { type StandaloneAiPublicSettings } from '../ai-config.ts';
import { type AiFetch } from '../ai-transport.ts';

/** 独立模式 AI 服务的对外形状。 */
export interface StandaloneAiService {
  /** 当前选中的服务商与模型；未就绪时模型为空。 */
  currentSelection(): { provider: string; model: string };
  /** 就绪时返回唯一的 standalone 服务商。 */
  listProviders(): Array<{ id: string; name: string }>;
  /** 就绪时返回当前模型，否则为空。 */
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
  /** 校验请求的模型是否就是当前配置的那个。 */
  resolveModelInfo(
    provider?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<undefined | { id: string; name: string }>;
  /** 以异步序列返回文本增量。 */
  stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }>;
  /** 取脱敏后的当前设置。 */
  getSettings(): StandaloneAiPublicSettings;
  /** 校验并保存设置，成功后解除认证失败造成的暂停。 */
  saveSettings(input: unknown): Promise<StandaloneAiPublicSettings>;
  /** 用一次最小请求验证地址、模型与密钥。 */
  testConnection(input: {
    protocol?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; message: string; reply?: string }>;
  /** 是否满足发起请求的全部条件。 */
  isReady(): boolean;
  /** 是否允许按间隔自动碎碎念。 */
  canWhisper(): boolean;
  /** 终止在途请求并释放服务。 */
  dispose(): void;
}

/** 可注入的传输与时钟，仅供测试替换；生产使用官方 SDK 与真实时间。 */
export interface StandaloneAiDependencies {
  /** 替换 fetch 以隔离网络。 */
  fetch?: AiFetch;
  /** 替换时钟以控制限流窗口。 */
  now?: () => number;
}
