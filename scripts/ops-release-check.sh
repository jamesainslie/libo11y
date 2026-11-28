#!/usr/bin/env bash
# ops-release-check.sh: validate the libo11y RUM ops pack at VERSION, or
# build the archive its GitHub Release attaches.
#
# Usage:
#   ops-release-check.sh VERSION
#   ops-release-check.sh --archive VERSION DIR
#
# VERSION is vX.Y.Z (the leading v is optional). The first form checks, in
# order, failing on the first problem:
#   1. ops/internal/version/version.go holds Version = "X.Y.Z".
#   2. ops/CHANGELOG.md has a `## [X.Y.Z]` section with notes.
#   3. The committed dashboards, rules and kustomization are what opsgen
#      generates for X.Y.Z (opsgen -check -version X.Y.Z).
#   4. Every runbook_url in ops/alerts/*.rules.yaml points at ops/vX.Y.Z.
#   5. The release archive holds every tracked file under ops/ except the
#      Go sources, go.mod, go.sum, the generator's packages and the
#      integration environment in ops/test.
#   6. When kubectl is on PATH, `kubectl kustomize` builds the unpacked
#      archive.
# The second form writes libo11y-ops-vX.Y.Z.tar.gz and SHA256SUMS into DIR,
# which the release workflow attaches to the release. The archive unpacks
# into libo11y-ops-vX.Y.Z/ with dashboards/, alerts/ (rules and their
# promtool tests), kubernetes/, datasources/, kustomization.yaml,
# thresholds.yaml, README.md, CHANGELOG.md and the repository's LICENSE.
# Exits 2 on a usage error.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
	echo "usage: ops-release-check.sh VERSION | ops-release-check.sh --archive VERSION DIR" >&2
	exit 2
}

fail() {
	echo "ops-release-check: $*" >&2
	exit 1
}

# The archive's directories and files, relative to ops/ (and LICENSE from
# the repository root).
archive_dirs=(dashboards alerts kubernetes datasources)
archive_files=(kustomization.yaml thresholds.yaml README.md CHANGELOG.md)

# What the archive leaves out of ops/, as git pathspecs: the Go module and
# its generator, and the integration environment.
excluded=(
	':(exclude,glob)ops/*.go'
	':(exclude)ops/go.mod'
	':(exclude)ops/go.sum'
	':(exclude)ops/.golangci.yml'
	':(exclude)ops/cmd'
	':(exclude)ops/internal'
	':(exclude)ops/test'
)

sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$@"
	else
		shasum -a 256 "$@"
	fi
}

# build_archive PLAIN DIR: write libo11y-ops-vPLAIN.tar.gz and SHA256SUMS
# into DIR. With GNU tar the archive is reproducible: sorted names, numeric
# root ownership and the commit time as every file's time.
build_archive() {
	local plain="$1" dist="$2" name="libo11y-ops-v$1"
	local stage
	stage="$(mktemp -d)"
	mkdir -p "$stage/$name" "$dist"
	local d f
	for d in "${archive_dirs[@]}"; do
		cp -R "$root/ops/$d" "$stage/$name/"
	done
	for f in "${archive_files[@]}"; do
		cp "$root/ops/$f" "$stage/$name/"
	done
	cp "$root/LICENSE" "$stage/$name/"
	local tar_flags=()
	if tar --version 2>/dev/null | grep -q 'GNU tar'; then
		local mtime
		mtime="$(git -C "$root" log -1 --format=%ct 2>/dev/null || echo 0)"
		tar_flags=(--sort=name --owner=0 --group=0 --numeric-owner --mtime="@$mtime")
	fi
	tar "${tar_flags[@]}" -C "$stage" -cf - "$name" | gzip -n >"$dist/$name.tar.gz"
	(cd "$dist" && sha256 "$name.tar.gz" >SHA256SUMS)
	rm -rf "$stage"
}

if [[ "${1:-}" == "--archive" ]]; then
	[[ $# -eq 3 && -n "$2" && -n "$3" ]] || usage
	plain="${2#v}"
	build_archive "$plain" "$3"
	echo "ops-release-check: wrote $3/libo11y-ops-v$plain.tar.gz and $3/SHA256SUMS"
	exit 0
fi
[[ $# -eq 1 && -n "$1" ]] || usage
plain="${1#v}"
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
[[ "$plain" =~ $semver ]] || fail "$1 is not a semantic version vX.Y.Z[-prerelease]"

# 1. The version the generator writes into runbook links.
got="$(sed -nE 's/^const Version = "([^"]+)"$/\1/p' "$root/ops/internal/version/version.go")"
[[ "$got" == "$plain" ]] || fail "ops/internal/version/version.go holds Version ${got:-unset}, want $plain"

# 2. The release notes.
"$root/scripts/release-notes.sh" "$plain" "$root/ops/CHANGELOG.md" >/dev/null ||
	fail "ops/CHANGELOG.md has no notes for $plain; a release commit adds a dated ## [$plain] section"
echo "ops-release-check: version.go and CHANGELOG.md match $plain"

# 3. The committed artifacts are generated for this version.
(cd "$root/ops" && go run ./cmd/opsgen -check -version "$plain" -out .) ||
	fail "the committed pack differs from what opsgen generates for $plain; run make ops-generate"
echo "ops-release-check: the committed pack is what opsgen generates for $plain"

# 4. Runbook links point at this release's README.
urls="$(grep -ho 'runbook_url: .*' "$root"/ops/alerts/*.rules.yaml | sed 's/^runbook_url: //')"
[[ -n "$urls" ]] || fail "no runbook_url in ops/alerts/*.rules.yaml"
stale="$(grep -vF "/ops/v$plain/" <<<"$urls" || true)"
[[ -z "$stale" ]] || fail "runbook_url not at ops/v$plain: $stale"
echo "ops-release-check: $(wc -l <<<"$urls" | tr -d ' ') runbook links point at ops/v$plain"

# 5. The archive holds the pack and nothing it should leave out.
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT
name="libo11y-ops-v$plain"
build_archive "$plain" "$tmp/dist"
mkdir -p "$tmp/unpacked"
tar -xzf "$tmp/dist/$name.tar.gz" -C "$tmp/unpacked"
tar -tzf "$tmp/dist/$name.tar.gz" | sort
[[ -f "$tmp/unpacked/$name/LICENSE" ]] || fail "the archive lacks LICENSE"
missing=""
while IFS= read -r rel; do
	[[ -f "$tmp/unpacked/$name/${rel#ops/}" ]] || missing+=" $rel"
done < <(git -C "$root" ls-files -- ops "${excluded[@]}")
[[ -z "$missing" ]] || fail "the archive lacks tracked files:$missing"
extra=""
while IFS= read -r rel; do
	rel="${rel#./}"
	[[ "$rel" == LICENSE ]] && continue
	git -C "$root" ls-files --error-unmatch -- "ops/$rel" >/dev/null 2>&1 || extra+=" $rel"
done < <(cd "$tmp/unpacked/$name" && find . -type f)
[[ -z "$extra" ]] || fail "the archive holds files git does not track:$extra"
echo "ops-release-check: the archive holds every tracked pack file"

# 6. The unpacked archive builds with kustomize.
if command -v kubectl >/dev/null 2>&1; then
	kubectl kustomize "$tmp/unpacked/$name" >/dev/null || fail "kubectl kustomize of the unpacked archive failed"
	echo "ops-release-check: kubectl kustomize builds the unpacked archive"
else
	echo "ops-release-check: kubectl is not on PATH; skipped the kustomize build"
fi
echo "ops-release-check: ops v$plain is ready to release"
