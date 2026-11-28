#!/usr/bin/env bash
# zig-hygiene.sh: fail on calls that crash or print from library code in
# the Zig sources: @panic, std.debug.panic, std.debug.print, and catch or
# orelse followed by unreachable. A catch may carry an error capture, and
# unreachable may start the next line. Any debug.print or debug.panic
# token counts, so `const debug = std.debug;` aliases are caught, and so
# is an alias of std.debug.print itself.
#
# Usage: zig-hygiene.sh [PATH...]
#
# Each PATH is a directory searched for *.zig files or a single file. The
# default is the root shim's build.zig and the zig/ package. Directories
# named .zig-cache, zig-out and zig-pkg are skipped.
#
# Test code may use these calls freely. Test code is:
#   - a test-only file: any file under a test/ directory below a PATH
#     (zig/test/ by default), or any file named *_test.zig;
#   - a test block in any other file: from a line that opens a test
#     declaration (`test "name" {`, `test {` or `test name {`, at any
#     indentation, optionally followed by a comment) to the closing
#     brace at the same indentation.
# The block rule relies on zig fmt's layout, which make zig-check enforces
# before running this script. Comments and multiline string lines (\\) are
# not code and are ignored. So is the text inside a string or character
# literal: a // there does not start a comment, and a forbidden call named
# there is not a call.
# Code guarded by builtin.is_test outside a test block is not recognised.
set -euo pipefail

usage() {
	echo "usage: zig-hygiene.sh [PATH...]" >&2
	exit 2
}

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if (($# == 0)); then
	set -- "$root/build.zig" "$root/zig"
fi

files=()
for path in "$@"; do
	[[ -n "$path" ]] || usage
	if [[ -d "$path" ]]; then
		while IFS= read -r file; do
			rel="${file#"${path%/}"/}"
			# Test-only files are not checked.
			[[ "$rel" =~ (^|/)test/ || "$rel" == *_test.zig ]] && continue
			files+=("$file")
		done < <(find "$path" \( -name .zig-cache -o -name zig-out -o -name zig-pkg \) -prune -o -type f -name '*.zig' -print | LC_ALL=C sort)
	elif [[ -f "$path" ]]; then
		[[ "$path" == *_test.zig ]] && continue
		files+=("$path")
	else
		echo "zig-hygiene: $path: no such file or directory" >&2
		usage
	fi
done

if ((${#files[@]} == 0)); then
	echo "zig-hygiene: no forbidden calls outside tests in 0 files"
	exit 0
fi

# Written for POSIX awk, so it runs the same with the BSD awk on macOS.
violations="$(awk '
	FNR == 1 { in_test = 0; indent = ""; pending = "" }
	{
		line = $0
		if (in_test) {
			if (line == indent "}") in_test = 0
			next
		}
		if (line ~ /^[ \t]*test( "([^"\\]|\\.)*"| [A-Za-z_][A-Za-z0-9_]*)? [{]([ \t]*\/\/.*)?$/) {
			match(line, /^[ \t]*/)
			indent = substr(line, 1, RLENGTH)
			in_test = 1
			pending = ""
			next
		}
		if (line ~ /^[ \t]*\\\\/) next
		code = strip(line)
		if (code ~ /^[ \t]*$/) next
		text = line
		sub(/^[ \t]+/, "", text)
		if (code ~ /@panic[(]/) report("@panic")
		if (code ~ /(^|[^A-Za-z0-9_])catch[ \t]+(\|[^|]*\|[ \t]*)?unreachable/) report("catch unreachable")
		if (code ~ /(^|[^A-Za-z0-9_])orelse[ \t]+unreachable/) report("orelse unreachable")
		# A catch or orelse that ends a line, followed by a line that
		# starts with unreachable.
		if (pending != "" && code ~ /^[ \t]*unreachable([^A-Za-z0-9_]|$)/) report(pending " unreachable")
		pending = ""
		if (code ~ /(^|[^A-Za-z0-9_])catch([ \t]+\|[^|]*\|)?[ \t]*$/) pending = "catch"
		if (code ~ /(^|[^A-Za-z0-9_])orelse[ \t]*$/) pending = "orelse"
		# std.debug.print and std.debug.panic, qualified, aliased through
		# `const debug = std.debug;`, or aliased themselves.
		if (code ~ /(^|[^A-Za-z0-9_])debug\.print([^A-Za-z0-9_]|$)/) report("std.debug.print")
		if (code ~ /(^|[^A-Za-z0-9_])debug\.panic([^A-Za-z0-9_]|$)/) report("std.debug.panic")
	}
	# strip(line) returns the code on a line: the text of each string and
	# character literal is removed, leaving its quotes, and a // comment
	# outside a literal is cut off. \047 is the single quote.
	function strip(line,    out, i, n, c, quote) {
		if (line !~ /["\047]/) {
			sub(/\/\/.*/, "", line)
			return line
		}
		out = ""
		quote = ""
		n = length(line)
		for (i = 1; i <= n; i++) {
			c = substr(line, i, 1)
			if (quote != "") {
				if (c == "\\") {
					i++
				} else if (c == quote) {
					out = out c
					quote = ""
				}
				continue
			}
			if (c == "\"" || c == "\047") {
				quote = c
			} else if (c == "/" && substr(line, i + 1, 1) == "/") {
				break
			}
			out = out c
		}
		return out
	}
	function report(what) {
		printf "%s:%d: %s outside a test: %s\n", FILENAME, FNR, what, text
	}
' "${files[@]}")"

if [[ -n "$violations" ]]; then
	printf '%s\n' "$violations" >&2
	count="$(printf '%s\n' "$violations" | wc -l | tr -d ' ')"
	echo "zig-hygiene: $count forbidden call(s) outside tests" >&2
	exit 1
fi

echo "zig-hygiene: no forbidden calls outside tests in ${#files[@]} files"
