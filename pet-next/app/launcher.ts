/**
 * launcher.html 页面装配：取 #launcher-root 与 preload 暴露的 window.petLauncher 桥并挂载视图。
 * 仅首启模式窗口加载本入口；普通宠物入口（page.html）不引用本文件。
 * @module pet-next/app/launcher
 */
import { mountLauncher } from './launcher-view.ts';

const root = document.getElementById('launcher-root');
if (!(root instanceof HTMLElement)) {
  throw new Error('launcher markup missing');
}
const bridge = window.petLauncher;
if (bridge === undefined) {
  throw new Error('launcher requested but petLauncher bridge missing');
}
mountLauncher(root, bridge);
