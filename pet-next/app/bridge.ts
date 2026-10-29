/**
 * 预加载脚本暴露给页面的桥。只有移动和退出。
 * @module pet-next/app/bridge
 */

export interface PetBridge {
  /** 按屏幕像素平移窗口。主进程负责夹在当前工作区内。 */
  moveBy(dx: number, dy: number): void;
  /** 退出应用进程。 */
  quit(): void;
}

declare global {
  interface Window {
    pet: PetBridge;
  }
}

export {};
