/**
 * 指针采样换成 DIP 的实现目录。默认启动不引用这里。
 * @module pet-next/adapters/pointer
 */
import type { PointerAdapter } from '../../contracts/coordinates.ts';

/** 坐标换算工厂。Agent B 实现 `toDip`。 */
export function createPointerAdapter(): PointerAdapter {
  throw new Error('pointer adapter 尚未实现');
}
