/**
 * M3-10 打包入口：先开 launcher 模式，再加载既有 main（唯一入口 = 首次启动配置页）。
 *
 * 动态 import 是硬约束：main 只在模块顶层读一次 `process.env[LAUNCHER_MODE_ENV]`，
 * 静态 import 会被提升到本文件赋值之前执行，launcher 分支就永远不会命中。
 * 因此这里只做「赋值 → await import」，窗口/配置页/退出逻辑全部留在 main，不复制、不改写。
 *
 * 资源定位沿用 main 的 import.meta.url（dist/electron/*.js → root = dist），
 * 所以这里不读 cwd、不拼仓库路径；tsconfig 的 rewriteRelativeImportExtensions
 * 会把 './main.ts' 重写成 './main.js'，产物 dist/electron/packaged-main.js 与 main 同级。
 * @module pet-next/electron/packaged-main
 */
import { LAUNCHER_MODE_ENV } from '../contracts/launcher.ts';

process.env[LAUNCHER_MODE_ENV] = '1';

await import('./main.ts');
