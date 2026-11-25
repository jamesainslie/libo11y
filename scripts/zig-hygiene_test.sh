#!/usr/bin/env bash
# Tests for zig-hygiene.sh against fixture trees: it passes Zig sources
# whose forbidden calls are all in tests, test-only files, comments or
# string literals, and it fails each forbidden call in library code with
# its file and line.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/zig-hygiene.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

# tree <name> <path=source>...: writes a fixture tree and prints its path.
# Each source is printed with printf %b, so \n separates lines.
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

# expect_pass <name> <args...>: the script succeeds and says so.
expect_pass() {
	local name="$1"
	shift
	if ! "$script" "$@" >"$work/out" 2>"$work/err"; then
		fail "$name: exited non-zero"
		cat "$work/out" "$work/err" >&2
		return
	fi
	if ! grep -qF "no forbidden calls outside tests" "$work/out"; then
		fail "$name: stdout lacks the summary line"
		cat "$work/out" >&2
		return
	fi
	echo "ok   $name"
}

# expect_failure <name> <status> <stderr substring> <args...>: the script
# exits with status and explains itself on stderr.
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

lib='const std = @import("std");\n\npub fn add(a: u8, b: u8) !u8 {\n    return std.math.add(u8, a, b);\n}'

expect_pass "passes clean library code" "$(tree clean "src/lib.zig=$lib")"

expect_failure "fails @panic in library code" 1 "src/lib.zig:2: @panic outside a test" \
	"$(tree panic 'src/lib.zig=pub fn f() void {\n    @panic("boom");\n}')"

expect_failure "fails catch unreachable" 1 "lib.zig:2: catch unreachable outside a test" \
	"$(tree unreachable 'lib.zig=pub fn f() u8 {\n    return g() catch unreachable;\n}')"

expect_failure "fails catch with a capture and unreachable" 1 "lib.zig:2: catch unreachable outside a test" \
	"$(tree unreachable-capture 'lib.zig=pub fn f() u8 {\n    return g() catch |err| unreachable;\n}')"

expect_failure "fails std.debug.print" 1 "lib.zig:2: std.debug.print outside a test" \
	"$(tree print 'lib.zig=pub fn f() void {\n    std.debug.print("x", .{});\n}')"

expect_failure "fails an alias of std.debug.print" 1 "lib.zig:1: std.debug.print outside a test" \
	"$(tree print-alias 'lib.zig=const print = std.debug.print;')"

expect_failure "reports every violation" 1 "2 forbidden call(s) outside tests" \
	"$(tree two 'a.zig=pub fn f() void {\n    @panic("a");\n}' 'b/c.zig=pub fn g() void {\n    @panic("c");\n}')"

expect_pass "passes forbidden calls inside named, anonymous and decl tests" "$(tree tests \
	"lib.zig=$lib\n\ntest \"add {overflows}\" {\n    _ = add(255, 1) catch unreachable;\n    std.debug.print(\"x\", .{});\n}\n\ntest {\n    @panic(\"a\");\n}\n\ntest add {\n    @panic(\"b\");\n}")"

expect_pass "passes a test nested in a container" "$(tree nested \
	'lib.zig=pub const S = struct {\n    x: u8,\n\n    test "s" {\n        @panic("in test");\n    }\n};')"

expect_failure "checks code after a nested test closes" 1 "lib.zig:7: @panic outside a test" \
	"$(tree nested-after 'lib.zig=pub const S = struct {\n    test "s" {\n        if (true) {\n            @panic("in test");\n        }\n    }\n    fn f() void { @panic("after"); }\n};')"

expect_failure "checks code after a test block ends" 1 "lib.zig:5: @panic outside a test" \
	"$(tree after 'lib.zig=test "t" {\n    @panic("in test");\n}\n\npub fn f() void { @panic("after"); }')"

expect_pass "passes test-only files" "$(tree test-files \
	'test/harness.zig=pub fn f() void {\n    @panic("harness");\n}' \
	'src/proto_roundtrip_test.zig=fn helper() void {\n    std.debug.print("x", .{});\n}')"

expect_pass "passes comments, doc comments and multiline strings" "$(tree text \
	'lib.zig=//! Never call @panic.\n/// Unlike std.debug.print, this returns an error.\npub fn f() !void { // no catch unreachable here\n    const s =\n        \\\\@panic("not code")\n    ;\n    _ = s;\n}')"

expect_pass "skips build output, fetched packages and other files" "$(tree skipped \
	"lib.zig=$lib" \
	'.zig-cache/o/x.zig=pub fn f() void { @panic("cache"); }' \
	'zig-pkg/dep/src/x.zig=pub fn f() void { @panic("dependency"); }' \
	'zig-out/x.zig=pub fn f() void { @panic("output"); }' \
	'README.md=Never write @panic("x") in library code.')"

expect_pass "checks a single file" "$work/clean/src/lib.zig"

expect_failure "refuses a missing path" 2 "no such file or directory" "$work/missing"

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
