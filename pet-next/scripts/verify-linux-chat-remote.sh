#!/usr/bin/env bash
# M3-2 Linux 真实隧道复跑脚本（与 scripts/verify-windows-chat-remote.ps1 对应）。
# 用途：在有 SSH 密钥的 Linux 机器上对真实服务器执行
#   建隧道 → /models 探测 → 启动真实聊天入口 → SIGTERM 收尾 → 残留检查，并落证据目录。
# 预算纪律：本脚本不发送任何聊天消息（零真实推理）；真实回复留给 Windows 验收（账本最后 1 次）。
# 凭据：只读环境变量/本地配置（同 pnpm chat:remote），不保存密码、不提交密钥。
#
# 用法：
#   PET_NEXT_SSH_HOST=<服务器> PET_NEXT_SSH_PORT=<端口> PET_NEXT_SSH_USER=<用户> \
#   [PET_NEXT_SSH_IDENTITY_FILE=~/.ssh/id_ed25519] [PET_NEXT_TUNNEL_LOCAL_PORT=18873] \
#   bash scripts/verify-linux-chat-remote.sh
set -uo pipefail

STAMP="$(date -u +%Y-%m-%dT%H-%M-%S)Z"
OUT_DIR="${PET_NEXT_LINUX_EVIDENCE_DIR:-linux-real}-${STAMP}"
READY_TIMEOUT_S="${PET_NEXT_LINUX_READY_TIMEOUT_S:-90}"
LOCAL_PORT="${PET_NEXT_TUNNEL_LOCAL_PORT:-18873}"
MODEL_ID="${PET_NEXT_QWEN_MODEL:-qwen3.8-27b}"
EXIT_OK=0
ENTRY_CODE_TEXT="entryExit: <not-reached>"

mkdir -p "${OUT_DIR}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "${OUT_DIR}/script.log"; }
fail() { log "FAIL: $*"; EXIT_OK=1; finish; }

finish() {
  {
    echo "M3-2 Linux 真实隧道复跑 SUMMARY"
    echo "stamp: ${STAMP}"
    echo "${ENTRY_CODE_TEXT}"
    echo "exit: ${EXIT_OK}"
  } > "${OUT_DIR}/SUMMARY.txt"
  cat "${OUT_DIR}/SUMMARY.txt"
  exit "${EXIT_OK}"
}

# ---------- 1) 配置预检 ----------
if [ -z "${PET_NEXT_SSH_HOST:-}" ]; then
  log "缺少 PET_NEXT_SSH_HOST（服务器地址）。本脚本不内置任何真实地址/密钥。"
  fail "config-missing"
fi
SSH_PORT="${PET_NEXT_SSH_PORT:-22}"
SSH_USER="${PET_NEXT_SSH_USER:-root}"
SSH_BIN="${PET_NEXT_SSH_BIN:-ssh}"
log "config: host=${PET_NEXT_SSH_HOST} port=${SSH_PORT} user=${SSH_USER} localPort=${LOCAL_PORT} model=${MODEL_ID}"

command -v node >/dev/null 2>&1 || fail "node 不在 PATH"
command -v pnpm >/dev/null 2>&1 || fail "pnpm 不在 PATH"
command -v "${SSH_BIN}" >/dev/null 2>&1 || fail "ssh 不在 PATH（隧道层会分类为 ssh-missing）"
[ -x dist/electron/main.js ] || [ -f dist/electron/main.js ] || fail "缺少构建产物 dist/electron/main.js：请先 pnpm build"

# ---------- 2) 环境记录 ----------
{
  echo "os: $(uname -a)"
  echo "node: $(node -v)"
  echo "pnpm: $(pnpm -v)"
  echo "ssh: $(${SSH_BIN} -V 2>&1 | head -1)"
  echo "electron: $(node -p "require('./package.json').devDependencies.electron || require('./package.json').dependencies.electron" 2>/dev/null)"
  echo "display: ${DISPLAY:-<unset>}"
} > "${OUT_DIR}/env.txt" 2>&1

