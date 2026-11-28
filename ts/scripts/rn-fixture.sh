#!/usr/bin/env bash
# rn-fixture.sh: build and pack every @libo11y/* package, copy the
# tarballs into the fixture Expo app under stable names (.packs/), and
# install the fixture's dependencies with those packages.
#
# Usage: rn-fixture.sh   (from anywhere; needs bun, npm, node and tar)
#
# Bun caches a local tarball by its path and reinstalls the cached
# contents after the file changes, and refuses a tarball whose integrity
# differs from bun.lock when it is not cached. So the script first writes
# the new tarballs' integrity into the fixture's bun.lock
# (rn-fixture-lock.ts), then installs, then extracts each tarball over its
# installed copy, so the fixture always runs this checkout's packages.
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

# Only the tarballs the fixture depends on: the others are packed but unused.
for tgz in "$packs"/*.tgz; do
	grep -qF "\"file:.packs/$(basename "$tgz")\"" "$fixture/package.json" || rm -f -- "$tgz"
done
used=("$packs"/*.tgz)
((${#used[@]} > 0)) || {
	echo "rn-fixture: the fixture depends on none of the packed tarballs" >&2
	exit 1
}
bun scripts/rn-fixture-lock.ts "$fixture"

cd "$fixture"
bun install
for tgz in "$packs"/*.tgz; do
	name="$(tar -xzOf "$tgz" package/package.json | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).name))')"
	[[ "$name" == @libo11y/* ]] || {
		echo "rn-fixture: $tgz holds $name, not an @libo11y package" >&2
		exit 1
	}
	rm -rf -- "node_modules/$name"
	mkdir -p "node_modules/$name"
	tar -xzf "$tgz" -C "node_modules/$name" --strip-components=1
done
echo "rn-fixture: installed $(find "$packs" -name '*.tgz' | wc -l) @libo11y packages from .packs"
