#!/usr/bin/env bash
# M3-12 R1 D：阶段门自检复跑脚本（9 组）。
# 只用 --mode=preflight / 门的 perf 阶段：不建 Xvfb、不起 Electron、不改产品。
# 输出写到 bench/idle-roi/runs/gate-<name>/console.txt（原始 stdout+stderr+EXIT）。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PET="$(cd "$HERE/../../.." && pwd)"
REPO="$(cd "$PET/.." && pwd)"
BENCH="$PET/bench/idle-roi"
export PATH=/root/.workbuddy/binaries/node/versions/24.14.0/bin:$PATH
cd "$PET"

REF="${REF:-HEAD}"
SUB="${SUB:-experiments/idle-roi/out-v2}"
FX=bench/idle-roi/gate-fixtures
RUN=bench/idle-roi/run.mjs
REPORT=tests/idle-roi/out/quality-report.json
TMP="$(mktemp -d)"

ORIG_SHA="$(sha256sum "$REPORT" | cut -d' ' -f1)"
restore() {
  if [ -f "$TMP/orig-report.json" ]; then
    cp "$TMP/orig-report.json" "$REPORT"
    now="$(sha256sum "$REPORT" | cut -d' ' -f1)"
    [ "$now" = "$ORIG_SHA" ] && echo "[restore] 报告已还原 sha256=$now" || echo "[restore] 还原失败！期望 $ORIG_SHA 实际 $now"
  fi
  rm -rf "$TMP"
}
trap restore EXIT

run() {
  name="$1"; shift
  mkdir -p "$BENCH/runs/$name"
  {
    echo "\$ env -u NODE_OPTIONS node $RUN $*"
    echo
    env -u NODE_OPTIONS node "$RUN" "$@" 2>&1
    rc=$?
    echo
    echo "EXIT=$rc"
  } > "$BENCH/runs/$name/console.txt" 2>&1
  echo "$name -> $(tail -1 "$BENCH/runs/$name/console.txt")"
}

# 合成两个"同 dest 双目录/空目录"的素材目录（字节取自工作区已提交且干净的 out / out-v2）。
mkdir -p "$TMP/dup/out" "$TMP/dup/out-v2" "$TMP/empty/out-v2"
cp experiments/idle-roi/out/*.webm experiments/idle-roi/out/manifest.json "$TMP/dup/out/" 2>/dev/null
cp experiments/idle-roi/out-v2/*.webm experiments/idle-roi/out-v2/manifest.json "$TMP/dup/out-v2/" 2>/dev/null

# 1) 仓内已提交报告（真实状态 failed）
run gate-neg1-failed-report --mode=preflight --assets-ref="$REF" --assets-subpath="$SUB" \
  --stamp=gate-neg1-failed-report --display=:157
# 2) perf 模式：证明门在 Electron 之前就把整轮挡住
run gate-perf-failed --mode=perf --assets-ref="$REF" --assets-subpath="$SUB" \
  --stamp=gate-perf-failed --display=:157
# 3) 正控：passed + 三臂 SHA 对齐 → 门放行
run gate-positive-report --mode=preflight --assets-ref="$REF" --assets-subpath="$SUB" \
  --quality-report="$FX/positive-report.json" --stamp=gate-positive-report --display=:157
# 4) 报告里 F 的 SHA 被改错
run gate-wrong-sha-report --mode=preflight --assets-ref="$REF" --assets-subpath="$SUB" \
  --quality-report="$FX/wrong-sha-report.json" --stamp=gate-wrong-sha-report --display=:157
# 5) 阈值放水（ocP99Lsb=3）
run gate-loose-threshold-report --mode=preflight --assets-ref="$REF" --assets-subpath="$SUB" \
  --quality-report="$FX/loose-threshold-report.json" --stamp=gate-loose-threshold-report --display=:157
# 6) 同 dest 同时有 out/ 与 out-v2/（旧 resolveAssetsDir 会选回 out）
run gate-dup-dest --mode=preflight --assets-dir="$TMP/dup/out-v2" --assets-subpath="$SUB" \
  --quality-report="$FX/positive-report.json" --stamp=gate-dup-dest --display=:157
# 7) 空目录
run gate-empty-dir --mode=preflight --assets-dir="$TMP/empty/out-v2" --assets-subpath="$SUB" \
  --quality-report="$FX/positive-report.json" --stamp=gate-empty-dir --display=:157
# 8) 把仓内报告临时改成 passed（未提交）后跑 perf
cp "$REPORT" "$TMP/orig-report.json"
cp "$FX/positive-report.json" "$REPORT"
run gate-dirty-report --mode=perf --assets-ref="$REF" --assets-subpath="$SUB" \
  --stamp=gate-dirty-report --display=:157
restore
echo
echo "汇总："
grep -H "EXIT=" "$BENCH"/runs/gate-*/console.txt | sed "s#$BENCH/runs/##"
