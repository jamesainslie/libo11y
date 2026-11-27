#!/usr/bin/env bash
# rust-release-check.sh: validate the libo11y Rust workspace for a lockstep
# release.
#
# Usage: rust-release-check.sh [VERSION] [--workspace DIR] [--changelog FILE]
#
# Defaults:
#   VERSION    v0.0.0 (leading v is optional; `make rust-release-check` and
#              `make release-check` pass RUST_RELEASE_VERSION).
#   WORKSPACE  <repo_root>/rust
#   CHANGELOG  <workspace>/CHANGELOG.md
#
# Checks:
#   1. Every publishable workspace crate (publish != false) is at VERSION and
#      pins every workspace-internal crate dependency to =VERSION.
#   2. Every publishable crate declares description, license, repository, and
#      readme metadata, and has LICENSE and README.md on disk.
#   3. When VERSION is not 0.0.0, CHANGELOG has a non-empty `## [VERSION]`
#      section (validated via scripts/release-notes.sh).
#   4. Workspace-internal dependencies form an acyclic publish order.
#   5. `cargo package --list --allow-dirty` succeeds for every publishable
#      crate, includes Cargo.toml, LICENSE, and README.md, and excludes
#      conformance/ and agent artifacts.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

version="v0.0.0"
version_set=false
workspace=""
changelog=""

usage() {
	echo "usage: rust-release-check.sh [VERSION] [--workspace DIR] [--changelog FILE]" >&2
}

while (($# > 0)); do
	case "$1" in
	--workspace)
		if (($# < 2)) || [[ -z "$2" ]]; then
			usage
			exit 2
		fi
		workspace="$2"
		shift 2
		;;
	--workspace=*)
		workspace="${1#--workspace=}"
		if [[ -z "$workspace" ]]; then
			usage
			exit 2
		fi
		shift
		;;
	--changelog)
		if (($# < 2)) || [[ -z "$2" ]]; then
			usage
			exit 2
		fi
		changelog="$2"
		shift 2
		;;
	--changelog=*)
		changelog="${1#--changelog=}"
		if [[ -z "$changelog" ]]; then
			usage
			exit 2
		fi
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	-*)
		echo "rust-release-check: unknown option: $1" >&2
		exit 2
		;;
	*)
		if [[ "$version_set" == true ]]; then
			usage
			exit 2
		fi
		version="$1"
		version_set=true
		shift
		;;
	esac
done

plain="${version#v}"
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
if [[ ! "$plain" =~ $semver ]]; then
	echo "rust-release-check: $version is not a semantic version X.Y.Z[-prerelease]" >&2
	exit 1
fi

if [[ -z "$workspace" ]]; then
	workspace="$repo_root/rust"
fi
if [[ -z "$changelog" ]]; then
	changelog="$workspace/CHANGELOG.md"
fi

fail() {
	echo "rust-release-check: $*" >&2
	exit 1
}

manifest="$workspace/Cargo.toml"
[[ -f "$manifest" ]] || fail "workspace manifest missing: $manifest"

metadata="$(cargo metadata --no-deps --format-version 1 --manifest-path "$manifest")" ||
	fail "cargo metadata failed for $manifest"

# Publishable workspace crates: in cargo metadata, `publish = false` is
# encoded as an empty array `[]`, whereas publishable crates have `null` or
# a non-empty registry list.
pub_json="$(jq -c '
	.workspace_members as $members
	| [.packages[]
		| select(.id as $id | $members | index($id))
		| select((.publish | type) != "array" or (.publish | length) > 0)
	]
' <<<"$metadata")"

count="$(jq 'length' <<<"$pub_json")"
((count > 0)) || fail "no publishable crates found in $workspace"

# Build the set of publishable crate names.
declare -A is_pub=()
while IFS= read -r name; do
	is_pub["$name"]=1
done < <(jq -r '.[].name' <<<"$pub_json")

