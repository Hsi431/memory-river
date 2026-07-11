#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SNAPSHOT_DIR="${SNAPSHOT_DIR:-${1:-/tmp/snapfix}}"
OUT_DIR="${OUT_DIR:-/tmp/locomo-coverage-ab}"
CONVERSATIONS="${CONVERSATIONS:-all}"   # "all" = every conversation with cat1 questions
KS="${KS:-10,20}"
PRIMARY_K="${PRIMARY_K:-10}"
MAX_TOKENS="${MAX_TOKENS:-8192}"

mkdir -p "${OUT_DIR}"

npm run build --workspace @memory-river/benchmark

CONV_ARGS=()
if [ "${CONVERSATIONS}" != "all" ]; then
  CONV_ARGS=(--conversations "${CONVERSATIONS}")
fi

node "${REPO_ROOT}/packages/benchmark/dist/harness/locomo-coverage-ab.js" \
  --snapshot-dir "${SNAPSHOT_DIR}" \
  "${CONV_ARGS[@]}" \
  --category 1 \
  --ks "${KS}" \
  --primary-k "${PRIMARY_K}" \
  --max-tokens "${MAX_TOKENS}" \
  --out-json "${OUT_DIR}/cat1-coverage-ab.json" \
  --out-md "${OUT_DIR}/cat1-coverage-ab.md"

echo "JSON: ${OUT_DIR}/cat1-coverage-ab.json"
echo "Markdown: ${OUT_DIR}/cat1-coverage-ab.md"
