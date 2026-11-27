#!/usr/bin/env bash
# Tests for ts-npm-plan.sh against fixture tarballs and a fake npm that
# answers `npm view` from a fixture registry, so no test reaches the
# network. The plan publishes packages npm already has, leaves a package
# that is new to npm as a tarball, and refuses a plan where a package on
# npm depends on one that is not. The check command installs fixture
# tarballs offline. Needs jq, node and npm.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/ts-npm-plan.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

# The fake npm reads $FAKE_REGISTRY, one "name version" line per published
# version, or "name ERROR" for a package the registry cannot answer for.
# It prints what npm 11 prints for `npm view NAME FIELD` and
# `npm view NAME@VERSION version`, E404 included.
mkdir -p "$work/bin"
cat >"$work/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == view && $# -eq 3 ]] || { echo "fake npm: unexpected arguments: $*" >&2; exit 2; }
spec="$2" field="$3"
name="$spec" version=""
rest="${spec:1}"
if [[ "$rest" == *@* ]]; then
	name="${spec%@*}"
	version="${spec##*@}"
fi
if grep -qxF "$name ERROR" "$FAKE_REGISTRY"; then
	echo "npm error code ETIMEDOUT" >&2
	exit 1
fi
if ! grep -q "^$name " "$FAKE_REGISTRY"; then
	echo "npm error code E404" >&2
	echo "npm error 404 Not Found - GET https://registry.npmjs.org/$name - Not found" >&2
	exit 1
fi
if [[ -z "$version" ]]; then
	[[ "$field" == name ]] || { echo "fake npm: unexpected field $field" >&2; exit 2; }
	echo "$name"
	exit 0
fi
if grep -qxF "$name $version" "$FAKE_REGISTRY"; then
	echo "$version"
	exit 0
fi
echo "npm error code E404" >&2
echo "npm error 404 No match found for version $version" >&2
exit 1
EOF
chmod +x "$work/bin/npm"
export NPM="$work/bin/npm"

# tarball <dir> <name> <version> [package.json fields as jq object]: packs
# a fixture package the way npm pack names it, with an index.js the
# exports map points at, and prints its path.
tarball() {
	local dir="$1" name="$2" version="$3" extra="${4:-{\}}"
	local file stage
	file="$(sed -e 's/^@//' -e 's|/|-|' <<<"$name")-$version.tgz"
	stage="$(mktemp -d "$work/stage-XXXXXX")"
	mkdir -p "$stage/package" "$dir"
	jq -n --arg name "$name" --arg version "$version" --argjson extra "$extra" \
		'{name: $name, version: $version, type: "module", exports: {".": "./index.js"}} + $extra' \
		>"$stage/package/package.json"
	echo 'export const ok = true;' >"$stage/package/index.js"
	tar -czf "$dir/$file" -C "$stage" package
	echo "$dir/$file"
}

# expect_plan <name> <want stdout> <list file> [version]: plan succeeds and
# prints want.
expect_plan() {
	local name="$1" want="$2" list="$3" version="${4:-1.2.3}"
	local got
	if ! got="$("$script" plan "$version" "$list" 2>"$work/err")"; then
		fail "$name: exited non-zero"
		cat "$work/err" >&2
		return
	fi
	if [[ "$got" != "$want" ]]; then
		fail "$name: plan differs"
		printf -- '--- want\n%s\n--- got\n%s\n' "$want" "$got" >&2
		return
	fi
	echo "ok   $name"
}

# expect_failure <name> <stderr substring> <args...>: the script exits 1,
# prints nothing on stdout, and explains itself on stderr.
expect_failure() {
	local name="$1" want_err="$2"
	shift 2
	local status=0
	"$script" "$@" >"$work/out" 2>"$work/err" || status=$?
	if [[ "$status" -ne 1 ]]; then
		fail "$name: exited $status, want 1"
		cat "$work/out" "$work/err" >&2
		return
	fi
	if [[ -s "$work/out" ]]; then
		fail "$name: wrote to stdout"
		cat "$work/out" >&2
		return
	fi
	if ! grep -qF -- "$want_err" "$work/err"; then
		fail "$name: stderr lacks \"$want_err\""
		cat "$work/err" >&2
		return
	fi
	echo "ok   $name"
}

# expect_output <name> <want stdout> <args...>: the script succeeds and
# prints want.
expect_output() {
	local name="$1" want="$2"
	shift 2
	local got
	if ! got="$("$script" "$@" 2>"$work/err")"; then
		fail "$name: exited non-zero"
		cat "$work/err" >&2
		return
	fi
	if [[ "$got" != "$want" ]]; then
		fail "$name: output differs"
		printf -- '--- want\n%s\n--- got\n%s\n' "$want" "$got" >&2
		return
	fi
	echo "ok   $name"
}

tab=$'\t'

