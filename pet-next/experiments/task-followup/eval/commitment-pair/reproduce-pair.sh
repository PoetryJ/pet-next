#!/usr/bin/env bash
# R7 单命令复现：两条承诺各 9 次（两个模型实例并行），再评分与对账。
# 前置：两个 OpenAI 兼容实例分别监听 18882/18883（模型 Qwen3-8B，enable_thinking=false）；
#      Node >= 24；OUT 必须是新目录。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${1:?usage: reproduce-pair.sh <new directory>}
NODE=${NODE:-node}
export PET_MODEL_NAME=${PET_MODEL_NAME:-Qwen3-8B}
export PET_MODEL_DISABLE_THINKING=1
export PET_MODEL_TEMPERATURE=0
export PET_MODEL_TIMEOUT_MS=${PET_MODEL_TIMEOUT_MS:-600000}
mkdir -p "$OUT"

PET_MODEL_UPSTREAM=${PET_MODEL_UPSTREAM_A:-http://127.0.0.1:18882} \
  "$NODE" --experimental-transform-types --no-warnings eval/commitment-pair/run-pair.mjs \
  --matrix --promises P --out "$OUT/matrix-a" --base-port "${BASE_PORT_A:-19700}" &
A=$!
PET_MODEL_UPSTREAM=${PET_MODEL_UPSTREAM_B:-http://127.0.0.1:18883} \
  "$NODE" --experimental-transform-types --no-warnings eval/commitment-pair/run-pair.mjs \
  --matrix --promises O --out "$OUT/matrix-b" --base-port "${BASE_PORT_B:-19800}" &
B=$!
wait "$A"
wait "$B"

"$NODE" --experimental-transform-types --no-warnings eval/commitment-pair/score-pair.mjs \
  --runs "$OUT/matrix-a,$OUT/matrix-b" --out "$OUT/score"
"$NODE" eval/commitment-pair/reconcile-pair.mjs \
  --runs "$OUT/matrix-a,$OUT/matrix-b" --out "$OUT/reconcile"
echo "done: $OUT  (score: $OUT/score/score.json, usage: $OUT/reconcile/reconcile.json)"
