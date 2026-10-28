/**
 * 「打开桌宠对话」的快捷键：注册进 DSH 的快捷键服务。
 *
 * 注册后自动出现在 设置 → 通用 → 快捷键（可改绑、有冲突提示），
 * 侧栏 guide 卡片通过 `commandId` 显示键帽。服务缺失（旧宿主）只告警，不影响面板本身。
 * @module dsh-pet/src/client/chat/shortcut
 */

/** 命令 id：guide 卡片的 `commandId` 与注册都用它。 */
export const PET_CHAT_COMMAND_ID = 'pet-chat.open';

/** 快捷键服务的最小形状（按用到的成员声明，不引整包类型）。 */
interface ShortcutsService {
  register(command: {
    readonly id: string;
    readonly label: () => string;
    readonly aliases: readonly string[];
    readonly defaults: Readonly<Record<string, unknown>>;
    readonly regions: readonly string[];
    readonly modals: readonly string[];
    resolve: (
      context: unknown,
    ) => { status: 'handled'; run(): void } | { status: 'blocked'; reason: string } | { status: 'pass' };
  }): () => void;
}

/** 六个运行环境档案都用同一个物理组合：主修饰键 + Shift + P。 */
const DEFAULT_BINDING = { code: 'KeyP', modifiers: ['primary', 'shift'] } as const;

/**
 * 给默认键位的环境。
 *
 * **不含 `web:linux`**：DSH 对 Web 端快捷键有白名单（Linux 只放行 `Ctrl+/`、`Ctrl+Shift+,`、
 * `Ctrl+Shift+.`），给 Linux Web 配 `Ctrl+Shift+P` 会让整条注册被拒（报 `Unsupported Web shortcut`）。
 * 那个环境的用户可以在设置里自己绑。
 */
const DEFAULT_PROFILES = ['web:windows', 'web:macos', 'desktop:windows', 'desktop:macos', 'desktop:linux'] as const;

/** 注册快捷键需要的上下文。 */
export interface ShortcutHost {
  /** Cordis 的软取服务：拿不到返回 undefined。 */
  get?(name: string): unknown;
}

/**
 * 注册对话快捷键。
 *
 * @param ctx - 客户端上下文（只用到软取）。
 * @param open - 触发时要执行的动作（打开对话标签）。
 * @returns `registered` 表示命令是否真的登记成功；`dispose` 用于注销（失败时是空函数）。
 *   失败时调用方不能再把 `commandId` 交给侧栏——指向不存在的命令会让侧栏注册抛错。
 */
export function registerPetChatShortcut(
  ctx: ShortcutHost,
  open: () => void,
): { registered: boolean; dispose: () => void } {
  const shortcuts = ctx.get?.('shortcuts') as ShortcutsService | undefined;
  if (shortcuts === undefined || typeof shortcuts.register !== 'function') {
    console.warn('[dsh-pet] 快捷键服务不可用，「桌宠对话」未注册快捷键');
    return { registered: false, dispose: () => {} };
  }
  try {
    const defaults = Object.fromEntries(DEFAULT_PROFILES.map((profile) => [profile, DEFAULT_BINDING]));
    const dispose = shortcuts.register({
      id: PET_CHAT_COMMAND_ID,
      label: () => '桌宠对话',
      aliases: [],
      defaults,
      // 面板属于页面级命令：输入框里打字时不抢键
      regions: ['page'],
      modals: [],
      resolve: () => ({ status: 'handled', run: open }),
    });
    return { registered: true, dispose: () => dispose() };
  } catch (error) {
    // 注册被拒（键位不被接受 / id 冲突）：只丢快捷键，不影响面板
    console.warn('[dsh-pet] 快捷键注册失败：' + (error instanceof Error ? error.message : String(error)));
    return { registered: false, dispose: () => {} };
  }
}
