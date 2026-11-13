/**
 * final-demo：跟进桌宠预览的双击入口（followup-preview.cmd -> node scripts/launch-followup.mjs）。
 *
 * 只做预检 + 启动一个 Electron（宿主由 Electron 主进程按需启动/复用，用户不需要自己开三个终端）：
 *  1) Node 版本 >= 22.12 且有内置 node:sqlite（宿主数据库）；
 *  2) 构建产物 dist/electron/main.js、Electron 依赖、实验宿主 run.mjs 都在；
 *  3) 工作区可写（默认 pet-next/followup-workspace，可用 PET_FOLLOWUP_WORKSPACE 覆盖）；
 *  4) 以显式预览开关 PET_FOLLOWUP_PREVIEW=1 启动现有桌宠（默认 main 运行模式不变）。
 * 演示短等待（RealClock，minGap=20s/defer=30s，静默/阈值/冷却不变）默认开启并在面板上标识；
 * 设 PET_FOLLOWUP_DEMO_SHORT_WAIT=0 关闭。PET_NEXT_CHAT_DEBUG_PORT 沿用既有调试端口约定（缺省不开）。
 * 不自动下载、不代替构建、不常驻：Electron 退出即结束（宿主由 Electron 合作停止）。
 * @module pet-next/scripts/launch-followup
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLauncherArgs, nodeVersionProblem, NO_BUILD_HINT, PET_ROOT, resolveDebugPort, resolveElectron } from './launch-trial.mjs';

export async function runLaunchFollowup({ env = process.env, log = console.log, logError = console.error } = {}) {
  const tag = '[followup-preview]';
  const versionProblem = nodeVersionProblem(process.versions.node);
  if (versionProblem !== null) {
    logError(`${tag} ${versionProblem}`);
    return 1;
  }
  try {
    await import('node:sqlite');
  } catch (error) {
    logError(`${tag} 当前 Node ${process.versions.node} 缺少内置 node:sqlite（跟进宿主需要），请改用 Node 24：${error.message}`);
    return 1;
  }
  const mainPath = path.join(PET_ROOT, 'dist/electron/main.js');
  if (!existsSync(mainPath)) {
    logError(`${tag} 缺少构建产物 ${path.relative(PET_ROOT, mainPath)}：${NO_BUILD_HINT}`);
    return 1;
  }
  const hostEntry = path.join(PET_ROOT, 'experiments/task-followup/run.mjs');
  if (!existsSync(hostEntry)) {
    logError(`${tag} 缺少跟进宿主 ${path.relative(PET_ROOT, hostEntry)}（源码不完整）`);
    return 1;
  }
  let electron;
  try {
    electron = resolveElectron(PET_ROOT);
  } catch (error) {
    logError(`${tag} 依赖未安装（${error.message}）：${NO_BUILD_HINT}`);
    return 1;
  }
  if (!existsSync(electron)) {
    logError(`${tag} Electron 可执行文件不存在：${electron}；${NO_BUILD_HINT}`);
    return 1;
  }
  const workspace = path.resolve(env.PET_FOLLOWUP_WORKSPACE || path.join(PET_ROOT, 'followup-workspace'));
  try {
    mkdirSync(path.join(workspace, 'results'), { recursive: true });
    accessSync(workspace, constants.W_OK);
  } catch (error) {
    logError(`${tag} 工作区不可写：${workspace}（${error.message}）`);
    return 1;
  }
  const demoShortWait = env.PET_FOLLOWUP_DEMO_SHORT_WAIT !== '0';
  const childEnv = {
    ...env,
    PET_FOLLOWUP_PREVIEW: '1',
    PET_FOLLOWUP_WORKSPACE: workspace,
    PET_FOLLOWUP_NODE: process.execPath,
    PET_FOLLOWUP_DEMO_SHORT_WAIT: demoShortWait ? '1' : '0',
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.PET_NEXT_LAUNCHER;
  const args = buildLauncherArgs(process.platform, mainPath, resolveDebugPort(env.PET_NEXT_CHAT_DEBUG_PORT));
  log(`${tag} Node ${process.versions.node}（${process.execPath}）`);
  log(`${tag} 工作区 ${workspace}`);
  log(`${tag} ${demoShortWait ? '演示短等待配置（RealClock）已开启' : '标准等待配置'}；判断为本地规则原型，不调用模型`);
  if (env.PET_FOLLOWUP_RECORDING_ON_TOP === '1') log(`${tag} 录制辅助已开启：面板/报告窗置顶（仅录屏用，不改变跟进语义）`);
  log(`${tag} 启动桌宠（跟进预览）。关闭本窗口不会影响桌宠；从桌宠面板“完全退出”或在桌宠上按 Esc 退出。`);
  const child = spawn(electron, args, { stdio: 'inherit', env: childEnv });
  return await new Promise((resolve) => {
    child.on('error', (error) => {
      logError(`${tag} Electron 启动失败：${error.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) process.exit(await runLaunchFollowup());
