#!/usr/bin/env bash
# ruby-gem-plan.sh: decide what the release workflow does with a gem
# version on RubyGems.org. Trusted publishing pushes to a gem that already
# exists there. A gem new to RubyGems.org needs its owner's account once,
# so the workflow leaves it as a .gem file on the GitHub Release unless a
# pending trusted publisher is configured (docs/CONVENTIONS.md).
#
# Usage: ruby-gem-plan.sh GEM VERSION
#
# VERSION is the gem version as RubyGems prints it (0.1.0, 0.2.0.pre.rc.1).
# Prints one word:
#   publish  the gem is on RubyGems.org and this version is not
#   present  this version is already on RubyGems.org
#   new      RubyGems.org has no gem of this name
# Exits 1 when the registry cannot be asked or answers anything else, and 2
# on a usage error. RUBYGEMS_HOST overrides https://rubygems.org. Needs curl
# and jq.
set -euo pipefail

if [[ $# -ne 2 || -z "$1" || -z "$2" ]]; then
	echo "usage: ruby-gem-plan.sh GEM VERSION" >&2
	exit 2
fi
gem="$1"
version="$2"
host="${RUBYGEMS_HOST:-https://rubygems.org}"

body="$(mktemp)"
trap 'rm -f -- "$body"' EXIT

url="$host/api/v1/versions/$gem.json"
if ! status="$(curl -sS --max-time 30 -o "$body" -w '%{http_code}' -A libo11y-release-workflow "$url")"; then
	echo "ruby-gem-plan: could not reach $url" >&2
	exit 1
fi

case "$status" in
404)
	echo new
	;;
200)
	# The answer must be a list of version records, each with a number.
	if ! found="$(jq -er --arg v "$version" 'if type == "array" and all(.[]; type == "object" and (.number | type) == "string") then (any(.[]; .number == $v) | tostring) else error("not a version list") end' "$body" 2>/dev/null)"; then
		echo "ruby-gem-plan: $url did not answer with a JSON list of versions" >&2
		exit 1
	fi
	if [[ "$found" == "true" ]]; then
		echo present
	else
		echo publish
	fi
	;;
*)
	echo "ruby-gem-plan: $url answered HTTP $status" >&2
	exit 1
	;;
esac
