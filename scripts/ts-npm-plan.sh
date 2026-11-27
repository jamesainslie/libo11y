#!/usr/bin/env bash
# ts-npm-plan.sh: decide which packed @libo11y/* tarballs a ts/vX.Y.Z
# release publishes to npm, and answer the release jobs' questions about
# that plan.
#
# npm trusted publishing cannot create a package. The first version of a
# package new to npm is published by a maintainer's own npm login, and its
# trusted publisher is set up after that. Until then a release leaves the
# package out of npm and attaches its tarball to the GitHub Release.
#
# Usage:
#   ts-npm-plan.sh plan VERSION LIST
#     LIST holds one tarball path per line, in dependency order, as
#     `bun scripts/release.ts pack` prints them. Prints one line per
#     tarball, in the same order: ACTION<TAB>NAME<TAB>FILE, where FILE is
#     the tarball's file name and ACTION is
#       publish  the package is on npm and the version is not
#       present  npm already has the version, so it is not published again
#       new      the package is not on npm yet, so it stays a tarball
#     Fails, printing nothing, when a tarball is not at VERSION, when the
#     registry cannot answer, or when a package on npm (publish or present)
#     depends on a new package through dependencies, peerDependencies or
#     optionalDependencies, because npm consumers of it would get a broken
#     install. The release writes the plan beside the tarballs as plan.tsv.
#   ts-npm-plan.sh names PLAN registry|tarball
#     Prints, space separated on one line, the packages that install from
#     the registry (publish and present) or from a tarball (new).
#   ts-npm-plan.sh specs PLAN VERSION NAME...
#     Prints one npm install argument per line: NAME@VERSION for a package
#     on npm, or the tarball path beside PLAN for a new package, followed
#     by the tarball of every new package it depends on.
#   ts-npm-plan.sh notes PLAN REPO TAG
#     Prints the GitHub Release notes paragraph listing the new packages
#     with the release asset URLs to install each from, or nothing when
#     every package is on npm.
#   ts-npm-plan.sh check DIR NAME...
#     In a project with each NAME installed, fails when `npm ls --all`
#     reports a missing or invalid dependency, or when an entry point in a
#     package's exports map does not resolve to a file under Node.
#
# The registry is asked through `npm view`. Set NPM to another command to
# answer instead (the tests use a fake). Needs jq and tar, and node and npm
# for check.
set -euo pipefail

npm="${NPM:-npm}"

# The dependency fields npm installs for a consumer of a package.
DEPENDENCY_FIELDS='[.dependencies, .peerDependencies, .optionalDependencies] | map(select(. != null) | keys[]) | unique[]'

usage() {
	cat >&2 <<'EOF'
usage: ts-npm-plan.sh plan VERSION LIST
       ts-npm-plan.sh names PLAN registry|tarball
       ts-npm-plan.sh specs PLAN VERSION NAME...
       ts-npm-plan.sh notes PLAN REPO TAG
       ts-npm-plan.sh check DIR NAME...
EOF
	exit 2
}

