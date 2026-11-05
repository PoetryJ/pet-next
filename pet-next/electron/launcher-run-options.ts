/**
 * launcher 的启动选择 → 桌宠窗口运行配置的纯映射。
 *
 * 缺陷背景（M3-7 复验）：启动页只把 experience 交给窗口，没有补 preview，
 * 页面因此没有创建 holder.behavior，反馈成功回调 onReact 空转。
 * 这里把"用户选择"翻译成窗口真正需要的两份配置：
 * - `experience` 决定页面是否创建反馈对象（等待提示 + 一次回应）；
 * - `preview` 决定页面是否创建 BehaviorPet（`behavior`）以及回应用短片（`short`）。
 *
 * 边界：纯函数、零环境变量读取、零副作用、不 import electron。
 * 选择 companion 的运行配置不得从父进程 env 继承任何 preview/experience 残留；
 * 选择 standard 时必须显式清空，避免探针或上一轮残留把反馈带进来。
 * @module pet-next/electron/launcher-run-options
 */
import { COMPANION_EXPERIENCE, type ChatExperience } from '../contracts/chat.ts';
import type { LauncherExperience } from '../contracts/launcher.ts';

/** companion 选择对应的预览令牌：短片回应 + 产品行为调度器，两者缺一不可。 */
export const COMPANION_PREVIEW = 'short,behavior';

/** 交给 createWindow 的运行配置（与 LocalChatOverride 的对应字段同形）。 */
export interface LauncherRunOptions {
  /** 页面 `preview` 查询参数原值；undefined/空串 = 不创建行为对象。 */
  preview: string | undefined;
  /** 页面 `chat:info` 的体验口径；undefined = 不创建反馈对象。 */
  experience: ChatExperience | undefined;
  /** 是否用主进程有界历史（用户选择原样透传）。 */
  contextEnabled: boolean;
}

/**
 * 把启动页选择翻译成窗口运行配置。
 *
 * @param options - 启动页提交并通过探测的选择（只看 experience / chatContext）。
 * @returns companion=短片+行为+反馈；standard=两项都清空，仅保留会话开关。
 */
export function launcherRunOptions(options: {
  experience: LauncherExperience;
  chatContext: boolean;
}): LauncherRunOptions {
  if (options.experience === 'companion') {
    return {
      preview: COMPANION_PREVIEW,
      experience: COMPANION_EXPERIENCE,
      contextEnabled: options.chatContext,
    };
  }
  return { preview: undefined, experience: undefined, contextEnabled: options.chatContext };
}
