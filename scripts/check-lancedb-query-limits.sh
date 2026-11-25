#!/bin/sh

set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
if [ "$#" -gt 1 ]; then
  printf 'Usage: sh scripts/check-lancedb-query-limits.sh [repository-root]\n' >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  root=$(CDPATH= cd "$1" && pwd)
else
  root=$(CDPATH= cd "$script_dir/.." && pwd)
fi

if [ ! -d "$root/packages" ]; then
  printf 'Missing packages directory under %s\n' "$root" >&2
  exit 2
fi

failed=0

scan_dir() {
  for source_file in "$1"/*; do
    if [ -d "$source_file" ]; then
      scan_dir "$source_file"
    elif [ -f "$source_file" ]; then
      case "$source_file" in
        *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
          if ! awk '
            function clear_pending() {
              while (depth > 0) {
                delete query_line[depth]
                delete has_limit[depth]
                depth--
              }
              bare_limit = 0
            }
            /await[[:space:]]+queryAllRows[[:space:]]*\(/ {
              clear_pending()
              helper_call = 1
            }
            helper_call {
              if (/\)[[:space:]]*;/) helper_call = 0
              next
            }
            /\.query[[:space:]]*\(/ {
              bare_limit = 0
              depth++
              query_line[depth] = FNR
              has_limit[depth] = 0
            }
            depth > 0 && /\.limit[[:space:]]*\(/ {
              has_limit[depth] = 1
            }
            depth > 0 && /\.toArray[[:space:]]*\(/ {
              if (!has_limit[depth]) {
                printf "%s:%d: .query() reaches .toArray() without .limit(\n", FILENAME, query_line[depth]
                failed = 1
              }
              delete query_line[depth]
              delete has_limit[depth]
              depth--
              bare_limit = 0
              next
            }
            depth == 0 && /\.limit[[:space:]]*\(/ {
              bare_limit = 1
            }
            depth == 0 && /\.toArray[[:space:]]*\(/ {
              if (!bare_limit) {
                printf "%s:%d: .toArray() has no visible .limit(\n", FILENAME, FNR
                failed = 1
              }
              bare_limit = 0
            }
            END {
              if (failed) exit 1
            }
          ' "$source_file"; then
            failed=1
          fi
          ;;
      esac
    fi
  done
}

for package_src in "$root"/packages/*/src; do
  [ -d "$package_src" ] || continue
  scan_dir "$package_src"
done

if [ "$failed" -ne 0 ]; then
  printf 'Found LanceDB queries without explicit limits.\n' >&2
  exit 1
fi

printf 'OK: no unbounded LanceDB query().toArray() calls found.\n'
