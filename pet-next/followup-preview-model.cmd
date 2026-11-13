@echo off
rem ============================================================
rem pet-next follow-up preview WITH model judgment (double-click wrapper).
rem Same as followup-preview.cmd, plus env for the capability assessor:
rem   PET_FOLLOWUP_ASSESSOR=capability, PET_MODEL_BASE_URL, PET_MODEL_NAME.
rem Defaults point to the local loopback endpoint 127.0.0.1:18882 (Qwen3-8B).
rem If the endpoint is down, each judgment fails visibly (recorded as failed);
rem if the env is missing, the host falls back to the local rule prototype and says so.
rem ASCII-only with CRLF line endings.
rem ============================================================
if not defined PET_MODEL_BASE_URL set "PET_MODEL_BASE_URL=http://127.0.0.1:18882/v1"
if not defined PET_MODEL_NAME set "PET_MODEL_NAME=Qwen3-8B"
if not defined PET_MODEL_MAX_TOKENS set "PET_MODEL_MAX_TOKENS=2048"
if not defined PET_MODEL_TIMEOUT_MS set "PET_MODEL_TIMEOUT_MS=240000"
if not defined PET_FOLLOWUP_ASSESSOR_TIMEOUT_MS set "PET_FOLLOWUP_ASSESSOR_TIMEOUT_MS=500000"
set "PET_FOLLOWUP_ASSESSOR=capability"
call "%~dp0followup-preview.cmd"
exit /b %ERRORLEVEL%
