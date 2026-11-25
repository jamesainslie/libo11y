#!/usr/bin/env bash
# zig-hygiene.sh: fail on calls that crash or print from library code in
# the Zig sources: @panic, catch unreachable (with or without an error
# capture) and std.debug.print, including an alias of it.
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
#     indentation) to the closing brace at the same indentation.
# The block rule relies on zig fmt's layout, which make zig-check enforces
# before running this script. Comments and multiline string lines (\\) are
# not code and are ignored. A // inside a string literal ends the checked
# part of its line, which can hide a call later on that line.
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
	FNR == 1 { in_test = 0; indent = "" }
	{
		line = $0
		if (in_test) {
			if (line == indent "}") in_test = 0
			next
		}
		if (line ~ /^[ \t]*test( "([^"\\]|\\.)*"| [A-Za-z_][A-Za-z0-9_]*)? [{]$/) {
			match(line, /^[ \t]*/)
			indent = substr(line, 1, RLENGTH)
			in_test = 1
			next
		}
		if (line ~ /^[ \t]*\\\\/) next
		code = line
		sub(/\/\/.*/, "", code)
		text = line
		sub(/^[ \t]+/, "", text)
		if (code ~ /@panic[(]/) printf "%s:%d: @panic outside a test: %s\n", FILENAME, FNR, text
		if (code ~ /catch[ \t]+(\|[^|]*\|[ \t]*)?unreachable/) printf "%s:%d: catch unreachable outside a test: %s\n", FILENAME, FNR, text
		if (code ~ /std\.debug\.print([^A-Za-z0-9_]|$)/) printf "%s:%d: std.debug.print outside a test: %s\n", FILENAME, FNR, text
	}
' "${files[@]}")"

if [[ -n "$violations" ]]; then
	printf '%s\n' "$violations" >&2
	count="$(printf '%s\n' "$violations" | wc -l | tr -d ' ')"
	echo "zig-hygiene: $count forbidden call(s) outside tests" >&2
	exit 1
fi

echo "zig-hygiene: no forbidden calls outside tests in ${#files[@]} files"