# Check lockstep version, exact internal dependency pinning, metadata fields,
# and LICENSE / README.md presence for every publishable crate.
while IFS=$'\t' read -r name pkg_version pkg_manifest description license repository readme; do
	if [[ "$pkg_version" != "$plain" ]]; then
		fail "$name is at version $pkg_version, want $plain"
	fi
	[[ -n "$description" ]] || fail "$name: missing package.description"
	[[ -n "$license" ]] || fail "$name: missing package.license"
	[[ -n "$repository" ]] || fail "$name: missing package.repository"
	[[ -n "$readme" ]] || fail "$name: missing package.readme"

	crate_dir="$(dirname "$pkg_manifest")"
	[[ -f "$crate_dir/LICENSE" ]] || fail "$name: missing LICENSE file in $crate_dir"
	[[ -f "$crate_dir/$readme" ]] || fail "$name: missing readme file $crate_dir/$readme"

	# Verify every workspace-internal dependency pins exact version =VERSION.
	while IFS=$'\t' read -r dep_name dep_req dep_kind; do
		[[ -n "$dep_name" ]] || continue
		if [[ -n "${is_pub[$dep_name]+x}" ]]; then
			if [[ "$dep_req" != "=$plain" ]]; then
				fail "$name depends on workspace crate $dep_name with req \"$dep_req\" (kind ${dep_kind:-normal}), want \"=$plain\""
			fi
		fi
	done < <(jq -r --arg name "$name" '
		.[] | select(.name == $name)
		| .dependencies[]
		| [.name, .req, (.kind // "normal")]
		| @tsv
	' <<<"$pub_json")
done < <(jq -r '
	.[]
	| [.name, .version, .manifest_path, (.description // ""), (.license // ""), (.repository // ""), (.readme // "")]
	| @tsv
' <<<"$pub_json")

echo "rust-release-check: $count publishable crate(s) match lockstep version $plain and metadata checks"

# Verify changelog notes for real releases (non-0.0.0).
if [[ "$plain" != "0.0.0" ]]; then
	"$script_dir/release-notes.sh" "$plain" "$changelog" >/dev/null ||
		fail "missing or empty release notes for $plain in $changelog"
	echo "rust-release-check: $changelog has release notes for $plain"
else
	[[ -f "$changelog" ]] || fail "changelog missing: $changelog"
	grep -q '^## \[Unreleased\]' "$changelog" || fail "$changelog lacks ## [Unreleased]"
	echo "rust-release-check: $changelog present with ## [Unreleased] (unreleased 0.0.0)"
fi

# Verify normal/build workspace dependencies form a DAG (acyclic publish order).
declare -A dep_list=()
while IFS= read -r name; do
	deps=""
	while IFS= read -r dep_name; do
		[[ -n "$dep_name" ]] || continue
		if [[ -n "${is_pub[$dep_name]+x}" && "$dep_name" != "$name" ]]; then
			deps="${deps:+$deps }$dep_name"
		fi
	done < <(jq -r --arg name "$name" '
		.[] | select(.name == $name)
		| .dependencies[]
		| select((.kind // "normal") != "dev")
		| .name
	' <<<"$pub_json" | sort -u)
	dep_list["$name"]="$deps"
done < <(jq -r '.[].name' <<<"$pub_json" | sort)

declare -A resolved=()
ordered=()
while ((${#ordered[@]} < count)); do
	progressed=false
	for name in $(printf '%s\n' "${!is_pub[@]}" | sort); do
		[[ -z "${resolved[$name]+x}" ]] || continue
		ready=true
		for dep in ${dep_list[$name]}; do
			if [[ -z "${resolved[$dep]+x}" ]]; then
				ready=false
				break
			fi
		done
		if [[ "$ready" == true ]]; then
			resolved["$name"]=1
			ordered+=("$name")
			progressed=true
		fi
	done
	if [[ "$progressed" == false ]]; then
		fail "cyclic workspace dependency among publishable crates"
	fi
done

echo "rust-release-check: publish order verified: ${ordered[*]}"

# Verify packaging file lists for every publishable crate.
for name in "${ordered[@]}"; do
	pkg_manifest="$(jq -r --arg name "$name" '.[] | select(.name == $name) | .manifest_path' <<<"$pub_json")"
	readme="$(jq -r --arg name "$name" '.[] | select(.name == $name) | .readme' <<<"$pub_json")"
	listing="$(cargo package --list --allow-dirty --manifest-path "$pkg_manifest" 2>&1)" ||
		fail "$name: cargo package --list failed: $listing"

	grep -qxF "Cargo.toml" <<<"$listing" || fail "$name: package listing missing Cargo.toml"
	grep -qxF "LICENSE" <<<"$listing" || fail "$name: package listing missing LICENSE"
	grep -qxF "$readme" <<<"$listing" || fail "$name: package listing missing $readme"
	if grep -Eq '(^|/)(conformance/|CLAUDE\.md$|AGENTS\.md$)' <<<"$listing"; then
		fail "$name: package listing includes disallowed files"
	fi
	echo "rust-release-check: $name package listing ok"
done

echo "rust-release-check: OK, $count crates at v$plain are ready"
