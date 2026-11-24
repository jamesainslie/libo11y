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
#
# Prints one key=value line each, for $GITHUB_OUTPUT:
#   kind        go or ts
#   dir         the released directory: go, go/<sub> or ts
#   module      the Go module path, or @libo11y for the TypeScript packages
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
*)
	echo "release-tag: $tag is not a release tag (go/vX.Y.Z, go/<submodule>/vX.Y.Z or ts/vX.Y.Z)" >&2
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

if [[ "$kind" == go ]]; then
	module="github.com/jamesainslie/libo11y/$dir"
else
	module="@libo11y"
fi

printf '%s\n' "kind=$kind" "dir=$dir" "module=$module" "version=$version" "prerelease=$prerelease"
echo "$tag releases $module v$version (prerelease: $prerelease)" >&2
