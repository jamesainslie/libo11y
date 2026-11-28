#!/usr/bin/env bash
# Tests for ops-release-check.sh against this checkout: the check passes at
# OPS_RELEASE_VERSION (default v0.1.0) and fails at another version, naming
# version.go, and --archive builds the release archive and its checksums
# with the layout an operator unpacks.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/ops-release-check.sh"
version="${OPS_RELEASE_VERSION:-v0.1.0}"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$@"
	else
		shasum -a 256 "$@"
	fi
}

# The checkout at the current version passes.
if "$script" "$version" >"$work/out" 2>&1; then
	echo "ok   passes at $version"
else
	fail "fails at $version"
	cat "$work/out" >&2
fi

# Another version fails on the first thing that names a version.
status=0
"$script" v9.9.9 >"$work/out" 2>&1 || status=$?
if [[ "$status" -eq 0 ]]; then
	fail "passes at v9.9.9"
elif ! grep -qF "version.go" "$work/out"; then
	fail "the failure at v9.9.9 does not name version.go"
	cat "$work/out" >&2
else
	echo "ok   fails at v9.9.9, naming version.go"
fi

# Usage errors exit 2.
for args in "" "--archive $version" "--archive"; do
	status=0
	# shellcheck disable=SC2086 # the cases are word lists on purpose
	"$script" $args >"$work/out" 2>&1 || status=$?
	if [[ "$status" -ne 2 ]] || ! grep -qF "usage" "$work/out"; then
		fail "arguments '$args': exited $status, want 2 with a usage line"
		cat "$work/out" >&2
	else
		echo "ok   refuses arguments '$args'"
	fi
done

# --archive writes the archive and SHA256SUMS, and the checksum matches.
plain="${version#v}"
name="libo11y-ops-v$plain"
dist="$work/dist"
if ! "$script" --archive "$version" "$dist" >"$work/out" 2>&1; then
	fail "--archive failed"
	cat "$work/out" >&2
else
	if [[ ! -f "$dist/$name.tar.gz" || ! -f "$dist/SHA256SUMS" ]]; then
		fail "--archive did not write $name.tar.gz and SHA256SUMS"
		ls -la "$dist" >&2 || true
	elif ! (cd "$dist" && sha256 -c SHA256SUMS >/dev/null); then
		fail "SHA256SUMS does not match the archive"
		cat "$dist/SHA256SUMS" >&2
	elif [[ "$(awk '{print $2}' "$dist/SHA256SUMS")" != "$name.tar.gz" ]]; then
		fail "SHA256SUMS does not name exactly $name.tar.gz"
		cat "$dist/SHA256SUMS" >&2
	else
		echo "ok   --archive writes the archive and matching checksums"
	fi

	mkdir -p "$work/unpacked"
	tar -xzf "$dist/$name.tar.gz" -C "$work/unpacked"
	top="$(cd "$work/unpacked" && ls -A)"
	if [[ "$top" != "$name" ]]; then
		fail "the archive's top level is '$top', want $name"
	else
		echo "ok   the archive unpacks into $name/"
	fi
	missing=""
	for rel in LICENSE README.md CHANGELOG.md thresholds.yaml kustomization.yaml \
		kubernetes/prometheusrule.yaml datasources/example.yaml \
		alerts/libo11y-rum.rules.yaml alerts/tests/libo11y-rum.test.yaml \
		dashboards/libo11y-rum-overview.json dashboards/libo11y-rum-session-explorer.json; do
		[[ -f "$work/unpacked/$name/$rel" ]] || missing+=" $rel"
	done
	if [[ -n "$missing" ]]; then
		fail "the archive lacks:$missing"
	else
		echo "ok   the archive holds the pack"
	fi
	strays="$(cd "$work/unpacked/$name" && find . -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' -o -path './test/*' -o -path './internal/*' \) | sort)"
	if [[ -n "$strays" ]]; then
		fail "the archive holds Go sources or test files: $strays"
	else
		echo "ok   the archive holds no Go sources or test files"
	fi
fi

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
