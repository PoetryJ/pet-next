/**
 * 语音音色的唯一真相：白名单、展示元数据与默认值。
 *
 * 请求体里的 `voice` 只接受这里列出的 id——不接受任意音色串，否则等于把上游的能力面
 * 全部开放，出问题也说不清是谁传的。列表接口与校验都读同一个常量，不写第二份。
 * @module dsh-pet/src/host/voice/voices
 */

/** 一个可选音色；`id` 是 edge 服务端的 short name，其余字段只用于展示。 */
export interface VoiceInfo {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly default: boolean;
}

/** 允许请求的四个中文音色；标记 `default` 的那个是缺省值。 */
export const VOICES: readonly VoiceInfo[] = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', tag: '女 · 通用', default: true },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', tag: '女 · 活泼', default: false },
  { id: 'zh-CN-YunxiNeural', name: '云希', tag: '男 · 年轻', default: false },
  { id: 'zh-CN-YunjianNeural', name: '云健', tag: '男 · 沉稳', default: false },
];

/** 默认音色 id；请求里没给 `voice` 时用它。 */
export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

/**
 * 判断音色是否在白名单内。
 * @param id - 待校验的音色 id。
 * @returns 属于白名单时为 true。
 */
export function isKnownVoice(id: string): boolean {
  return VOICES.some((voice) => voice.id === id);
}
