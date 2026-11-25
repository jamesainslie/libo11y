#!/usr/bin/env bash
# Tests for ts-browser-bundle-check.sh against fixture packages installed
# in a throwaway project: it passes a package that bundles for the
# browser, and fails one whose module graph reaches a Node builtin from
# any entry point, or that lacks an export the caller names. Needs bun
# and jq.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/ts-browser-bundle-check.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

# fixture <package> <package.json> <file=source>...: installs a package in
# the fixture project's node_modules.
project="$work/project"
fixture() {
	local pkg="$1" manifest="$2"
	shift 2
	local dir="$project/node_modules/$pkg"
	mkdir -p "$dir"
	printf '%s\n' "$manifest" >"$dir/package.json"
	local file
	for file in "$@"; do
		printf '%s\n' "${file#*=}" >"$dir/${file%%=*}"
	done
}

fixture @fx/clean '{ "name": "@fx/clean", "type": "module", "exports": { ".": "./index.js", "./background": "./background.js", "./package.json": "./package.json" } }' \
	'index.js=export function setup() { return globalThis.location; }' \
	'background.js=export const background = () => globalThis.chrome;'
fixture @fx/string '{ "name": "@fx/string", "type": "module", "exports": "./index.js" }' \
	'index.js=export const setup = () => 1;'
fixture @fx/main '{ "name": "@fx/main", "type": "module", "main": "./index.js" }' \
	'index.js=export const main = 1;'
fixture @fx/stub '{ "name": "@fx/stub", "type": "module", "exports": { ".": "./index.js" } }' \
	'index.js=import { readFileSync } from "node:fs"; export const read = readFileSync;'
fixture @fx/polyfill '{ "name": "@fx/polyfill", "type": "module", "exports": { ".": "./index.js" } }' \
	'index.js=import { join } from "path"; export const j = join;'
fixture @fx/deep '{ "name": "@fx/deep", "type": "module", "exports": { ".": "./index.js", "./worker": "./worker.js" } }' \
	'index.js=export const setup = () => 1;' \
	'worker.js=import { helper } from "./helper.js"; export const work = helper;' \
	'helper.js=import { AsyncLocalStorage } from "node:async_hooks"; export const helper = AsyncLocalStorage;'
fixture @fx/patterns '{ "name": "@fx/patterns", "type": "module", "exports": { ".": "./index.js", "./locale/*": "./locale/*.js" } }' \
	'index.js=export const setup = () => 1;'

# expect_pass <name> <args...>: the script succeeds and says so.
expect_pass() {
	local name="$1"
	shift
	if ! "$script" "$@" >"$work/out" 2>"$work/err"; then
		fail "$name: exited non-zero"
		cat "$work/out" "$work/err" >&2
		return
	fi
	if ! grep -qF "no Node builtins" "$work/out"; then
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

expect_pass "bundles every entry point and a named export" "$project" @fx/clean=setup
expect_pass "bundles a string exports field" "$project" @fx/string=setup
expect_pass "bundles a package with no exports field" "$project" @fx/main=main
expect_pass "skips export patterns" "$project" @fx/patterns
expect_pass "bundles several packages" "$project" @fx/clean=setup @fx/string
expect_failure "fails a node: import Bun stubs out" 1 "node:fs" "$project" @fx/stub
expect_failure "fails a builtin Bun polyfills" 1 "node:path" "$project" @fx/polyfill
expect_failure "fails a builtin reached from a subpath export" 1 "node:async_hooks" "$project" @fx/deep=setup
expect_failure "fails one bad package among good ones" 1 "node:fs" "$project" @fx/clean @fx/stub
expect_failure "fails a missing named export" 1 "bun build --target=browser failed" "$project" @fx/clean=setup,teardown
expect_failure "fails a package that is not installed" 1 "@fx/absent is not installed" "$project" @fx/absent
expect_failure "fails a directory with no node_modules" 1 "has no node_modules" "$work" @fx/clean
expect_failure "refuses no package" 2 "usage" "$project"
expect_failure "refuses an empty export list" 2 "usage" "$project" @fx/clean=

if [[ -n "$(find "$project" -maxdepth 1 -name '.browser-bundle-*')" ]]; then
	fail "the script left its work directory in the project"
fi

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
