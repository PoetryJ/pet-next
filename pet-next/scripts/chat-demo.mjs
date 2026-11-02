#!/usr/bin/env node
/**
 * M3-0 聊天预览演示入口：本地假服务 + 真实 Electron 聊天面板。
 * 用法：pnpm chat:preview（先 build）；关窗或 Ctrl-C 结束并清理本次两个子进程。
 *
 * 编排逻辑在 scripts/chat-demo-core.mjs（可单测）；这里只注入真实 IO。
 * 失败（fake 起不来 / Electron 起不来 / 页面加载失败）一律清理子进程并非零退出，
 * 且只有在 fake /healthz 报 offline_ready 且 Electron 面板已渲染后才打印 offline_ready:true。
 *
 * 可选环境变量：
 *   PET_NEXT_CHAT_DEBUG_PORT=<port>  合法端口时给 Electron 传 --remote-debugging-port（供 CDP）
 *   PET_NEXT_USER_DATA=<dir>         原样透传（main.ts 用独立 userData）
 * @module pet-next/scripts/chat-demo
 */
import { spawn } from 'node:child_process';
import { runDemo } from './chat-demo-core.mjs';

const exitCode = await runDemo({
  spawn,
  fetchHealth: (url) => fetch(url, { signal: AbortSignal.timeout(5000) }),
  env: process.env,
  signals: process,
});

process.exit(exitCode);
