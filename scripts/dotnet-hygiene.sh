#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-dotnet/src}"

fail=0
while IFS= read -r -d '' file; do
  # Allow Console.* in Libo11y.Cli and O11y.cs (default Console.Out writer)
  case "$file" in
    */Libo11y.Cli/*|*/Generated/*) continue ;;
  esac
  if grep -nE 'Console\.Write(Line)?\s*\(|Debug\.Write(Line)?\s*\(|Debugger\.Break\s*\(' "$file" >/dev/null 2>&1; then
    echo "dotnet-hygiene: disallowed debug/console write in $file:" >&2
    grep -nE 'Console\.Write(Line)?\s*\(|Debug\.Write(Line)?\s*\(|Debugger\.Break\s*\(' "$file" >&2
    fail=1
  fi
done < <(find "$ROOT" -type f -name '*.cs' -print0)

exit "$fail"
