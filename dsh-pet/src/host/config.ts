/**
 * 配置层的公开出口：读取、校验、合并、写入的唯一入口。
 *
 * 只做再导出，不含逻辑；子模块按变化原因分居 ./config/。
 * 必须始终成立：模块外只经本文件使用配置能力，路径与合并规则不得旁路复制。
 * @module dsh-pet/src/host/config
 */
export { ID_FORBIDDEN, PET_DISPLAY_SET } from './config/constants.ts';
export type { ConfigPaths } from './config/constants.ts';
export { readUserConfig, userConfigUnparsable } from './config/jsonc.ts';
export {
  findPetInstance,
  flattenPetList,
  migrateUserConfig,
  readAllConfig,
  readPetConfigEntry,
} from './config/read.ts';
export { saveUserConfig, sliceMemoryRounds, syncUserConfigFromDefault } from './config/save.ts';
