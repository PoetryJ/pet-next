@echo off
rem ============================================================
rem pet-next follow-up preview entry (double-click wrapper).
rem ASCII-only with CRLF line endings (cmd.exe reads the OEM code page).
rem 1) cd to this folder  2) find node (followup-node.txt or PATH)
rem 3) run node scripts\launch-followup.mjs and pass its exit code.
rem followup-node.txt (optional, one line): full path of node.exe 24.x
rem Prerequisites: pnpm install and pnpm build done once (see FOLLOWUP-PREVIEW.md)
rem ============================================================
cd /d "%~dp0"
if errorlevel 1 goto cd_fail
set "FOLLOWUP_NODE_EXE=node"
if exist "followup-node.txt" set /p FOLLOWUP_NODE_EXE=<"followup-node.txt"
if /i "%FOLLOWUP_NODE_EXE%"=="node" goto check_path
if not exist "%FOLLOWUP_NODE_EXE%" goto bad_node_file
goto run
:check_path
where node >nul 2>nul
if errorlevel 1 goto no_node
:run
"%FOLLOWUP_NODE_EXE%" scripts\launch-followup.mjs
if errorlevel 1 goto fail
exit /b 0
:no_node
echo [followup-preview] Node.js 24 was not found in PATH and followup-node.txt is missing.
echo [followup-preview] Install Node.js 24 or put the full path of node.exe into followup-node.txt next to this file.
pause
exit /b 1
:bad_node_file
echo [followup-preview] followup-node.txt points to a missing file: %FOLLOWUP_NODE_EXE%
pause
exit /b 1
:fail
echo [followup-preview] Launcher exited with code %ERRORLEVEL%. Read the message above.
pause
exit /b %ERRORLEVEL%
:cd_fail
echo [followup-preview] Failed to change directory to "%~dp0".
pause
exit /b 1