# 起跑前基线：已有 ssh/electron 进程（收尾后不得误杀、也不得把无关进程算成本次残留）
pgrep -af ssh | grep -v 'pgrep' > "${OUT_DIR}/ssh-before.txt" 2>/dev/null || true
pgrep -af electron | grep -v 'pgrep' > "${OUT_DIR}/electron-before.txt" 2>/dev/null || true

# 端口占用预检：不抢占，已有监听则直接失败
if ss -tln 2>/dev/null | grep -q "127.0.0.1:${LOCAL_PORT} "; then
  fail "本地端口 ${LOCAL_PORT} 已被占用（不抢占，可设 PET_NEXT_TUNNEL_LOCAL_PORT 换端口）"
fi

# ---------- 3) 显示：无 DISPLAY 时自起 Xvfb ----------
XVFB_PID=""
if [ -z "${DISPLAY:-}" ]; then
  for d in 91 92 93 94 95 96; do
    if ! ls "/tmp/.X11-unix/X${d}" >/dev/null 2>&1; then
      Xvfb ":${d}" -screen 0 1280x800x24 >/dev/null 2>&1 &
      XVFB_PID=$!
      export DISPLAY=":${d}"
      break
    fi
  done
  [ -n "${XVFB_PID}" ] || fail "无法自起 Xvfb"
  log "自起 Xvfb ${DISPLAY}（pid=${XVFB_PID}）"
fi
cleanup_xvfb() {
  if [ -n "${XVFB_PID}" ]; then
    kill "${XVFB_PID}" 2>/dev/null || true
    wait "${XVFB_PID}" 2>/dev/null || true
  fi
}
trap cleanup_xvfb EXIT

# ---------- 4) 启动 pnpm chat:remote ----------
log "启动 pnpm chat:remote（stdout → ${OUT_DIR}/stdout.ndjson）"
pnpm chat:remote > "${OUT_DIR}/stdout.ndjson" 2> "${OUT_DIR}/stderr.txt" &
ENTRY_PID=$!

READY_SEEN=0
FAILED_SEEN=0
ELAPSED=0
while kill -0 "${ENTRY_PID}" 2>/dev/null && [ "${ELAPSED}" -lt "${READY_TIMEOUT_S}" ]; do
  if grep -q '"event":"chat-remote-ready"' "${OUT_DIR}/stdout.ndjson" 2>/dev/null; then READY_SEEN=1; break; fi
  if grep -q '"event":"chat-remote-failed"' "${OUT_DIR}/stdout.ndjson" 2>/dev/null; then FAILED_SEEN=1; break; fi
  sleep 1; ELAPSED=$((ELAPSED + 1))
done

if [ "${READY_SEEN}" -eq 0 ] && [ "${FAILED_SEEN}" -eq 0 ]; then
  # 进程已退出或超时：终读一次日志（进程退出与 grep 之间存在竞争）
  grep -q '"event":"chat-remote-ready"' "${OUT_DIR}/stdout.ndjson" 2>/dev/null && READY_SEEN=1
  grep -q '"event":"chat-remote-failed"' "${OUT_DIR}/stdout.ndjson" 2>/dev/null && FAILED_SEEN=1
fi

if [ "${FAILED_SEEN}" -eq 1 ]; then
  wait "${ENTRY_PID}"; ENTRY_CODE=$?
  ENTRY_CODE_TEXT="entryExit: ${ENTRY_CODE}"
  cp "${OUT_DIR}/stdout.ndjson" "${OUT_DIR}/entry-failed-stdout.ndjson" 2>/dev/null || true
  log "入口自报失败（如 auth-failed/probe-failed），退出码 ${ENTRY_CODE}（认证失败属预期可读错误路径）"
  # 失败路径同样不得残留隧道/监听
  sleep 1
  if ss -tln 2>/dev/null | grep -q "127.0.0.1:${LOCAL_PORT} "; then
    fail "失败后本地端口 ${LOCAL_PORT} 仍被监听（残留）"
  fi
  log "失败路径干净：无本地转发监听残留"
  finish
