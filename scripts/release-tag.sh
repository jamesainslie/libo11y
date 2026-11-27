#!/usr/bin/env bash
# release-tag.sh: route a release tag to what it releases. The release
# workflow (.github/workflows/release.yml) runs it first and passes its
# output to every later job.
#
# Usage: release-tag.sh TAG
#
# Release tags:
#   go/vX.Y.Z                    github.com/jamesainslie/libo11y/go
#   go/<sub>/vX.Y.Z              the o11ygin, o11yconnect and o11ysql submodules
#   ts/vX.Y.Z                    every @libo11y/* package, at one version
#   zig/vX.Y.Z                   the libo11y Zig package (libo11y-zig)
#   rust/vX.Y.Z                  every libo11y Rust crate, at one version
#
# Prints one key=value line each, for $GITHUB_OUTPUT:
#   kind        go, ts, zig or rust
#   dir         the released directory: go, go/<sub>, ts, zig or rust
#   module      the Go module path, @libo11y for TypeScript, libo11y-zig for Zig, or libo11y-rust for Rust
#   version     X.Y.Z[-prerelease], without the v
#   prerelease  true when the version has a -prerelease suffix
# and a one-line summary on stderr. Exits 1 for a tag that is not a release
# tag or whose version is not strict semver, and 2 on a usage error.
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
	echo "usage: release-tag.sh TAG" >&2
	exit 2
fi
tag="$1"

case "$tag" in
go/o11ygin/v* | go/o11yconnect/v* | go/o11ysql/v*)
	kind=go
	dir="${tag%/v*}"
	;;
go/v*)
	kind=go
	dir=go
	;;
ts/v*)
	kind=ts
	dir=ts
	;;
zig/v*)
	kind=zig
	dir=zig
	;;
rust/v*)
	kind=rust
	dir=rust
	;;
*)
	echo "release-tag: $tag is not a release tag (go/vX.Y.Z, go/<submodule>/vX.Y.Z, ts/vX.Y.Z, zig/vX.Y.Z or rust/vX.Y.Z)" >&2
	exit 1
	;;
esac
version="${tag#"$dir"/v}"

# Strict semver X.Y.Z with an optional -prerelease suffix. A 0.x version is
# a normal release, not a prerelease.
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
if [[ ! "$version" =~ $semver ]]; then
	echo "release-tag: $tag: $version is not a semantic version X.Y.Z[-prerelease]" >&2
	exit 1
fi
prerelease=false
if [[ -n "${BASH_REMATCH[4]}" ]]; then
	prerelease=true
fi

case "$kind" in
go)
	module="github.com/jamesainslie/libo11y/$dir"
	;;
ts)
	module="@libo11y"
	;;
zig)
	module="libo11y-zig"
	;;
rust)
	module="libo11y-rust"
	;;
esac

printf '%s\n' "kind=$kind" "dir=$dir" "module=$module" "version=$version" "prerelease=$prerelease"
echo "$tag releases $module v$version (prerelease: $prerelease)" >&2
