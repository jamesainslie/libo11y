#!/usr/bin/env bash
# Tests for ruby-hygiene.sh against fixture trees. Needs ruby.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/ruby-hygiene.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

# tree <name> <path=content>...: writes each file under a new directory and
# prints the directory. \n in content is a newline.
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
	if ! grep -qF "no forbidden constructs" "$work/out"; then
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

expect_pass "passes clean library code" "$(tree clean 'a.rb=def add(a, b)\n  a + b\nrescue ArgumentError\n  0\nend')"

expect_failure "fails puts" 1 "a.rb:2: puts in library code" "$(tree puts 'a.rb=def f\n  puts "hello"\nend')"
expect_failure "fails puts on a receiver" 1 "a.rb:2: puts in library code" "$(tree io-puts 'a.rb=def f\n  $stdout.puts "hello"\nend')"
expect_failure "fails pp" 1 "a.rb:1: pp in library code" "$(tree pp 'a.rb=pp(value)')"
expect_failure "fails binding.pry" 1 "a.rb:2: binding.pry in library code" "$(tree pry 'a.rb=def f\n  binding.pry\nend')"
expect_failure "fails binding.irb" 1 "a.rb:1: binding.irb in library code" "$(tree irb 'a.rb=binding.irb')"
expect_failure "fails debugger" 1 "a.rb:1: debugger in library code" "$(tree debugger 'a.rb=debugger')"
expect_failure "fails byebug" 1 "a.rb:1: byebug in library code" "$(tree byebug 'a.rb=byebug')"
expect_failure "fails rescue Exception" 1 "a.rb:3: rescue Exception in library code" \
	"$(tree rescue 'a.rb=begin\n  work\nrescue Exception => e\n  nil\nend')"
expect_failure "fails rescue of a list with Exception" 1 "a.rb:3: rescue Exception in library code" \
	"$(tree rescue-list 'a.rb=begin\n  work\nrescue ArgumentError, ::Exception\n  nil\nend')"
expect_failure "reports every finding" 1 "a.rb:2: pp in library code" "$(tree two 'a.rb=puts 1\npp 2')"
expect_failure "reads nested directories" 1 "deep/b.rb:1: puts in library code" "$(tree nested 'a.rb=x = 1' 'deep/b.rb=puts 1')"

expect_pass "passes the words in comments, strings, symbols and heredocs" "$(tree words \
	'a.rb=# puts nearly every request in the first bucket\nMSG = "puts pp debugger rescue Exception"\nNAMES = %i[puts pp byebug]\nTEXT = <<~T\n  binding.pry\n  rescue Exception\nT\nx = :puts')"
expect_pass "passes a method that is defined with a listed name" "$(tree def 'a.rb=class Sink\n  def puts(line) = write(line)\nend')"
expect_pass "passes rescue of a namespaced Exception class" "$(tree namespaced 'a.rb=begin\n  work\nrescue Timeout::Exception, MyLib::Exception\n  nil\nend')"
expect_pass "passes identifiers that only contain a listed name" "$(tree idents 'a.rb=inputs = outputs\nppid = Process.pid\ndebugger_enabled = false')"
expect_pass "skips generated files" "$(tree generated 'spec/generated/tables.rb=puts 1' 'a.rb=x = 1')"

expect_failure "fails on a file that does not parse" 1 "a.rb: does not parse" "$(tree broken 'a.rb=def f(')"
expect_failure "fails on a missing directory" 2 "is not a directory" "$work/nope"

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