fi

if [ "${READY_SEEN}" -eq 0 ]; then
  kill "${ENTRY_PID}" 2>/dev/null || true
  wait "${ENTRY_PID}" 2>/dev/null || true
  fail "${READY_TIMEOUT_S}s 内未观察到 chat-remote-ready（详见 ${OUT_DIR}/stdout.ndjson）"
fi
log "chat-remote-ready 已出现（${ELAPSED}s）"

# ---------- 5) 就绪后证据：经转发端 GET /models（探测，非推理） ----------
curl -sS --max-time 8 "http://127.0.0.1:${LOCAL_PORT}/v1/models" > "${OUT_DIR}/models.json" 2> "${OUT_DIR}/models-curl.err" \
  && log "/models 已抓取" || log "WARN: /models 抓取失败（见 models-curl.err）"
if grep -q "\"id\".*${MODEL_ID}\|${MODEL_ID}" "${OUT_DIR}/models.json" 2>/dev/null; then
  log "目标模型 ${MODEL_ID} 在 /models 中"
else
  log "WARN: /models 未匹配到 ${MODEL_ID}（以入口 probe 事件为准）"
fi

# ---------- 6) SIGTERM 收尾（期望 143：SIGTERM 处理路径） ----------
log "发送 SIGTERM 收尾"
kill -TERM "${ENTRY_PID}" 2>/dev/null || true
for i in $(seq 1 30); do
  kill -0 "${ENTRY_PID}" 2>/dev/null || break
  sleep 1
done
if kill -0 "${ENTRY_PID}" 2>/dev/null; then
  kill -KILL "${ENTRY_PID}" 2>/dev/null || true
  fail "入口 30s 未退出，已 SIGKILL（异常路径）"
fi
wait "${ENTRY_PID}"; ENTRY_CODE=$?
ENTRY_CODE_TEXT="entryExit: ${ENTRY_CODE}"
log "入口退出码 ${ENTRY_CODE}（SIGTERM 预期 143）"
grep -q '"event":"chat-remote-done"' "${OUT_DIR}/stdout.ndjson" && log "chat-remote-done 已记录（隧道统一收尾）" || log "WARN: 未见 chat-remote-done"

# ---------- 7) 残留检查：本次 ssh/electron 必须退出；无关进程不受影响 ----------
sleep 2
pgrep -af ssh | grep -v 'pgrep' > "${OUT_DIR}/ssh-after.txt" 2>/dev/null || true
pgrep -af electron | grep -v 'pgrep' > "${OUT_DIR}/electron-after.txt" 2>/dev/null || true
LEFT_SSH=$(grep -F "L 127.0.0.1:${LOCAL_PORT}" "${OUT_DIR}/ssh-after.txt" 2>/dev/null | grep -c . || true)
LEFT_ELEC=$(grep -c . "${OUT_DIR}/electron-after.txt" 2>/dev/null || true)
BASE_ELEC=$(grep -c . "${OUT_DIR}/electron-before.txt" 2>/dev/null || true)
if [ "${LEFT_SSH:-0}" -gt 0 ]; then fail "残留本次 ssh 隧道进程（localPort=${LOCAL_PORT}）"; fi
if [ "${LEFT_ELEC:-0}" -gt "${BASE_ELEC:-0}" ]; then fail "electron 进程数比基线多（before=${BASE_ELEC} after=${LEFT_ELEC}）"; fi
if ss -tln 2>/dev/null | grep -q "127.0.0.1:${LOCAL_PORT} "; then fail "本地转发端口 ${LOCAL_PORT} 仍被监听"; fi
log "残留检查通过：本次 ssh/electron 已收，无关进程未受影响"
log "PASS"
finish
