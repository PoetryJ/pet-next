/**
 * 轮询状态的客户端出口：留下最近一拍，供同页插件经 Cordis 服务读取。
 * 只存引用、不比对也不分发：比对在 shared/state，分发在 pet/multi，本模块没有第二份判据。
 * 页面级单例，标签页之间不共享；`/state` 首拍之前为 `null`。
 * @module dsh-pet/src/client/state-service
 */
import type { PollState } from '../shared/state.ts';

/** 最近一拍的状态；`null` = 本页还没拉到过。 */
let latest: PollState | null = null;

/**
 * 记下最近一拍的状态（唯一调用点是 pet/multi 的分发入口）。
 *
 * @param state - 刚拉到的轮询状态；整包替换，不深拷贝——每拍本来就是新对象。
 */
export function setStateSnapshot(state: PollState): void {
  latest = state;
}

/** 读最近一拍的状态；本页 `/state` 还没回来时为 `null`。 */
export function getStateSnapshot(): PollState | null {
  return latest;
}

/** 清空快照；测试用，让每个用例从不含状态的页面开始。 */
export function resetStateSnapshot(): void {
  latest = null;
}
