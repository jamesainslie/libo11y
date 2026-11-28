#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-java}"

fail=0
while IFS= read -r -d '' file; do
  case "$file" in
    */src/test/*|*/target/*|*/libo11y-cli/*|*/spec/generated/*) continue ;;
  esac
  if grep -nE 'System\.(out|err)\.print(ln|f)?\s*\(|\.printStackTrace\s*\(' "$file" >/dev/null 2>&1; then
    echo "java-hygiene: disallowed stdout/stderr print or printStackTrace in $file:" >&2
    grep -nE 'System\.(out|err)\.print(ln|f)?\s*\(|\.printStackTrace\s*\(' "$file" >&2
    fail=1
  fi
done < <(find "$ROOT" -type f -name '*.java' -print0)

exit "$fail"
