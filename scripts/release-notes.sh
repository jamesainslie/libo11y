#!/usr/bin/env bash
# release-notes.sh: print one version's release notes from a Keep a
# Changelog file. The release workflow publishes them as the GitHub
# Release body, so a tag whose version has no notes cannot be released.
#
# Usage: release-notes.sh VERSION [CHANGELOG]   (VERSION as 0.1.0 or
# v0.1.0; CHANGELOG defaults to go/CHANGELOG.md). Prints the body of the
# `## [VERSION]` section: everything after the heading up to the next
# `## [` heading, without the link reference definitions that end the
# file, trimmed of leading and trailing blank lines. Fails if the section
# is missing or empty.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -lt 1 || $# -gt 2 || -z "$1" ]]; then
	echo "usage: release-notes.sh VERSION [CHANGELOG]" >&2
	exit 2
fi
version="${1#v}"
changelog="${2:-$root/go/CHANGELOG.md}"
if [[ ! -f "$changelog" ]]; then
	echo "release-notes: $changelog does not exist" >&2
	exit 2
fi
heading="## [$version]"

# awk exits 3 when the heading is missing and 4 when the section is empty.
status=0
notes="$(awk -v heading="$heading" '
	{ lines[NR] = $0 }
	END {
		# The link reference definitions ending the file belong to no section.
		last = NR
		while (last > 0 && (lines[last] ~ /^[[:space:]]*$/ || lines[last] ~ /^\[.+\]: /)) {
			last--
		}
		start = 0
		for (i = 1; i <= last; i++) {
			if (start == 0) {
				if (lines[i] == heading || index(lines[i], heading " ") == 1) {
					start = i + 1
				}
			} else if (index(lines[i], "## [") == 1) {
				last = i - 1
				break
			}
		}
		if (start == 0) {
			exit 3
		}
		while (start <= last && lines[start] ~ /^[[:space:]]*$/) {
			start++
		}
		while (last >= start && lines[last] ~ /^[[:space:]]*$/) {
			last--
		}
		if (start > last) {
			exit 4
		}
		for (i = start; i <= last; i++) {
			print lines[i]
		}
	}
' "$changelog")" || status=$?

case "$status" in
0) ;;
3)
	echo "release-notes: no $heading section in $changelog" >&2
	exit 1
	;;
4)
	echo "release-notes: the $heading section in $changelog is empty" >&2
	exit 1
	;;
*)
	echo "release-notes: reading $changelog failed (awk exit $status)" >&2
	exit 1
	;;
esac
printf '%s\n' "$notes"
