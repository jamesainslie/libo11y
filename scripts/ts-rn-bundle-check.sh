#!/usr/bin/env bash
# ts-rn-bundle-check.sh: bundle installed packages the way a React Native
# app's bundler resolves them, with the react-native export condition and
# React Native, React and the Expo modules left external, and fail if the
# bundle reaches a Node builtin.
#
# Usage: ts-rn-bundle-check.sh DIR PACKAGE[=NAME,...]...
#
# DIR is a project with every PACKAGE installed under DIR/node_modules.
# The entry re-exports every subpath in each package's exports map, so
# each entry point is bundled, and re-exports each NAME from the package
# root, so a missing export fails the build. Hermes has no Node builtins
# and Metro has no stubs for them, so the check reads the build's
# metafile and fails on any node: module or Bun polyfill in the module
# graph, as scripts/ts-browser-bundle-check.sh does for the browser.
#
# scripts/ts-release-check.sh runs it on the packed tarballs and the
# release workflow's smoke job on the versions the registry serves.
# Needs bun and jq.
set -euo pipefail

usage() {
	echo "usage: ts-rn-bundle-check.sh DIR PACKAGE[=NAME,...]..." >&2
	exit 2
}

fail() {
	echo "ts-rn-bundle-check: $*" >&2
	exit 1
}

(($# >= 2)) || usage
dir="$1"
shift
[[ -d "$dir/node_modules" ]] || fail "$dir has no node_modules"

work="$(mktemp -d "$dir/.rn-bundle-XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
entry="$work/entry.js"
: >"$entry"

n=0
for arg in "$@"; do
	pkg="${arg%%=*}"
	names=""
	if [[ "$arg" == *=* ]]; then
		names="${arg#*=}"
		[[ -n "$names" ]] || usage
	fi
	manifest="$dir/node_modules/$pkg/package.json"
	[[ -f "$manifest" ]] || fail "$pkg is not installed in $dir"
	# A string exports field, or none, is the root entry point alone. A
	# pattern or the manifest itself is not a module to bundle.
	subpaths="$(jq -r '
		if (.exports | type) == "object" and (.exports | keys | all(startswith("."))) then .exports | keys[] else "." end
		| select(. != "./package.json" and (contains("*") | not))
	' "$manifest")"
	[[ -n "$subpaths" ]] || fail "$pkg exports no entry point"
	while IFS= read -r subpath; do
		printf 'export * as m%d from "%s%s";\n' "$n" "$pkg" "${subpath#.}" >>"$entry"
		n=$((n + 1))
	done <<<"$subpaths"
	if [[ -n "$names" ]]; then
		printf 'export { %s } from "%s";\n' "${names//,/, }" "$pkg" >>"$entry"
	fi
done

meta="$work/meta.json"
if ! (cd "$dir" && bun build --target=browser --format=esm --conditions=react-native \
	--external react-native --external react --external 'expo-*' --external expo \
	--outdir "$work/out" --metafile="$meta" "$entry" >"$work/build.log" 2>&1); then
	cat "$work/build.log" >&2
	fail "bun build failed for $*"
fi

# A builtin stays an external node: import; one Bun can polyfill becomes a
# node: input resolved through its bun-vfs directory.
builtins="$(jq -r '
	[
		(.inputs | to_entries[] | .key, (.value.imports[]? | .path)),
		(.outputs[] | .imports[]? | .path)
	]
	| map(select(startswith("node:") or contains("bun-vfs$$")))
	| unique[]
' "$meta")"
if [[ -n "$builtins" ]]; then
	echo "ts-rn-bundle-check: the React Native bundle reaches Node builtins:" >&2
	while IFS= read -r builtin; do
		echo "  $builtin" >&2
	done <<<"$builtins"
	fail "$* must not import Node builtins"
fi

echo "ts-rn-bundle-check: ${*%%=*} bundle for React Native with no Node builtins"
