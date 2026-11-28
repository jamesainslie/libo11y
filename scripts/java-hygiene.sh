#!/usr/bin/env bash
# java-hygiene.sh: fail on System.out or System.err print calls and on
# printStackTrace in Java library code outside tests.
#
# Usage: java-hygiene.sh [ROOT]
#
# ROOT defaults to java. Files under src/test, target and the generated spec
# package are not checked. The CLI is checked too: it hands System.out and
# System.err to Main.run as streams, which the pattern does not match. A ROOT
# that cannot be searched fails the gate with status 2.
set -euo pipefail

ROOT="${1:-java}"
pattern='System\.(out|err)\.print(ln|f)?\s*\(|\.printStackTrace\s*\('

files="$(mktemp)"
trap 'rm -f -- "$files"' EXIT
if ! find "$ROOT" -type f -name '*.java' -print0 >"$files"; then
  echo "java-hygiene: cannot search $ROOT" >&2
  exit 2
fi

fail=0
while IFS= read -r -d '' file; do
  case "$file" in
    */src/test/*|*/target/*|*/spec/generated/*) continue ;;
  esac
  if grep -nE "$pattern" "$file" >/dev/null 2>&1; then
    echo "java-hygiene: disallowed stdout/stderr print or printStackTrace in $file:" >&2
    grep -nE "$pattern" "$file" >&2
    fail=1
  fi
done <"$files"

exit "$fail"
