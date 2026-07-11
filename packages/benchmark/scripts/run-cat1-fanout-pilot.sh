#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 SNAPSHOT_DIR [OUT_DIR]" >&2
  exit 2
fi

SNAPSHOT_DIR="$1"
OUT_DIR="${2:-packages/benchmark/reports/cat1-fanout-$(date -u +%Y%m%dT%H%M%SZ)}"

mkdir -p "$OUT_DIR"

npm run build --workspace=packages/benchmark

node packages/benchmark/dist/cli.js locomo-delivered-context \
  --snapshot-dir "$SNAPSHOT_DIR" \
  --conversation conv-26 \
  --category 1 \
  --out-json "$OUT_DIR/baseline.json" \
  --out-md "$OUT_DIR/baseline.md"

MR_CAT1_FANOUT=1 node packages/benchmark/dist/cli.js locomo-delivered-context \
  --snapshot-dir "$SNAPSHOT_DIR" \
  --conversation conv-26 \
  --category 1 \
  --out-json "$OUT_DIR/fanout.json" \
  --out-md "$OUT_DIR/fanout.md"

echo "Wrote cat1 fanout pilot outputs to $OUT_DIR"
