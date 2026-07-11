#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SNAPSHOT_DIR="${SNAPSHOT_DIR:-${1:-/tmp/snapfix}}"
OUT_DIR="${OUT_DIR:-/tmp/locomo-reranker-probe}"
THREADS="${THREADS:-4}"
BATCH_SIZE="${BATCH_SIZE:-8}"
MAX_LENGTH="${MAX_LENGTH:-512}"
PASSAGE_TOKENS="${PASSAGE_TOKENS:-320}"

mkdir -p "${OUT_DIR}"

npm run build --workspace @memory-river/benchmark

node "${REPO_ROOT}/packages/benchmark/dist/harness/locomo-reranker-probe.js" \
  --snapshot-dir "${SNAPSHOT_DIR}" \
  --conversation conv-26 \
  --category 1 \
  --threads "${THREADS}" \
  --batch-size "${BATCH_SIZE}" \
  --max-length "${MAX_LENGTH}" \
  --passage-tokens "${PASSAGE_TOKENS}" \
  --out-json "${OUT_DIR}/conv-26-cat1-reranker-probe.json" \
  --out-md "${OUT_DIR}/conv-26-cat1-reranker-probe.md"

echo "JSON: ${OUT_DIR}/conv-26-cat1-reranker-probe.json"
echo "Markdown: ${OUT_DIR}/conv-26-cat1-reranker-probe.md"
