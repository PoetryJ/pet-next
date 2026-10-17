// 字体（src/shared 单一来源，浏览器 bundle 与桌面 shared-core 共用）：
// 本文件是「字体种类 id → 实际 CSS 字体栈」的唯一映射表 + font 段默认值。
// 设置页的下拉框选项由 FONT_PRESETS 生成；渲染层（气泡 / 悬浮提示 / 对话窗 / 得分弹窗）
// 按 id 经 fontStackOf 取栈应用，不再各写一份字面量。
// 为什么配置里只存 id、不存字体栈：字体栈是 CSS 片段，用户手改写错会把样式拼坏；id 有白名单可校验
// （host 侧 topFieldValid 的 fontValid 用的是本清单的自包含副本——host 不能 import src/shared，
//  见 src/host/config.ts 头部注释，所以两边改动必须同步）。
import type { FontConfig, FontFamilyId } from './types';

/** 一个字体预设：id（写进 config.jsonc 的 font.family）+ 两端共用的 CSS 字体栈 */
export interface FontPreset {
  id: FontFamilyId;
  /** CSS font-family 的值（不含尾部分号）：系统字体名跨平台写法用逗号并列兜底，末位必须是通用族 */
  stack: string;
}

/** 字体预设清单：顺序 = 设置页下拉框的显示顺序（第一项是默认）。
 *  candy 是唯一随包发布的字体（assets/fonts/上首软糖体.ttf），两端各自注入 @font-face 后即可用；
 *  它的 CSS 名 "ShangshouSoftCandy" 是**我们自己起的**（与字体文件内部名称无关），改名要同步
 *  浏览器端 bubble.ts 与桌面端 renderer.js 的 @font-face 声明。
 *  其余都是系统字体：机器上没装时由后面的兜底自然回退，不报错也不空白。 */
export const FONT_PRESETS: FontPreset[] = [
  {
    id: 'candy',
    stack:
      '"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif',
  },
  { id: 'yahei', stack: '"Microsoft YaHei","PingFang SC",sans-serif' },
  { id: 'youyuan', stack: '"YouYuan","Yuanti SC",sans-serif' },
  { id: 'kaiti', stack: '"KaiTi","STKaiti",serif' },
  { id: 'simsun', stack: '"SimSun","Songti SC",serif' },
  { id: 'comic', stack: '"Comic Sans MS","Comic Sans",cursive' },
  { id: 'system', stack: 'system-ui,sans-serif' },
];

/** 字号合法区间（px，含端点）：与 host 侧 fontValid 的边界同一份口径
 *  （设置页据此即时提示，host 据此事后拦截手改的配置文件） */
export const FONT_SIZE_MIN = 4;
export const FONT_SIZE_MAX = 200;

/** font 段默认值：与内置 assets/config.jsonc 的 font 段一致。
 *  刻意等于「接入本配置之前的行为」——462 宽宠物气泡 21px、且随宠物大小缩放，
 *  所以不含 font 字段的旧配置，渲染结果与改造前一致。 */
export const DEFAULT_FONT: FontConfig = {
  family: 'candy',
  size: 21,
  followPet: true,
};

/** 按 id 取字体栈（id 非法/缺失 → 回退清单首项 = 软糖体）：渲染层零兜底逻辑，一律经此取 */
export function fontStackOf(id: string): string {
  return (FONT_PRESETS.find((p) => p.id === id) ?? FONT_PRESETS[0]).stack;
}
