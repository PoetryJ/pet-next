#!/usr/bin/env bash
# R8 单命令入口：先反例，再 24 次 live，再独立评分/核验。
# 前置：两个 OpenAI 兼容实例（默认 18882/18883），Qwen3-8B，enable_thinking=false；
#      OUT 必须是新目录；timezone=Asia/Shanghai 写在 runner 里。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${1:?usage: reproduce.sh <new directory>}
NODE=${NODE:-node}
export PET_MODEL_NAME=${PET_MODEL_NAME:-Qwen3-8B}
export PET_MODEL_DISABLE_THINKING=1
export PET_MODEL_TEMPERATURE=0
export PET_MODEL_TIMEOUT_MS=${PET_MODEL_TIMEOUT_MS:-600000}
mkdir -p "$OUT"

code_sha() {
  local file=$1
  local head dirty
  head=$(git rev-parse HEAD)
  dirty=$(git status --porcelain | sha256sum | awk '{print $1}')
  printf '{"head":"%s","dirty":"%s","clean":%s}\n' "$head" "$dirty" "$([ -z "$(git status --porcelain)" ] && echo true || echo false)" > "$file"
}
code_sha "$OUT/code-before.json"

echo '[1/4] 反例复现'
"$NODE" --experimental-transform-types --no-warnings eval/first-failure-pair/replay-counterexamples.mjs > "$OUT/preflight.json"

echo '[2/4] 24 次 live（G1/G3 与 G2/G4 两队列）'
PET_MODEL_UPSTREAM=${PET_MODEL_UPSTREAM_A:-http://127.0.0.1:18882} \
  "$NODE" --experimental-transform-types --no-warnings eval/first-failure-pair/run.mjs \
  --matrix --groups G1,G3 --out "$OUT/matrix-a" --base-port "${BASE_PORT_A:-19400}" &
A=$!
PET_MODEL_UPSTREAM=${PET_MODEL_UPSTREAM_B:-http://127.0.0.1:18883} \
  "$NODE" --experimental-transform-types --no-warnings eval/first-failure-pair/run.mjs \
  --matrix --groups G2,G4 --out "$OUT/matrix-b" --base-port "${BASE_PORT_B:-19500}" &
B=$!
wait "$A"
wait "$B"

echo '[3/4] 独立评分'
"$NODE" --experimental-transform-types --no-warnings eval/first-failure-pair/score.mjs \
  --runs "$OUT/matrix-a,$OUT/matrix-b" --out "$OUT/score"

echo '[4/4] 核验'
code_sha "$OUT/code-after.json"
"$NODE" --experimental-transform-types --no-warnings eval/first-failure-pair/verify.mjs \
  --runs "$OUT/matrix-a,$OUT/matrix-b" --out "$OUT/verify.json" \
  --before "$OUT/code-before.json" --after "$OUT/code-after.json"

echo "done: $OUT（score/score.json、verify.json、matrix-a/b 原始记录）"
