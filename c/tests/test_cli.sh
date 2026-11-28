#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bin="${1:-$root/c/zig-out/bin/libo11y}"

if [[ ! -x "$bin" ]]; then
    echo "test_cli: binary not found at $bin" >&2
    exit 1
fi

run_split() {
    local out_file err_file
    out_file="$(mktemp)"
    err_file="$(mktemp)"
    set +e
    "$bin" "$@" >"$out_file" 2>"$err_file"
    CLI_RC=$?
    set -e
    CLI_OUT="$(cat "$out_file")"
    CLI_ERR="$(cat "$err_file")"
    rm -f "$out_file" "$err_file"
}

# 1. Help flags -> exit 0, usage on stdout, empty stderr
for flag in -h --help help; do
    run_split "$flag"
    [[ $CLI_RC -eq 0 ]] || { echo "help ($flag) exit=$CLI_RC want 0"; exit 1; }
    [[ "$CLI_OUT" == *"usage: libo11y registry check FILE..."* ]] || { echo "help ($flag) stdout: $CLI_OUT"; exit 1; }
    [[ -z "$CLI_ERR" ]] || { echo "help ($flag) unexpected stderr: $CLI_ERR"; exit 1; }
done

# 2. Usage error -> exit 2, usage on stderr, empty stdout
run_split
[[ $CLI_RC -eq 2 ]] || { echo "usage exit=$CLI_RC want 2"; exit 1; }
[[ -z "$CLI_OUT" ]] || { echo "usage unexpected stdout: $CLI_OUT"; exit 1; }
[[ "$CLI_ERR" == *"usage: libo11y registry check FILE..."* ]] || { echo "bad usage msg: $CLI_ERR"; exit 1; }

# 3. Valid file -> exit 0, summary on stdout, empty stderr
run_split registry check "$root/conformance/appregistry/valid.yaml"
[[ $CLI_RC -eq 0 ]] || { echo "valid exit=$CLI_RC want 0"; exit 1; }
[[ "$CLI_OUT" == *"ok ("*" in namespace "* ]] || { echo "unexpected valid output: $CLI_OUT"; exit 1; }
[[ -z "$CLI_ERR" ]] || { echo "valid unexpected stderr: $CLI_ERR"; exit 1; }

# 4. Policy violation -> exit 1, violation on stdout, empty stderr
run_split registry check "$root/conformance/appregistry/namespace-reserved.yaml"
[[ $CLI_RC -eq 1 ]] || { echo "violation exit=$CLI_RC want 1"; exit 1; }
[[ "$CLI_OUT" == *"libo11y_app_namespace_reserved"* ]] || { echo "missing rule id on stdout: $CLI_OUT (stderr=$CLI_ERR)"; exit 1; }
[[ -z "$CLI_ERR" ]] || { echo "violation unexpected stderr: $CLI_ERR"; exit 1; }

# 5. Parse error -> exit 2, error on stderr, empty stdout
run_split registry check "$root/conformance/appregistry/syntax.yaml"
[[ $CLI_RC -eq 2 ]] || { echo "parse exit=$CLI_RC want 2"; exit 1; }
[[ -z "$CLI_OUT" ]] || { echo "parse unexpected stdout: $CLI_OUT"; exit 1; }
[[ "$CLI_ERR" == *"parsing application registry:"* ]] || { echo "missing parse prefix on stderr: $CLI_ERR"; exit 1; }

# 6. Missing file -> exit 2, Go-style open error on stderr, empty stdout
missing="/nonexistent/libo11y-missing-registry.yaml"
run_split registry check "$missing"
[[ $CLI_RC -eq 2 ]] || { echo "missing exit=$CLI_RC want 2"; exit 1; }
[[ -z "$CLI_OUT" ]] || { echo "missing unexpected stdout: $CLI_OUT"; exit 1; }
[[ "$CLI_ERR" == "open $missing: no such file or directory" ]] || { echo "unexpected missing msg: $CLI_ERR"; exit 1; }

# 7. Multi-file highest exit code wins (0 + 1 -> 1, 1 + 2 -> 2)
run_split registry check "$root/conformance/appregistry/valid.yaml" "$root/conformance/appregistry/namespace-reserved.yaml"
[[ $CLI_RC -eq 1 ]] || { echo "multi 0+1 exit=$CLI_RC want 1"; exit 1; }
[[ "$CLI_OUT" == *"ok ("* && "$CLI_OUT" == *"libo11y_app_namespace_reserved"* ]] || { echo "multi 0+1 stdout: $CLI_OUT"; exit 1; }
[[ -z "$CLI_ERR" ]] || { echo "multi 0+1 stderr: $CLI_ERR"; exit 1; }

run_split registry check "$root/conformance/appregistry/namespace-reserved.yaml" "$root/conformance/appregistry/syntax.yaml"
[[ $CLI_RC -eq 2 ]] || { echo "multi 1+2 exit=$CLI_RC want 2"; exit 1; }
[[ "$CLI_OUT" == *"libo11y_app_namespace_reserved"* ]] || { echo "multi 1+2 stdout: $CLI_OUT"; exit 1; }
[[ "$CLI_ERR" == *"parsing application registry:"* ]] || { echo "multi 1+2 stderr: $CLI_ERR"; exit 1; }

echo "test_cli: all CLI checks passed"
