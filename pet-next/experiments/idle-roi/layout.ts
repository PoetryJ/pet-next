/**
 * 待机 ROI 的布局入口。
 *
 * 产品树 `contracts/idle-roi.ts` 是**唯一实现**（产品不能 import `experiments/`），
 * 这里只做转出：不复制公式、不另立常量，实验侧单测与页面跑的是同一份字节。
 *
 * 依赖负责人提交的 `contracts/idle-roi.ts`（ad4d20a 引入，830b7cb 补 query 编解码与开关常量）；
 * 本分支基线 dfeca20 尚无该文件，单测需在其之上运行（见 WIRING-NEEDED.md 第 5 节）。
 *
 * @module pet-next/experiments/idle-roi/layout
 */

export * from '../../contracts/idle-roi.ts';
