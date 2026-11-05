/**
 * M3-7 B：Node 侧 launcher 控制器工厂（薄壳，不重复实现）。
 *
 * 真实实现：
 * - 状态机与资源归属：core/launcher/controller.ts；
 * - 配置读写：core/launcher/config.ts；
 * - 真实 IO/隧道/探测绑定：adapters/launcher/node.ts。
 * Electron 主进程直接 import adapters/launcher/node.ts（编译进 dist）；
 * 本文件供 Node 脚本/诊断复用（node --experimental-strip-types 下可直接 import）。
 * @module pet-next/scripts/launcher-core
 */
export {
  createAtomicConfigIo,
  createNodeLauncherController,
  resolveConfigFilePath,
} from '../adapters/launcher/node.ts';
