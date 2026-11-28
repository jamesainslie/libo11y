#!/usr/bin/env bash
# ops-promtool.sh: run promtool 3.15.1, downloading the release binary on
# first use into a cache and checking it against a pinned SHA-256.
# Usage: ops-promtool.sh <promtool arguments...>
#
# OPS_PROMTOOL_BASE_URL replaces the GitHub releases URL, for a mirror. The
# tarball must still match the pinned checksum.
set -euo pipefail

version=3.15.1
case "$(uname -s)-$(uname -m)" in
Linux-x86_64) arch=linux-amd64 sum=6a726885328ad9efebbf36e876ce2fb6225468a71fd1e7ce3ba666d5f4d97a84 ;;
Linux-aarch64 | Linux-arm64) arch=linux-arm64 sum=ceb6d21493c37ca0b4513b147642797c68cf39a0f50a444d50e1e80c74f21b26 ;;
Darwin-arm64) arch=darwin-arm64 sum=0d4d3d9837d27e4fcd0bd16d115b1b8d6732a4bf3e69107f1190d9ef653ae471 ;;
Darwin-x86_64) arch=darwin-amd64 sum=c89fcb30045d8c394c9d93e96cbbee3aaf2448a48326b417e811eb4e528edf88 ;;
*)
	echo "ops-promtool: no pinned promtool for $(uname -s)-$(uname -m)" >&2
	exit 2
	;;
esac

base="${OPS_PROMTOOL_BASE_URL:-https://github.com/prometheus/prometheus/releases/download}"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/libo11y/promtool-$version-$arch"
bin="$cache/promtool"

sha256() {
	if command -v sha256sum >/dev/null; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

if [[ ! -x "$bin" ]]; then
	tmp="$(mktemp -d)"
	trap 'rm -rf -- "$tmp"' EXIT
	name="prometheus-$version.$arch"
	curl -fsSL --retry 3 -o "$tmp/$name.tar.gz" "$base/v$version/$name.tar.gz"
	got="$(sha256 "$tmp/$name.tar.gz")"
	if [[ "$got" != "$sum" ]]; then
		echo "ops-promtool: checksum mismatch for $name.tar.gz: got $got, want $sum" >&2
		exit 1
	fi
	tar -xzf "$tmp/$name.tar.gz" -C "$tmp" "$name/promtool"
	mkdir -p "$cache"
	# Another run may install at the same time; each moves its own copy
	# into place, and the rename is atomic.
	part="$(mktemp "$cache/promtool.XXXXXX")"
	cp "$tmp/$name/promtool" "$part"
	chmod 0755 "$part"
	mv -f "$part" "$bin"
fi
exec "$bin" "$@"
