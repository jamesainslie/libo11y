#!/usr/bin/env bash
# Tests for python-hygiene.sh against fixture trees.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/python-hygiene.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

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
	if ! grep -qF "no forbidden constructs outside tests" "$work/out"; then
		fail "$name: stdout lacks the summary line"
		cat "$work/out" >&2
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

expect_pass "passes clean library code" "$(tree clean 'src/mod.py=def add(a: int, b: int) -> int:\n    try:\n        return a + b\n    except ValueError:\n        return 0')"

expect_failure "fails print in library code" 1 "src/mod.py:2: print outside a test" \
	"$(tree print 'src/mod.py=def f() -> None:\n    print("hello")')"

expect_failure "fails builtins.print in library code" 1 "src/mod.py:3: builtins.print outside a test" \
	"$(tree builtins-print 'src/mod.py=import builtins\ndef f() -> None:\n    builtins.print("hello")')"

expect_failure "fails breakpoint in library code" 1 "src/mod.py:2: breakpoint outside a test" \
	"$(tree bp 'src/mod.py=def f() -> None:\n    breakpoint()')"

expect_failure "fails bare except" 1 "src/mod.py:4: bare except outside a test" \
	"$(tree bare 'src/mod.py=def f() -> None:\n    try:\n        pass\n    except:\n        pass')"

expect_failure "fails except BaseException" 1 "src/mod.py:4: except BaseException outside a test" \
	"$(tree base-exc 'src/mod.py=def f() -> None:\n    try:\n        pass\n    except BaseException:\n        pass')"

expect_failure "fails tuple except with BaseException" 1 "src/mod.py:4: except BaseException outside a test" \
	"$(tree tuple-exc 'src/mod.py=def f() -> None:\n    try:\n        pass\n    except (ValueError, BaseException):\n        pass')"

expect_pass "passes forbidden constructs in comments and strings" "$(tree strings \
	'src/mod.py=# print("comment")\nMSG = "breakpoint() except BaseException:"\ndef f() -> str:\n    return MSG')"

expect_pass "passes forbidden constructs in test files" "$(tree tests \
	'tests/test_a.py=print("ok")\nbreakpoint()' \
	'src/test_helper.py=print("ok")' \
	'src/helper_test.py=try:\n    pass\nexcept:\n    pass')"

expect_pass "skips .venv and build directories" "$(tree skipped \
	'src/mod.py=x = 1' \
	'.venv/lib/mod.py=print("venv")' \
	'dist/mod.py=breakpoint()')"

expect_failure "refuses a missing path" 2 "no such file or directory" "$work/missing"

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
