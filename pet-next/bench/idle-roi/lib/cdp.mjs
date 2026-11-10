/**
 * M3-12 D：复用 M3-8 的最小 CDP 客户端（只读/合成输入，不碰产品源码）。
 * 这里不复制实现，避免两套超时/合成点击口径漂移。
 * @module pet-next/bench/idle-roi/lib/cdp
 */
export { connectCdp, delay, freePort, waitForPageSocket } from '../../idle-profile/lib/cdp.mjs';