# Every package already on npm at an older version: each one publishes, in
# the order pack listed them.
packs="$work/existing"
{
	tarball "$packs" @libo11y/spec 1.2.3
	tarball "$packs" @libo11y/core 1.2.3 '{"dependencies": {"@libo11y/spec": "1.2.3"}}'
} >"$work/existing.txt"
export FAKE_REGISTRY="$work/registry"
printf '%s\n' "@libo11y/spec 1.2.2" "@libo11y/core 1.2.2" >"$FAKE_REGISTRY"
expect_plan "publishes every package npm already has" "$(
	cat <<EOF
publish${tab}@libo11y/spec${tab}libo11y-spec-1.2.3.tgz
publish${tab}@libo11y/core${tab}libo11y-core-1.2.3.tgz
EOF
)" "$work/existing.txt"

# A rerun after spec published: spec is present and is not published again.
printf '%s\n' "@libo11y/spec 1.2.2" "@libo11y/spec 1.2.3" "@libo11y/core 1.2.2" >"$FAKE_REGISTRY"
expect_plan "skips a version npm already has" "$(
	cat <<EOF
present${tab}@libo11y/spec${tab}libo11y-spec-1.2.3.tgz
publish${tab}@libo11y/core${tab}libo11y-core-1.2.3.tgz
EOF
)" "$work/existing.txt"

# A new package that depends on packages npm has, and a second new package
# that depends on the first: both stay tarballs.
packs="$work/mixed"
{
	tarball "$packs" @libo11y/spec 1.2.3
	tarball "$packs" @libo11y/web 1.2.3 '{"dependencies": {"@libo11y/spec": "1.2.3"}}'
	tarball "$packs" @libo11y/rum 1.2.3 '{"dependencies": {"@libo11y/web": "1.2.3", "@libo11y/spec": "1.2.3"}}'
	tarball "$packs" @libo11y/rum-react 1.2.3 '{"dependencies": {"@libo11y/rum": "1.2.3"}, "devDependencies": {"@libo11y/rum": "1.2.3"}}'
} >"$work/mixed.txt"
printf '%s\n' "@libo11y/spec 1.2.2" "@libo11y/web 1.2.2" >"$FAKE_REGISTRY"
mixed_plan="$(
	cat <<EOF
publish${tab}@libo11y/spec${tab}libo11y-spec-1.2.3.tgz
publish${tab}@libo11y/web${tab}libo11y-web-1.2.3.tgz
new${tab}@libo11y/rum${tab}libo11y-rum-1.2.3.tgz
new${tab}@libo11y/rum-react${tab}libo11y-rum-react-1.2.3.tgz
EOF
)"
expect_plan "leaves packages new to npm as tarballs" "$mixed_plan" "$work/mixed.txt"
"$script" plan 1.2.3 "$work/mixed.txt" >"$packs/plan.tsv" 2>/dev/null

# A package on npm may not depend on a new one, through dependencies,
# peerDependencies or optionalDependencies. A devDependency is never
# installed for a consumer, so it does not count.
for field in dependencies peerDependencies optionalDependencies; do
	packs="$work/broken-$field"
	{
		tarball "$packs" @libo11y/rum 1.2.3
		tarball "$packs" @libo11y/web 1.2.3 "{\"$field\": {\"@libo11y/rum\": \"1.2.3\"}}"
	} >"$work/broken-$field.txt"
	printf '%s\n' "@libo11y/web 1.2.2" >"$FAKE_REGISTRY"
	expect_failure "refuses a package on npm whose $field name a new package" \
		"@libo11y/web depends on @libo11y/rum, which is not on npm yet" \
		plan 1.2.3 "$work/broken-$field.txt"
done
packs="$work/dev-only"
{
	tarball "$packs" @libo11y/rum 1.2.3
	tarball "$packs" @libo11y/web 1.2.3 '{"devDependencies": {"@libo11y/rum": "1.2.3"}}'
} >"$work/dev-only.txt"
expect_plan "allows a devDependency on a new package" "$(
	cat <<EOF
new${tab}@libo11y/rum${tab}libo11y-rum-1.2.3.tgz
publish${tab}@libo11y/web${tab}libo11y-web-1.2.3.tgz
EOF
)" "$work/dev-only.txt"

# A version already on npm that depends on a new package is refused too:
# the fix in every case is to publish the new package by hand first.
printf '%s\n' "@libo11y/web 1.2.3" >"$FAKE_REGISTRY"
expect_failure "refuses a present package that depends on a new package" \
	"@libo11y/web depends on @libo11y/rum, which is not on npm yet" \
	plan 1.2.3 "$work/broken-dependencies.txt"

printf '%s\n' "@libo11y/spec 1.2.2" "@libo11y/core 1.2.2" >"$FAKE_REGISTRY"
expect_failure "refuses a tarball at another version" \
	"libo11y-spec-1.2.3.tgz is @libo11y/spec@1.2.3, not version 1.2.4" \
	plan 1.2.4 "$work/existing.txt"

