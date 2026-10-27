/**
 * 右键菜单样式：只列选择器与规则，注入由挂载侧统一负责。
 *
 * 不含交互逻辑；尺寸与颜色走宿主的 --dsw-* 设计变量。
 * 必须始终成立：不得出现字面色值，全部走 token。
 * @module dsh-pet/src/shared/menu/css
 */

/** 菜单样式 —— 两端注入同一份。每级面板是独立的绝对定位盒子，位置由 JS 内联写入，互不嵌套。 */
export const MENU_CSS = [
  '.dsh-pet-menu{position:fixed;left:0;top:0;z-index:2147483000;color:#2b2b2b;font-size:13px;line-height:1.5;',
  "font-family:'Microsoft YaHei UI','Segoe UI','PingFang SC',sans-serif;user-select:none;pointer-events:auto}",
  '.dsh-pet-menu,.dsh-pet-menu *{box-sizing:border-box}',
  '.dsh-pet-menu-column{position:absolute;min-width:150px;max-width:300px;padding:4px;',
  'background:rgba(255,255,255,.98);border:1px solid rgba(0,0,0,.12);border-radius:8px;',
  'box-shadow:0 8px 28px rgba(0,0,0,.2);max-height:min(62vh,460px);overflow-y:auto;',
  // 自定义滚动条：Chromium 系走 ::-webkit-scrollbar，Firefox 走 scrollbar-width/scrollbar-color；
  // thumb 用 border + background-clip 内缩留白，与圆角白底协调。
  'scrollbar-width:thin;scrollbar-color:rgba(0,0,0,.22) transparent}',
  '.dsh-pet-menu-column::-webkit-scrollbar{width:8px;height:8px}',
  '.dsh-pet-menu-column::-webkit-scrollbar-track{background:transparent}',
  '.dsh-pet-menu-column::-webkit-scrollbar-thumb{background:rgba(0,0,0,.16);border-radius:4px;',
  'border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-column::-webkit-scrollbar-thumb:hover{background:rgba(43,99,255,.4);',
  'border:2px solid transparent;background-clip:content-box}',
  '.dsh-pet-menu-column::-webkit-scrollbar-corner{background:transparent}',
  '.dsh-pet-menu-item{position:relative;display:flex;align-items:center;justify-content:space-between;',
  'gap:14px;padding:5px 12px;border-radius:6px;white-space:nowrap;cursor:default}',
  '.dsh-pet-menu-item:hover{background:rgba(43,99,255,.14)}',
  '.dsh-pet-menu-item>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis}',
  // 右侧快捷键提示（菜单项 hint）：与 label 同一 flex 行，space-between 自动贴右
  '.dsh-pet-menu-hint{color:#9aa0a6;font-size:12px;flex:none;white-space:nowrap}',
  '.dsh-pet-menu-arrow{color:#9aa0a6;font-size:12px;flex:none}',
].join('');
