#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bin="${1:-$root/c/zig-out/bin/libo11y}"

if [[ ! -x "$bin" ]]; then
    echo "test_cli: binary not found at $bin" >&2
    exit 1
fi

# 1. Usage error -> exit 2
set +e
out="$("$bin" 2>&1)"
rc=$?
set -e
[[ $rc -eq 2 ]] || { echo "usage exit=$rc want 2"; exit 1; }
[[ "$out" == *"usage: libo11y registry check FILE..."* ]] || { echo "bad usage msg: $out"; exit 1; }

# 2. Valid file -> exit 0
out="$("$bin" registry check "$root/conformance/appregistry/valid.yaml")"
[[ "$out" == *"ok ("*" in namespace "* ]] || { echo "unexpected valid output: $out"; exit 1; }

# 3. Policy violation -> exit 1
set +e
out="$("$bin" registry check "$root/conformance/appregistry/namespace-reserved.yaml" 2>&1)"
rc=$?
set -e
[[ $rc -eq 1 ]] || { echo "violation exit=$rc want 1"; exit 1; }
[[ "$out" == *"libo11y_app_namespace_reserved"* ]] || { echo "missing rule id: $out"; exit 1; }

# 4. Parse error -> exit 2
set +e
out="$("$bin" registry check "$root/conformance/appregistry/syntax.yaml" 2>&1)"
rc=$?
set -e
[[ $rc -eq 2 ]] || { echo "parse exit=$rc want 2"; exit 1; }
[[ "$out" == *"parsing application registry:"* ]] || { echo "missing parse prefix: $out"; exit 1; }

# 5. Multi-file highest exit code wins (0 + 1 -> 1, 1 + 2 -> 2)
set +e
"$bin" registry check "$root/conformance/appregistry/valid.yaml" "$root/conformance/appregistry/namespace-reserved.yaml" >/dev/null 2>&1
rc1=$?
"$bin" registry check "$root/conformance/appregistry/namespace-reserved.yaml" "$root/conformance/appregistry/syntax.yaml" >/dev/null 2>&1
rc2=$?
set -e
[[ $rc1 -eq 1 ]] || { echo "multi 0+1 exit=$rc1 want 1"; exit 1; }
[[ $rc2 -eq 2 ]] || { echo "multi 1+2 exit=$rc2 want 2"; exit 1; }

echo "test_cli: all CLI checks passed"