printf '%s\n' "@libo11y/spec ERROR" "@libo11y/core 1.2.2" >"$FAKE_REGISTRY"
expect_failure "fails when the registry cannot answer" \
	"could not look up @libo11y/spec on the registry" \
	plan 1.2.3 "$work/existing.txt"

: >"$work/empty.txt"
expect_failure "refuses an empty tarball list" "lists no tarballs" plan 1.2.3 "$work/empty.txt"

# names: the packages on npm and the packages left as tarballs.
plan="$work/mixed/plan.tsv"
expect_output "names the packages on npm" "@libo11y/spec @libo11y/web" names "$plan" registry
expect_output "names the packages left as tarballs" "@libo11y/rum @libo11y/rum-react" names "$plan" tarball
printf '%s\n' "publish${tab}@libo11y/spec${tab}libo11y-spec-1.2.3.tgz" >"$work/all-published.tsv"
expect_output "names no tarballs when every package is on npm" "" names "$work/all-published.tsv" tarball

# specs: a package on npm installs from the registry, a new one from its
# tarball, together with every new package it depends on.
expect_output "installs packages on npm from the registry" "$(
	cat <<EOF
@libo11y/spec@1.2.3
@libo11y/web@1.2.3
EOF
)" specs "$plan" 1.2.3 @libo11y/spec @libo11y/web
expect_output "installs a new package and the new packages it needs from tarballs" "$(
	cat <<EOF
@libo11y/web@1.2.3
$work/mixed/libo11y-rum-react-1.2.3.tgz
$work/mixed/libo11y-rum-1.2.3.tgz
EOF
)" specs "$plan" 1.2.3 @libo11y/web @libo11y/rum-react
expect_failure "refuses a package the plan does not list" "@libo11y/nope is not in" \
	specs "$plan" 1.2.3 @libo11y/nope

# notes: one line per package left as a tarball, with the release asset
# URLs to install it from.
expect_output "writes no notes when no package is left as a tarball" "" \
	notes "$work/all-published.tsv" jamesainslie/libo11y ts/v1.2.3
url="https://github.com/jamesainslie/libo11y/releases/download/ts/v1.2.3"
expect_output "lists packages not on npm yet with their install commands" "$(
	cat <<EOF
Not on npm yet: \`@libo11y/rum\` and \`@libo11y/rum-react\` are attached to this release as tarballs. Install one with:

- \`@libo11y/rum\`: \`npm install $url/libo11y-rum-1.2.3.tgz\`
- \`@libo11y/rum-react\`: \`npm install $url/libo11y-rum-react-1.2.3.tgz $url/libo11y-rum-1.2.3.tgz\`
EOF
)" notes "$plan" jamesainslie/libo11y ts/v1.2.3

# check: tarballs installed offline into a consumer, with the dependency
# tree complete and every entry point resolving under Node.
consumer() {
	local dir
	dir="$(mktemp -d "$work/consumer-XXXXXX")"
	printf '{ "name": "consumer", "private": true, "type": "module" }\n' >"$dir/package.json"
	(cd "$dir" && npm install --offline --no-audit --no-fund --ignore-scripts --loglevel=error "$@" >/dev/null)
	echo "$dir"
}
packs="$work/check"
a="$(tarball "$packs" @libo11y/a 1.2.3 '{"exports": {".": "./index.js", "./package.json": "./package.json"}}')"
b="$(tarball "$packs" @libo11y/b 1.2.3 '{"dependencies": {"@libo11y/a": "1.2.3"}, "exports": {".": "./index.js", "./sub": "./index.js"}}')"
missing="$(tarball "$packs" @libo11y/missing 1.2.3 '{"exports": {".": "./index.js", "./gone": "./gone.js"}}')"
good="$(consumer "$a" "$b")"
expect_output "check passes installed packages whose entry points resolve" "" check "$good" @libo11y/a @libo11y/b
expect_failure "check fails a package that is not installed" "@libo11y/c is not installed" \
	check "$good" @libo11y/c
gone="$(consumer "$missing")"
expect_failure "check fails an entry point with no file" "@libo11y/missing/gone does not resolve" \
	check "$gone" @libo11y/missing
rm -rf "$good/node_modules/@libo11y/a"
mkdir -p "$good/node_modules/@libo11y/a"
printf '{ "name": "@libo11y/a", "version": "9.9.9", "exports": "./index.js" }\n' >"$good/node_modules/@libo11y/a/package.json"
echo 'export const ok = true;' >"$good/node_modules/@libo11y/a/index.js"
expect_failure "check fails an incomplete dependency tree" "npm ls found problems" check "$good" @libo11y/b

status=0
"$script" frobnicate >/dev/null 2>"$work/err" || status=$?
if [[ "$status" -eq 2 ]] && grep -qF usage: "$work/err"; then
	echo "ok   refuses an unknown command"
else
	fail "refuses an unknown command: exited $status, want 2 with usage"
fi

if ((failures > 0)); then
	echo "$failures test(s) failed" >&2
	exit 1
fi
echo "all ts-npm-plan tests passed"
