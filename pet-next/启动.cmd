@echo off
rem ============================================================
rem pet-next trial package entry point (double-click wrapper).
rem This file MUST stay ASCII-only with CRLF line endings.
rem cmd.exe reads a batch file in the machine default code page,
rem so a non-ASCII byte is mis-parsed as a command under GBK/437
rem (that used to abort the wrapper in the cd_fail branch).
rem It does not change the code page, PATH or any environment.
rem Duties (three only):
rem   1) cd to the folder of this file (extracted package root)
rem   2) check that node is on PATH, else print a hint and pause
rem   3) run node scripts\launch-trial.mjs and pass its exit code
rem Prerequisites (see README.md and docs/WINDOWS-TRIAL.md):
rem   Node 22.12+ and pnpm 10.33.4, after pnpm install and pnpm build
rem ============================================================
cd /d "%~dp0"
if errorlevel 1 goto cd_fail

where node >nul 2>nul
if errorlevel 1 goto no_node

node scripts\launch-trial.mjs
if errorlevel 1 goto fail
rem exit code 0: the window closes by itself, nothing to print.
exit /b 0

:no_node
echo [launch] Node.js was not found in PATH.
echo [launch] Install Node.js 22.12 or newer from https://nodejs.org/ , then reopen this file.
echo [launch] After that run once in a terminal: pnpm install ^&^& pnpm build
pause
exit /b 1

:fail
rem ERRORLEVEL still holds the node exit code here (goto does not clear it)
echo [launch] Launcher exited with code %ERRORLEVEL%.
echo [launch] Follow the message above; if it asks for a build, run: pnpm install ^&^& pnpm build
pause
rem echo and pause do not change ERRORLEVEL, so the child code passes through
exit /b %ERRORLEVEL%

:cd_fail
echo [launch] Failed to change directory to "%~dp0".
pause
exit /b 1
