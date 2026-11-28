#!/usr/bin/env bash
# Tests for java-hygiene.sh against fixture trees.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/java-hygiene.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

# tree NAME FILE=BODY... writes a fixture tree and prints its path. BODY
# takes printf %b escapes.
tree() {
	local dir="$work/$1"
	shift
	mkdir -p "$dir"
	local file
	for file in "$@"; do
		mkdir -p "$(dirname "$dir/${file%%=*}")"
		printf '%b\n' "${file#*=}" >"$dir/${file%%=*}"
	done
	printf '%s\n' "$dir"
}

expect_pass() {
	local name="$1"
	shift
	if ! "$script" "$@" >"$work/out" 2>"$work/err"; then
		fail "$name: exited non-zero"
		cat "$work/out" "$work/err" >&2
		return
	fi
	echo "ok   $name"
}

expect_failure() {
	local name="$1" want_status="$2" want_err="$3"
	shift 3
	local status=0
	"$script" "$@" >"$work/out" 2>"$work/err" || status=$?
	if [[ "$status" -ne "$want_status" ]]; then
		fail "$name: exited $status, want $want_status"
		cat "$work/out" "$work/err" >&2
		return
	fi
	if ! grep -qF -- "$want_err" "$work/err"; then
		fail "$name: stderr lacks \"$want_err\""
		cat "$work/err" >&2
		return
	fi
	echo "ok   $name"
}

lib='m/src/main/java/a/Lib.java'

expect_pass "passes clean library code" "$(tree clean \
	"$lib=class Lib {\n    int add(int a, int b) {\n        return a + b;\n    }\n}")"

expect_failure "fails System.out.println" 1 "a/Lib.java:" \
	"$(tree out-println "$lib=class Lib {\n    void f() { System.out.println(\"x\"); }\n}")"

expect_failure "fails System.err.print" 1 "a/Lib.java:" \
	"$(tree err-print "$lib=class Lib {\n    void f() { System.err.print(\"x\"); }\n}")"

expect_failure "fails System.out.printf" 1 "a/Lib.java:" \
	"$(tree out-printf "$lib=class Lib {\n    void f() { System.out.printf(\"x\"); }\n}")"

expect_failure "fails printStackTrace" 1 "a/Lib.java:" \
	"$(tree stack "$lib=class Lib {\n    void f(Exception e) { e.printStackTrace(); }\n}")"

expect_pass "passes test sources and generated code" "$(tree exempt \
	'm/src/test/java/a/LibTest.java=class LibTest { void f() { System.out.println("x"); } }' \
	'm/src/main/java/ing/o11y/libo11y/spec/generated/Gen.java=class Gen { void f() { System.err.println("x"); } }' \
	'm/target/classes/Copy.java=class Copy { void f(Exception e) { e.printStackTrace(); } }')"

expect_failure "fails a print in the cli module" 1 "cli/Main.java:" \
	"$(tree cli-print 'libo11y-cli/src/main/java/cli/Main.java=class Main { void f() { System.out.println("x"); } }')"

expect_pass "passes the cli handing its streams to run" "$(tree cli-streams \
	'libo11y-cli/src/main/java/cli/Main.java=class Main {\n    static void main(String[] a) {\n        run(a, System.out, System.err);\n        System.out.flush();\n        System.err.flush();\n    }\n}')"

expect_failure "refuses a missing root" 2 "$work/missing" "$work/missing"

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
