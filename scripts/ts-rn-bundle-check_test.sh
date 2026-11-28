#!/usr/bin/env bash
# Tests for ts-rn-bundle-check.sh against fixture packages installed in a
# throwaway project: it passes a package whose React Native and Expo
# imports stay external, picks the react-native export condition, and
# fails one whose module graph reaches a Node builtin from any entry
# point, or that lacks an export the caller names. Needs bun and jq.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/ts-rn-bundle-check.sh"

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
		mkdir -p "$(dirname "$dir/${file%%=*}")"
		printf '%s\n' "${file#*=}" >"$dir/${file%%=*}"
	done
}

# React Native, Expo and React are not installed: the check must keep them external.
fixture @fx/native '{ "name": "@fx/native", "type": "module", "exports": { ".": "./index.js", "./expo": "./expo.js", "./package.json": "./package.json" } }' \
	'index.js=import { AppState } from "react-native"; import { createElement } from "react"; export function setupNative() { return [AppState, createElement]; }' \
	'expo.js=import { File } from "expo-file-system"; import { useSegments } from "expo-router"; import { Asset } from "@expo/vector-icons"; import { codegen } from "@react-native/codegen"; export const expo = [File, useSegments, Asset, codegen];'
fixture @fx/conditional '{ "name": "@fx/conditional", "type": "module", "exports": { ".": { "react-native": "./native.js", "default": "./node.js" } } }' \
	'native.js=export const which = "native";' \
	'node.js=import { readFileSync } from "node:fs"; export const which = readFileSync;'
fixture @fx/stub '{ "name": "@fx/stub", "type": "module", "exports": { ".": "./index.js" } }' \
	'index.js=import { readFileSync } from "node:fs"; export const read = readFileSync;'
fixture @fx/deep '{ "name": "@fx/deep", "type": "module", "exports": { ".": "./index.js", "./internal": "./internal.js" } }' \
	'index.js=export const setup = () => 1;' \
	'internal.js=import { helper } from "./helper.js"; export const work = helper;' \
	'helper.js=import { AsyncLocalStorage } from "node:async_hooks"; export const helper = AsyncLocalStorage;'

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

expect_pass "keeps react-native, react and expo-* external" "$project" @fx/native=setupNative
expect_pass "resolves the react-native export condition" "$project" @fx/conditional=which
expect_failure "fails a node: import" 1 "ts-rn-bundle-check: the React Native bundle reaches Node builtins" "$project" @fx/stub
expect_failure "names the builtin" 1 "node:fs" "$project" @fx/stub
expect_failure "fails a builtin reached from a subpath export" 1 "node:async_hooks" "$project" @fx/deep=setup
expect_failure "fails a missing named export" 1 "bun build failed" "$project" @fx/native=setupNative,teardown
expect_failure "fails a package that is not installed" 1 "@fx/absent is not installed" "$project" @fx/absent
expect_failure "fails a directory with no node_modules" 1 "has no node_modules" "$work" @fx/native
expect_failure "refuses no package" 2 "usage" "$project"

if [[ -n "$(find "$project" -maxdepth 1 -name '.rn-bundle-*')" ]]; then
	fail "the script left its work directory in the project"
fi

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
