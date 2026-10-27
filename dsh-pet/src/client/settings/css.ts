/**
 * 设置页样式表与注入入口：两族类名——`dsh-pet-mp__*`（AI 模型选择器）与 `dsh-pet-cfg__*`（配置卡片）。
 * 只放伪类、悬浮、过渡与容器查询这类内联 style 表达不了的东西，其余排版走组件内联 style。
 * 颜色与圆角取 `--dsw-alias-*` / `--dsw-radius-*` token；填充按钮上的白字与阴影回退值是刻意例外。
 * 注入按 `data-plugin-css` 去重，同一页面重复渲染设置页不会长第二份样式。
 * @module dsh-pet/src/client/settings/css
 */

/** 设置页样式表；按类名族分段拼成单段文本，行内注释标出反直觉的那几条规则。 */
const SETTINGS_CSS = [
  '.dsh-pet-mp{position:relative;min-width:0;display:flex;flex-direction:column;gap:4px}',
  '.dsh-pet-mp__trigger{display:flex;align-items:center;gap:6px;width:100%;max-width:340px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer;outline:none}',
  '.dsh-pet-mp__trigger:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__trigger:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
  '.dsh-pet-mp__trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-mp__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-mp__sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex-shrink:1000;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}',
  '.dsh-pet-mp__chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));transition:transform .12s}',
  '.dsh-pet-mp__chevron.is-open{transform:rotate(180deg)}',
  // 浮层用 fixed 脱离设置页的滚动容器（不被 overflow 裁掉）；z-index 与插件右键菜单同一档。
  '.dsh-pet-mp__panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:4px;padding:4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-mp__search{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}',
  '.dsh-pet-mp__search:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__list{display:flex;flex-direction:column;min-height:0;overflow-y:auto;scrollbar-width:thin}',
  '.dsh-pet-mp__group{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-mp__item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
  '.dsh-pet-mp__item:hover:not(:disabled),.dsh-pet-mp__item.is-active{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-mp__item[aria-checked="true"]{color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-mp__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-mp__check{flex:none;margin-left:auto}',
  '.dsh-pet-mp__status{padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

  '.dsh-pet-cfg{container-type:inline-size;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
  '.dsh-pet-cfg__title{display:flex;align-items:center;gap:6px;margin:0;font-size:16px;font-weight:500;line-height:24px}',

  '.dsh-pet-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}',
  '.dsh-pet-cfg__cardHead{display:flex;align-items:center;gap:6px;min-height:20px}',
  '.dsh-pet-cfg__cardTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',

  '.dsh-pet-cfg__grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}',

  '@container (max-width:600px){.dsh-pet-cfg__grid4{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@container (max-width:400px){.dsh-pet-cfg__grid2,.dsh-pet-cfg__grid3,.dsh-pet-cfg__grid4{grid-template-columns:minmax(0,1fr)}}',

  '.dsh-pet-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dsh-pet-cfg__flabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',

  '.dsh-pet-cfg__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
  '.dsh-pet-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-cfg__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',

  // 人设复用 __inp 的边框与字号，只补高度与纵向缩放；人设没有长度上限，右下角只显示字数、不阻断输入。
  '.dsh-pet-cfg__persona{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.dsh-pet-cfg__area{min-height:66px;resize:vertical;line-height:18px}',
  '.dsh-pet-cfg__count{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right}',

  '.dsh-pet-cfg__toggle{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-cfg__toggle>label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;min-width:0}',
  '.dsh-pet-cfg__toggle>label>span{overflow-wrap:anywhere}',
  '.dsh-pet-cfg__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',

  // 悬浮说明通用件：任何带 data-tip 的元素悬浮即出气泡，组件侧用 tip() 生成属性，不额外包 DOM。
  '.dsh-pet-cfg [data-tip]{position:relative}',
  // 气泡默认左对齐：触发元素常贴卡片左缘，居中会向左伸出并被 overflow 裁掉；贴右缘的用 data-tip-end。
  '.dsh-pet-cfg [data-tip]::after{display:none;content:attr(data-tip);position:absolute;left:-4px;bottom:calc(100% + 8px);width:max-content;max-width:260px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:#fff;font-size:12px;font-style:normal;font-weight:400;line-height:18px;text-align:left;white-space:normal;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease;box-shadow:0 6px 20px rgba(0,0,0,.22);z-index:2147483000}',
  '.dsh-pet-cfg [data-tip]:hover::after{display:block;opacity:1;visibility:visible}',
  '.dsh-pet-cfg [data-tip][data-tip-end]::after{left:auto;right:-4px}',

  // 问号：气泡的一个圆形宿主外观。
  '.dsh-pet-cfg__q{display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal;line-height:1;cursor:help;user-select:none}',

  '.dsh-pet-cfg__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}',
  // 实心主按钮必须排除在通用 hover 外：半透明 hover 会顶掉 button-info-fill，让蓝色按钮一悬停就发白；
  // 主按钮的 hover 走主题自己的 button-info-hover。
  '.dsh-pet-cfg__btn:hover:not(:disabled):not(.is-primary){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__btn:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:#fff}',
  '.dsh-pet-cfg__btn.is-primary:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
  '.dsh-pet-cfg__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-cfg__btn.is-sm{padding:2px 10px}',
  '.dsh-pet-cfg__btn.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  '.dsh-pet-cfg__tabs{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
  '.dsh-pet-cfg__tabsLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  // 种类条单独一行：与下面的宠物条隔开，避免两组按钮读成一行。
  '.dsh-pet-cfg__kinds{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}',
  '.dsh-pet-cfg__tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}',
  '.dsh-pet-cfg__tab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__tab:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__tab.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-pet-cfg__tab.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  '.dsh-pet-cfg__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}',
  '.dsh-pet-cfg__msg{margin-left:4px;font-size:12px;color:var(--dsw-alias-state-success-primary)}',
  '.dsh-pet-cfg__msg.is-err{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-cfg__note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-cfg__path{font-size:12px;line-height:18px;word-break:break-all;user-select:text;color:var(--dsw-alias-label-secondary)}',
  '.dsh-pet-cfg__path b{color:var(--dsw-alias-label-primary);font-weight:400}',
  '.dsh-pet-cfg__cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:12px;line-height:18px;word-break:break-all;user-select:text;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
].join('\n');

/** 注入去重用的标记值，写在 `<style>` 的 `data-plugin-css` 上。 */
const settingsCssTag = 'dsh-pet/settings.css';

/** 把设置页样式注入 `document.head`：幂等，且没有 document（SSR 或单测）时直接返回。 */
export function injectSettingsCss(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="' + settingsCssTag + '"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = settingsCssTag;
  tag.textContent = SETTINGS_CSS;
  document.head.appendChild(tag);
}
