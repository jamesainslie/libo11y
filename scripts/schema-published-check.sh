#!/usr/bin/env bash
# schema-published-check.sh: confirm the spec's schema URL serves the
# generated schema file byte for byte. Run it before tagging spec/vX.Y.Z;
# a spec version is not released until its schema URL serves its file.
# Needs the network, so it is a release step, not a `make ci` gate.
#
# Usage: schema-published-check.sh [URL]   (default: the manifest's
# schema_url). The file compared is always spec/schemas/<version>, where
# <version> is the manifest schema_url's last path segment.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$root/spec/registry/manifest.yaml"

schema_url="$(sed -n 's|^schema_url: *||p' "$manifest")"
if [[ -z "$schema_url" ]]; then
	echo "error: no schema_url in $manifest" >&2
	exit 2
fi
version="${schema_url##*/}"
want="$root/spec/schemas/$version"
if [[ ! -f "$want" ]]; then
	echo "error: $want does not exist; run make spec-generate" >&2
	exit 2
fi

url="${1:-$schema_url}"
fetched="$(mktemp)"
trap 'rm -f -- "$fetched"' EXIT

if ! curl -fsS --retry 3 --retry-delay 2 --max-time 15 -o "$fetched" "$url"; then
	echo "error: $url could not be fetched; publish spec/schemas/$version there first" >&2
	exit 1
fi
if ! cmp -s -- "$fetched" "$want"; then
	echo "error: $url does not match spec/schemas/$version" >&2
	exit 1
fi
echo "ok: $url serves spec/schemas/$version"
