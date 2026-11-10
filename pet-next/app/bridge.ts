/**
 * 预加载脚本暴露给页面的桥。只有移动和退出。
 * M3-9：节能预览另加只读的窗口可见性桥，默认不订阅。
 * @module pet-next/app/bridge
 */
import type { IdleSuspensionDebugState } from '../contracts/idle-suspension.ts';

export interface PetBridge {
  /** 按屏幕像素平移窗口。主进程负责夹在当前工作区内。 */
  moveBy(dx: number, dy: number): void;
  /** 退出应用进程。 */
  quit(): void;
  /**
   * M3-11：拖动结束/取消信号（无载荷）。只有页面拿到 `dragBudget=1` 时才调用；
   * 主进程仅在开关打开时注册接收方，关闭时该消息无人接收、不产生行为。
   */
  dragEnd(): void;
}

/**
 * M3-9 窗口可见性桥。主进程是隐藏状态的唯一权威；
 * 页面只能订阅快照，不能上报自己的判断。
 */
export interface PetWindowVisibilityBridge {
  /** 取一次权威初始快照；开关关闭时主进程无 handler，返回 null。 */
  query(): Promise<unknown>;
  /** 订阅推送，返回注销函数。 */
  subscribe(listener: (snapshot: unknown) => void): () => void;
}

declare global {
  interface Window {
    pet: PetBridge;
    /** 开关关闭时仍然存在（预加载静态暴露），但 query 得到 null。 */
    petWindowVisibility?: PetWindowVisibilityBridge;
    /** M3-9 只读观测面；只有页面装配了节能预览时才写入。 */
    __petIdleSuspension?: IdleSuspensionDebugState;
    /** 仅 PET_NEXT_TEST=1 的 e2e 使用；产品页面不调用。 */
    petTestWindow?: { act(action: string): Promise<unknown> };
  }
}

export {};