fail() {
	echo "ts-npm-plan: $*" >&2
	exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

# registry_has SPEC FIELD WANT: succeeds when `npm view SPEC FIELD` prints
# WANT, fails when the registry has no such package or version (E404), and
# exits when the registry cannot answer at all.
registry_has() {
	local spec="$1" field="$2" want="$3" out status=0
	out="$("$npm" view "$spec" "$field" 2>"$tmp/npm-err")" || status=$?
	if ((status == 0)); then
		[[ "$out" == "$want" ]]
		return
	fi
	if grep -q 'E404' "$tmp/npm-err"; then
		return 1
	fi
	cat "$tmp/npm-err" >&2
	fail "could not look up $spec on the registry (npm view exited $status)"
}

# manifest TARBALL: prints the package.json inside a packed tarball.
manifest() {
	tar -xOzf "$1" package/package.json
}

cmd_plan() {
	(($# == 2)) || usage
	local version="$1" list="$2"
	[[ -f "$list" ]] || fail "$list does not exist"
	local tarballs=()
	local line
	while IFS= read -r line || [[ -n "$line" ]]; do
		if [[ -n "$line" ]]; then
			tarballs+=("$line")
		fi
	done <"$list"
	((${#tarballs[@]} > 0)) || fail "$list lists no tarballs"

	local names=() actions=() files=()
	local -A action_of=() deps_of=()
	local tarball json name pkg_version action
	for tarball in "${tarballs[@]}"; do
		[[ -f "$tarball" ]] || fail "$tarball does not exist"
		json="$(manifest "$tarball")" || fail "$tarball holds no package/package.json"
		name="$(jq -r .name <<<"$json")"
		pkg_version="$(jq -r .version <<<"$json")"
		if [[ "$pkg_version" != "$version" ]]; then
			fail "$(basename "$tarball") is $name@$pkg_version, not version $version"
		fi
		if ! registry_has "$name" name "$name"; then
			action=new
		elif registry_has "$name@$version" version "$version"; then
			action=present
		else
			action=publish
		fi
		names+=("$name")
		actions+=("$action")
		files+=("$(basename "$tarball")")
		action_of["$name"]="$action"
		deps_of["$name"]="$(jq -r "$DEPENDENCY_FIELDS" <<<"$json")"
	done

	# A package on npm must not depend on one that is not.
	local problems=() dep i
	for i in "${!names[@]}"; do
		name="${names[$i]}"
		[[ "${actions[$i]}" == new ]] && continue
		while IFS= read -r dep; do
			[[ -n "$dep" ]] || continue
			if [[ "${action_of[$dep]:-}" == new ]]; then
				problems+=("$name depends on $dep, which is not on npm yet")
			fi
		done <<<"${deps_of[$name]}"
	done
	if ((${#problems[@]} > 0)); then
		local problem
		for problem in "${problems[@]}"; do
			echo "ts-npm-plan: $problem" >&2
		done
		fail "npm consumers of those packages would get a broken install. Publish each new package to npm by hand first, then rerun the release (docs/CONVENTIONS.md, TypeScript releases)"
	fi

	for i in "${!names[@]}"; do
		printf '%s\t%s\t%s\n' "${actions[$i]}" "${names[$i]}" "${files[$i]}"
	done
}

# read_plan PLAN: loads the plan into the plan_* arrays.
plan_names=()
plan_actions=()
plan_files=()
declare -A plan_index=()
read_plan() {
	local plan="$1" action name file
	[[ -f "$plan" ]] || fail "$plan does not exist"
	while IFS=$'\t' read -r action name file; do
		[[ -n "$action" ]] || continue
		case "$action" in
		publish | present | new) ;;
		*) fail "$plan: unknown action $action for $name" ;;
		esac
		plan_index["$name"]="${#plan_names[@]}"
		plan_names+=("$name")
		plan_actions+=("$action")
		plan_files+=("$file")
	done <"$plan"
}

cmd_names() {
	(($# == 2)) || usage
	local plan="$1" which="$2"
	[[ "$which" == registry || "$which" == tarball ]] || usage
	read_plan "$plan"
	local out=() i
	for i in "${!plan_names[@]}"; do
		if { [[ "$which" == tarball ]] && [[ "${plan_actions[$i]}" == new ]]; } ||
			{ [[ "$which" == registry ]] && [[ "${plan_actions[$i]}" != new ]]; }; then
			out+=("${plan_names[$i]}")
		fi
	done
	echo "${out[*]}"
}

# closure DIR NAME...: prints NAME and, after the names given, every new
# package a new one among them depends on, each once, as
# ACTION<TAB>NAME<TAB>FILE.
closure() {
	local dir="$1"
	shift
	local queue=("$@") i=0 name idx dep
	local -A visited=()
	while ((i < ${#queue[@]})); do
		name="${queue[$i]}"
		i=$((i + 1))
		[[ -z "${visited[$name]:-}" ]] || continue
		visited["$name"]=1
		[[ -n "${plan_index[$name]:-}" ]] || fail "$name is not in the plan"
		idx="${plan_index[$name]}"
		printf '%s\t%s\t%s\n' "${plan_actions[$idx]}" "$name" "${plan_files[$idx]}"
		[[ "${plan_actions[$idx]}" == new ]] || continue
		[[ -f "$dir/${plan_files[$idx]}" ]] || fail "$dir/${plan_files[$idx]} does not exist"
		while IFS= read -r dep; do
			[[ -n "$dep" && -n "${plan_index[$dep]:-}" ]] || continue
			if [[ "${plan_actions[${plan_index[$dep]}]}" == new ]]; then
				queue+=("$dep")
			fi
		done < <(manifest "$dir/${plan_files[$idx]}" | jq -r "$DEPENDENCY_FIELDS")
	done
}

cmd_specs() {
	(($# >= 3)) || usage
	local plan="$1" version="$2"
	shift 2
	read_plan "$plan"
	local dir action name file
	dir="$(cd "$(dirname "$plan")" && pwd)"
	closure "$dir" "$@" >"$tmp/closure"
	while IFS=$'\t' read -r action name file; do
		if [[ "$action" == new ]]; then
			echo "$dir/$file"
		else
			echo "$name@$version"
		fi
	done <"$tmp/closure"
}

cmd_notes() {
	(($# == 3)) || usage
	local plan="$1" repo="$2" tag="$3"
	read_plan "$plan"
	local new=() i
	for i in "${!plan_names[@]}"; do
		if [[ "${plan_actions[$i]}" == new ]]; then
			new+=("${plan_names[$i]}")
		fi
	done
	((${#new[@]} > 0)) || return 0

	local dir url list="" n=${#new[@]}
	dir="$(cd "$(dirname "$plan")" && pwd)"
	url="https://github.com/$repo/releases/download/$tag"
	for i in "${!new[@]}"; do
		if ((i > 0 && i == n - 1)); then
			list+=" and "
		elif ((i > 0)); then
			list+=", "
		fi
		list+="\`${new[$i]}\`"
	done
	if ((n == 1)); then
		echo "Not on npm yet: $list is attached to this release as a tarball. Install it with:"
	else
		echo "Not on npm yet: $list are attached to this release as tarballs. Install one with:"
	fi
	echo
	local name action dep file urls
	for name in "${new[@]}"; do
		urls=""
		while IFS=$'\t' read -r action dep file; do
			if [[ "$action" == new ]]; then
				urls+="${urls:+ }$url/$file"
			fi
		done < <(closure "$dir" "$name")
		echo "- \`$name\`: \`npm install $urls\`"
	done
}

cmd_check() {
	(($# >= 2)) || usage
	local dir="$1"
	shift
	[[ -d "$dir/node_modules" ]] || fail "$dir has no node_modules"
	local name manifest_path subpaths=()
	for name in "$@"; do
		manifest_path="$dir/node_modules/$name/package.json"
		[[ -f "$manifest_path" ]] || fail "$name is not installed in $dir"
		# A string exports field, or none, is the root entry point alone. A
		# pattern is not one module to resolve.
		while IFS= read -r subpath; do
			subpaths+=("$name${subpath#.}")
		done < <(jq -r '
			if (.exports | type) == "object" then .exports | keys[] else "." end
			| select(contains("*") | not)
		' "$manifest_path")
	done
	if ! (cd "$dir" && npm ls --all >"$tmp/npm-ls" 2>&1); then
		cat "$tmp/npm-ls" >&2
		fail "npm ls found problems in $dir"
	fi
	local unresolved
	unresolved="$(cd "$dir" && node --input-type=module -e '
		import { existsSync } from "node:fs";
		import { fileURLToPath } from "node:url";
		for (const spec of process.argv.slice(1)) {
			let ok = false;
			try {
				ok = existsSync(fileURLToPath(import.meta.resolve(spec)));
			} catch {}
			if (!ok) console.log(spec);
		}
	' "${subpaths[@]}")"
	if [[ -n "$unresolved" ]]; then
		local spec
		while IFS= read -r spec; do
			echo "ts-npm-plan: $spec does not resolve to a file under Node" >&2
		done <<<"$unresolved"
		fail "entry points do not resolve in $dir"
	fi
}

(($# >= 1)) || usage
command="$1"
shift
case "$command" in
plan) cmd_plan "$@" ;;
names) cmd_names "$@" ;;
specs) cmd_specs "$@" ;;
notes) cmd_notes "$@" ;;
check) cmd_check "$@" ;;
*) usage ;;
esac
