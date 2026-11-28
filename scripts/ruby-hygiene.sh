#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-ruby/lib}"

fail=0
while IFS= read -r -d '' file; do
  # Disallow debug calls (binding.pry, debugger, byebug, puts, pp) outside tests/exe
  if grep -nE '(^|[^A-Za-z0-9_])(binding\.pry|binding\.irb|debugger|byebug|puts|pp)([^A-Za-z0-9_]|$)' "$file" | grep -vE '^\s*#' >/dev/null 2>&1; then
    echo "ruby-hygiene: disallowed debug/stdout call in $file:" >&2
    grep -nE '(^|[^A-Za-z0-9_])(binding\.pry|binding\.irb|debugger|byebug|puts|pp)([^A-Za-z0-9_]|$)' "$file" >&2
    fail=1
  fi
  # Disallow bare `rescue Exception` outside tests
  if grep -nE 'rescue[[:space:]]+Exception\b' "$file" >/dev/null 2>&1; then
    echo "ruby-hygiene: disallowed rescue Exception in $file:" >&2
    grep -nE 'rescue[[:space:]]+Exception\b' "$file" >&2
    fail=1
  fi
done < <(find "$ROOT" -type f -name '*.rb' -not -path '*/generated/*' -print0)

exit "$fail"
