#!/usr/bin/env bash
# Tests for release-tag.sh: it routes each Go, TypeScript, Zig and Rust
# release tag to its family, directory, module and version, and it refuses
# any other tag.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/release-tag.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

# expect_route <name> <want> <args...>: the script succeeds, prints want on
# stdout and a summary line on stderr.
expect_route() {
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
	if ! grep -qF -- "$1 releases" "$work/err"; then
		fail "$name: stderr lacks the summary line"
		cat "$work/err" >&2
		return
	fi
	echo "ok   $name"
}

# expect_failure <name> <status> <stderr substring> <args...>: the script
# exits with status, prints nothing on stdout, and explains itself on stderr.
expect_failure() {
	local name="$1" want_status="$2" want_err="$3"
	shift 3
	local status=0
	"$script" "$@" >"$work/out" 2>"$work/err" || status=$?
	if [[ "$status" -ne "$want_status" ]]; then
		fail "$name: exited $status, want $want_status"
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

expect_route "routes the go main module" "$(
	cat <<'EOF'
kind=go
dir=go
module=github.com/jamesainslie/libo11y/go
version=0.2.0
prerelease=false
EOF
)" go/v0.2.0

for sub in o11ygin o11yconnect o11ysql; do
	expect_route "routes the go/$sub submodule" "$(
		cat <<EOF
kind=go
dir=go/$sub
module=github.com/jamesainslie/libo11y/go/$sub
version=1.4.10
prerelease=false
EOF
	)" "go/$sub/v1.4.10"
done

expect_route "marks a go prerelease" "$(
	cat <<'EOF'
kind=go
dir=go
module=github.com/jamesainslie/libo11y/go
version=1.0.0-rc.1
prerelease=true
EOF
)" go/v1.0.0-rc.1

expect_route "routes the typescript packages" "$(
	cat <<'EOF'
kind=ts
dir=ts
module=@libo11y
version=0.1.0
prerelease=false
EOF
)" ts/v0.1.0

expect_route "marks a typescript prerelease" "$(
	cat <<'EOF'
kind=ts
dir=ts
module=@libo11y
version=0.2.0-beta.1
prerelease=true
EOF
)" ts/v0.2.0-beta.1

expect_route "routes the zig package" "$(
	cat <<'EOF'
kind=zig
dir=zig
module=libo11y-zig
version=0.1.0
prerelease=false
EOF
)" zig/v0.1.0

expect_route "marks a zig prerelease" "$(
	cat <<'EOF'
kind=zig
dir=zig
module=libo11y-zig
version=1.0.0-rc.1
prerelease=true
EOF
)" zig/v1.0.0-rc.1

expect_route "routes the rust workspace" "$(
	cat <<'EOF'
kind=rust
dir=rust
module=libo11y-rust
version=0.1.0
prerelease=false
EOF
)" rust/v0.1.0

expect_route "marks a rust prerelease" "$(
	cat <<'EOF'
kind=rust
dir=rust
module=libo11y-rust
version=0.2.0-rc.1
prerelease=true
EOF
)" rust/v0.2.0-rc.1

expect_failure "refuses a spec tag" 1 "spec/v1.2.0 is not a release tag" spec/v1.2.0
expect_failure "refuses an unknown go submodule" 1 "is not a release tag" go/o11yfoo/v1.0.0
expect_failure "refuses a tag without the v" 1 "is not a release tag" ts/0.1.0
expect_failure "refuses a nested ts path" 1 "is not a release tag" ts/core/v0.1.0
expect_failure "refuses a zig tag without the v" 1 "is not a release tag" zig/0.1.0
expect_failure "refuses a nested zig path" 1 "is not a release tag" zig/foo/v0.1.0
expect_failure "refuses a two-part zig version" 1 "1.2 is not a semantic version" zig/v1.2
expect_failure "refuses a rust tag without the v" 1 "is not a release tag" rust/0.1.0
expect_failure "refuses a nested rust path" 1 "is not a release tag" rust/libo11y/v0.1.0
expect_failure "refuses a two-part rust version" 1 "1.2 is not a semantic version" rust/v1.2
expect_failure "refuses a two-part version" 1 "1.2 is not a semantic version" ts/v1.2
expect_failure "refuses a leading zero" 1 "01.0.0 is not a semantic version" ts/v01.0.0
expect_failure "refuses build metadata" 1 "is not a semantic version" ts/v0.1.0+build.5
expect_failure "refuses an empty prerelease" 1 "is not a semantic version" go/v1.0.0-
expect_failure "refuses a go version with a path" 1 "is not a semantic version" go/vfoo/v1.0.0
expect_failure "refuses no argument" 2 "usage" ""
expect_failure "refuses two arguments" 2 "usage" ts/v0.1.0 ts/v0.1.1

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
