#!/usr/bin/env node
/**
 * M3-1 正式入口：只起 Electron，连接已存在的真实 Qwen 服务。
 * 用法：pnpm chat:local [--probe]（先 build；关窗或 Ctrl-C 结束并清理本次 Electron）。
 *
 * 与 chat:preview 的关键区别：不启动 fake 服务、不启动任何模型进程，失败不降级成演示回复。
 * 编排逻辑在 scripts/chat-local-core.mjs（可单测）；这里只注入真实 IO。
 *
 * 可选环境变量：
 *   PET_NEXT_QWEN_BASE_URL / PET_NEXT_QWEN_MODEL  覆盖服务地址与模型（默认 127.0.0.1:18872/v1）
 *   PET_NEXT_CHAT_DEBUG_PORT=<port>               合法端口时给 Electron 传 --remote-debugging-port
 *   PET_NEXT_USER_DATA=<dir>                      原样透传（main.ts 用独立 userData）
 *   PET_NEXT_TEST=<0|1>                           原样透传（未设置时按 1 传，与 chat:preview 一致）
 * @module pet-next/scripts/chat-local
 */
import { spawn } from 'node:child_process';

import { runLocal } from './chat-local-core.mjs';

/** `--probe`：启动前显式预检 `/models`（默认不探测，避免每次真起都多打真实请求）。 */
const probe = process.argv.includes('--probe');

const exitCode = await runLocal({
  spawn,
  env: process.env,
  signals: process,
  probe,
  fetchImpl: (url, init) => fetch(url, init),
});

process.exit(exitCode);
