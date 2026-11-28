#!/usr/bin/env bash
# Tests for ops-promtool.sh: it installs promtool from a release tarball
# only when the tarball matches the pinned SHA-256, caches it, and runs
# the real promtool 3.15.1.
#
# The checksum cases use a fake release served from a file:// URL, so they
# need no network. The last case downloads the real promtool into the
# shared cache (or reuses it there) and checks its version.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/ops-promtool.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

sha256() {
	if command -v sha256sum >/dev/null; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

# A fake release for every platform the script pins. Its promtool prints a
# marker and its arguments.
release="$work/release/v3.15.1"
mkdir -p "$release"
for arch in linux-amd64 linux-arm64 darwin-arm64 darwin-amd64; do
	dir="$work/build/prometheus-3.15.1.$arch"
	mkdir -p "$dir"
	printf '#!/bin/sh\necho "fake promtool $*"\n' >"$dir/promtool"
	chmod +x "$dir/promtool"
	tar -czf "$release/prometheus-3.15.1.$arch.tar.gz" -C "$work/build" "prometheus-3.15.1.$arch"
done

# run <script> <cache>: run a copy against the fake release.
run() {
	XDG_CACHE_HOME="$2" OPS_PROMTOOL_BASE_URL="file://$work/release" "$1" check rules x.yaml
}

uname_arch() {
	case "$(uname -s)-$(uname -m)" in
	Linux-x86_64) echo linux-amd64 ;;
	Linux-aarch64 | Linux-arm64) echo linux-arm64 ;;
	Darwin-arm64) echo darwin-arm64 ;;
	Darwin-x86_64) echo darwin-amd64 ;;
	*) echo unknown ;;
	esac
}
arch="$(uname_arch)"
if [[ "$arch" == unknown ]]; then
	echo "ops-promtool_test: no pinned promtool for $(uname -s)-$(uname -m), skipped"
	exit 0
fi
this_sum="$(sha256 "$release/prometheus-3.15.1.$arch.tar.gz")"

# A tarball whose checksum differs from the pin is refused, and nothing is
# left in the cache.
cache="$work/cache-mismatch"
copy="$work/mismatch.sh"
sed -E "s/sum=[0-9a-f]{64}/sum=$(printf '0%.0s' {1..64})/g" "$script" >"$copy"
chmod +x "$copy"
if run "$copy" "$cache" >"$work/out" 2>"$work/err"; then
	fail "mismatch: exited zero"
	cat "$work/out" "$work/err" >&2
elif [[ -n "$(find "$cache" -type f 2>/dev/null)" ]]; then
	fail "mismatch: left files in the cache"
	find "$cache" -type f >&2
elif ! grep -qi 'checksum' "$work/err"; then
	fail "mismatch: stderr does not mention the checksum"
	cat "$work/err" >&2
else
	echo "ok   mismatch"
fi

# A tarball matching the pin is installed, run with the arguments, and
# reused from the cache on the next run.
cache="$work/cache-match"
copy="$work/match.sh"
sed -E "s/sum=[0-9a-f]{64}/sum=$this_sum/g" "$script" >"$copy"
chmod +x "$copy"
if ! got="$(run "$copy" "$cache" 2>"$work/err")"; then
	fail "match: exited non-zero"
	cat "$work/err" >&2
elif [[ "$got" != "fake promtool check rules x.yaml" ]]; then
	fail "match: output $got"
elif [[ ! -x "$cache/libo11y/promtool-3.15.1-$arch/promtool" ]]; then
	fail "match: promtool is not in the cache"
else
	rm -f "$release/prometheus-3.15.1.$arch.tar.gz"
	if ! got="$(run "$copy" "$cache" 2>"$work/err")" || [[ "$got" != "fake promtool check rules x.yaml" ]]; then
		fail "match: the second run did not use the cache"
		cat "$work/err" >&2
	else
		echo "ok   match"
	fi
fi

# The real promtool, from the shared cache.
if ! got="$("$script" --version 2>&1)"; then
	fail "version: exited non-zero"
	echo "$got" >&2
elif ! grep -q '^promtool, version 3\.15\.1 ' <<<"$got"; then
	fail "version: output differs"
	echo "$got" >&2
else
	echo "ok   version"
fi

if [[ "$failures" -gt 0 ]]; then
	echo "$failures failure(s)" >&2
	exit 1
fi
