#!/usr/bin/env bash
# rn-fixture.sh: build and pack every @libo11y/* package, copy the
# tarballs into the fixture Expo app under stable names (.packs/), and
# install the fixture's dependencies from them.
#
# Usage: rn-fixture.sh   (from anywhere; needs bun and npm)
set -euo pipefail

ts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$ts_dir/fixtures/expo-app"
packs="$fixture/.packs"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

cd "$ts_dir"
bun run build
bun scripts/release.ts pack "$tmp" --allow-unreleased
rm -rf -- "$packs"
mkdir -p "$packs"
shopt -s nullglob
tarballs=("$tmp"/libo11y-*.tgz)
((${#tarballs[@]} > 0)) || {
	echo "rn-fixture: release.ts pack wrote no tarballs" >&2
	exit 1
}
for tgz in "${tarballs[@]}"; do
	base="$(basename "$tgz")"
	# libo11y-react-native-0.3.0.tgz -> libo11y-react-native.tgz
	cp -- "$tgz" "$packs/${base%-[0-9]*.[0-9]*.[0-9]*.tgz}.tgz"
done

cd "$fixture"
# The tarballs keep their names across versions, so drop the cached copies
# of the last install before installing from them again.
rm -rf -- node_modules/@libo11y
bun install
