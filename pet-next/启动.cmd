@echo off
rem ============================================================
rem pet-next 源码试用包双击入口（薄壳）。
rem 本文件用 UTF-8（无 BOM）保存；注释为中文，输出统一用英文，
rem 避免 cmd 默认 GBK 代码页下中文 echo 乱码。
rem 职责（仅三件事，不设置任何环境变量、不修改 PATH）：
rem   1) 切到本文件所在目录（解压根目录，即 pet-next/）
rem   2) 检查 node 是否可用，缺失时给可操作提示并暂停窗口
rem   3) 运行 node scripts\launch-trial.mjs 并透传退出码
rem 首次使用前置条件见 README.md / docs/WINDOWS-TRIAL.md：
rem   Node 22.12+ 与 pnpm 10.33.4，且已执行 pnpm install && pnpm build。
rem ============================================================
cd /d "%~dp0"
if errorlevel 1 goto cd_fail

where node >nul 2>nul
if errorlevel 1 goto no_node

node scripts\launch-trial.mjs
if errorlevel 1 goto fail
rem 退出码 0：正常关窗结束，窗口自然关闭即可。
exit /b 0

:no_node
echo [launch] Node.js was not found in PATH.
echo [launch] Install Node.js 22.12 or newer from https://nodejs.org/ , then reopen this file.
echo [launch] After that, run once in a terminal: pnpm install ^&^& pnpm build
pause
exit /b 1

:fail
echo [launch] Launcher exited with code %ERRORLEVEL%.
echo [launch] Follow the message above; if it asks for a build, run: pnpm install ^&^& pnpm build
pause
exit /b %ERRORLEVEL%

:cd_fail
echo [launch] Failed to change directory to "%~dp0".
pause
exit /b 1
