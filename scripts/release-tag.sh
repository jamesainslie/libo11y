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
#   go/o11yrum/vX.Y.Z            the o11yrum RUM gateway module, on its own version line
#   ts/vX.Y.Z                    every @libo11y/* package, at one version
#   zig/vX.Y.Z                   the libo11y Zig package (libo11y-zig)
#   python/vX.Y.Z                the libo11y Python distribution on PyPI
#   rust/vX.Y.Z                  every libo11y Rust crate, at one version
#   c/vX.Y.Z                     the libo11y C11 library (libo11y-c)
#   dotnet/vX.Y.Z                every Libo11y.* NuGet package, at one version
#   ops/vX.Y.Z                   the libo11y RUM ops pack (libo11y-ops), a GitHub Release archive
#
# Prints one key=value line each, for $GITHUB_OUTPUT:
#   kind        go, ts, zig, python, rust, c, dotnet or ops
#   dir         the released directory: go, go/<sub>, go/o11yrum, ts, zig, python, rust, c, dotnet or ops
#   module      the Go module path, @libo11y for TypeScript, libo11y-zig for Zig, libo11y for Python, libo11y-rust for Rust, libo11y-c for C, libo11y-dotnet for .NET, or libo11y-ops for the ops pack
#   version     X.Y.Z[-prerelease], without the v
#   prerelease  true when the version has a -prerelease suffix
#   lockstep    true for the Go modules released together at one version on
#               one commit (go and its o11ygin, o11yconnect and o11ysql
#               submodules), false otherwise
#   changelog   the changelog holding the release notes, from the repository root
# and a one-line summary on stderr. Exits 1 for a tag that is not a release
# tag or whose version is not strict semver, and 2 on a usage error.
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
	echo "usage: release-tag.sh TAG" >&2
	exit 2
fi
tag="$1"

lockstep=false
case "$tag" in
go/o11ygin/v* | go/o11yconnect/v* | go/o11ysql/v*)
	kind=go
	dir="${tag%/v*}"
	lockstep=true
	;;
go/o11yrum/v*)
	kind=go
	dir=go/o11yrum
	;;
go/v*)
	kind=go
	dir=go
	lockstep=true
	;;
ts/v*)
	kind=ts
	dir=ts
	;;
zig/v*)
	kind=zig
	dir=zig
	;;
python/v*)
	kind=python
	dir=python
	;;
rust/v*)
	kind=rust
	dir=rust
	;;
c/v*)
	kind=c
	dir=c
	;;
dotnet/v*)
	kind=dotnet
	dir=dotnet
	;;
ops/v*)
	kind=ops
	dir=ops
	;;
*)
	echo "release-tag: $tag is not a release tag (go/vX.Y.Z, go/<submodule>/vX.Y.Z, go/o11yrum/vX.Y.Z, ts/vX.Y.Z, zig/vX.Y.Z, python/vX.Y.Z, rust/vX.Y.Z, c/vX.Y.Z, dotnet/vX.Y.Z or ops/vX.Y.Z)" >&2
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
python)
	module="libo11y"
	;;
rust)
	module="libo11y-rust"
	;;
c)
	module="libo11y-c"
	;;
dotnet)
	module="libo11y-dotnet"
	;;
ops)
	module="libo11y-ops"
	;;
esac

# The lockstep submodules take their notes from the main module's
# changelog; every other release has its own.
changelog="$dir/CHANGELOG.md"
if [[ "$lockstep" == "true" ]]; then
	changelog=go/CHANGELOG.md
fi

printf '%s\n' "kind=$kind" "dir=$dir" "module=$module" "version=$version" "prerelease=$prerelease" \
	"lockstep=$lockstep" "changelog=$changelog"
echo "$tag releases $module v$version (prerelease: $prerelease)" >&2
