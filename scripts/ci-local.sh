#!/usr/bin/env bash
# Usage: scripts/ci-local.sh
# Simulates CI from a clean archive checkout plus the current working-tree state
# (tracked diff + untracked, non-ignored files); its exit code is the verdict.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
temp_root="$(mktemp -d "${TMPDIR:-/tmp}/memory-river-ci.XXXXXX")"
checkout="$temp_root/repo"

cleanup() {
  rm -rf "$temp_root"
}
trap cleanup EXIT

mkdir "$checkout"
git -C "$repo_root" archive HEAD | tar -x -C "$checkout"
git -C "$repo_root" diff --binary HEAD | (cd "$checkout" && git apply --allow-empty)
git -C "$repo_root" ls-files --others --exclude-standard -z \
  | (cd "$repo_root" && tar --null -cf - -T -) \
  | tar -xf - -C "$checkout"
cd "$checkout"

npm ci
npm run build
for config in packages/*/tsconfig.json; do
  npx tsc -p "$config" --noEmit
done
npx tsc -p tsconfig.scripts.json --noEmit
npm test -ws
