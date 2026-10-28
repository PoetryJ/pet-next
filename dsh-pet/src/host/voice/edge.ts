/**
 * edge 在线语音的封装：调用 @andresaya/edge-tts 拿到 mp3，把任何失败收敛成一个错误类型。
 *
 * SSML 拼装、XML 转义、WebSocket 与 DRM 令牌都由依赖负责——它**已经做了转义**，本模块传
 * 原文即可，再转一次会把 `&` 念成「amp」。协议变动时只需升级依赖，这里不改代码。
 * 不负责缓存与队列：本模块只保证「给定文本 → 一个 mp3 文件」这一件事。
 * @module dsh-pet/src/host/voice/edge
 */
import { rename, rm, writeFile } from 'node:fs/promises';
import { EdgeTTS } from '@andresaya/edge-tts';

/** 单次合成超时（ms）：上游长时间无响应就判失败，不拖住串行队列。 */
const SYNTHESIS_TIMEOUT_MS = 15_000;

/** 合成失败：上层据此回 `generate-error`，不区分上游细节。 */
export class VoiceSynthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceSynthError';
  }
}

/** 合成一次需要的参数。 */
export interface SynthInput {
  /** 已通过长度与空白校验的文本，原样交给依赖（转义由它负责）。 */
  readonly text: string;
  /** 白名单内的音色 id。 */
  readonly voice: string;
  /** prosody rate 表达式，如 `+0%`。 */
  readonly rate: string;
  /** 目标 mp3 的最终路径；父目录必须已存在。 */
  readonly target: string;
}

/**
 * 把一段文本合成到目标 mp3。
 *
 * 先写 `<target>.part` 再改名：`target` 一旦出现就是完整文件，中途失败不会留下半截 mp3
 * 被缓存命中逻辑当成有效音频。
 *
 * @param input - 文本、音色、语速与目标路径。
 * @throws {VoiceSynthError} 上游失败、超时或写盘失败时。
 */
export async function synthesize({ text, voice, rate, target }: SynthInput): Promise<void> {
  const tts = new EdgeTTS();
  const staging = `${target}.part`;
  try {
    const result = await tts.generate(text, voice, { rate, timeout: SYNTHESIS_TIMEOUT_MS });
    await writeFile(staging, result.audio);
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true }).catch(() => undefined);
    throw new VoiceSynthError(error instanceof Error ? error.message : String(error));
  }
}
