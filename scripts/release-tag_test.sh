#!/usr/bin/env bash
# Tests for release-tag.sh: it routes each Go, TypeScript, Zig, Python,
# Rust, C, .NET, Ruby and ops release tag to its family, directory, module, version,
# version line and changelog, and it refuses any other tag.
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
lockstep=true
changelog=go/CHANGELOG.md
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
lockstep=true
changelog=go/CHANGELOG.md
EOF
	)" "go/$sub/v1.4.10"
done

expect_route "routes the go/o11yrum module on its own version line" "$(
	cat <<'EOF'
kind=go
dir=go/o11yrum
module=github.com/jamesainslie/libo11y/go/o11yrum
version=0.1.0
prerelease=false
lockstep=false
changelog=go/o11yrum/CHANGELOG.md
EOF
)" go/o11yrum/v0.1.0

expect_route "marks a go/o11yrum prerelease" "$(
	cat <<'EOF'
kind=go
dir=go/o11yrum
module=github.com/jamesainslie/libo11y/go/o11yrum
version=0.2.0-rc.1
prerelease=true
lockstep=false
changelog=go/o11yrum/CHANGELOG.md
EOF
)" go/o11yrum/v0.2.0-rc.1

expect_route "marks a go prerelease" "$(
	cat <<'EOF'
kind=go
dir=go
module=github.com/jamesainslie/libo11y/go
version=1.0.0-rc.1
prerelease=true
lockstep=true
changelog=go/CHANGELOG.md
EOF
)" go/v1.0.0-rc.1

expect_route "routes the typescript packages" "$(
	cat <<'EOF'
kind=ts
dir=ts
module=@libo11y
version=0.1.0
prerelease=false
lockstep=false
changelog=ts/CHANGELOG.md
EOF
)" ts/v0.1.0

expect_route "marks a typescript prerelease" "$(
	cat <<'EOF'
kind=ts
dir=ts
module=@libo11y
version=0.2.0-beta.1
prerelease=true
lockstep=false
changelog=ts/CHANGELOG.md
EOF
)" ts/v0.2.0-beta.1

expect_route "routes the zig package" "$(
	cat <<'EOF'
kind=zig
dir=zig
module=libo11y-zig
version=0.1.0
prerelease=false
lockstep=false
changelog=zig/CHANGELOG.md
EOF
)" zig/v0.1.0

expect_route "marks a zig prerelease" "$(
	cat <<'EOF'
kind=zig
dir=zig
module=libo11y-zig
version=1.0.0-rc.1
prerelease=true
lockstep=false
changelog=zig/CHANGELOG.md
EOF
)" zig/v1.0.0-rc.1

expect_route "routes the python distribution" "$(
	cat <<'EOF'
kind=python
dir=python
module=libo11y
version=0.1.0
prerelease=false
lockstep=false
changelog=python/CHANGELOG.md
EOF
)" python/v0.1.0

expect_route "marks a python prerelease" "$(
	cat <<'EOF'
kind=python
dir=python
module=libo11y
version=0.2.0-rc.1
prerelease=true
lockstep=false
changelog=python/CHANGELOG.md
EOF
)" python/v0.2.0-rc.1

expect_route "routes the rust workspace" "$(
	cat <<'EOF'
kind=rust
dir=rust
module=libo11y-rust
version=0.1.0
prerelease=false
lockstep=false
changelog=rust/CHANGELOG.md
EOF
)" rust/v0.1.0

expect_route "marks a rust prerelease" "$(
	cat <<'EOF'
kind=rust
dir=rust
module=libo11y-rust
version=0.2.0-rc.1
prerelease=true
lockstep=false
changelog=rust/CHANGELOG.md
EOF
)" rust/v0.2.0-rc.1

expect_route "routes the c library" "$(
	cat <<'EOF'
kind=c
dir=c
module=libo11y-c
version=0.1.0
prerelease=false
lockstep=false
changelog=c/CHANGELOG.md
EOF
)" c/v0.1.0

expect_route "marks a c prerelease" "$(
	cat <<'EOF'
kind=c
dir=c
module=libo11y-c
version=0.2.0-rc.1
prerelease=true
lockstep=false
changelog=c/CHANGELOG.md
EOF
)" c/v0.2.0-rc.1

expect_route "routes the ruby gem" "$(
	cat <<'EOF'
kind=ruby
dir=ruby
module=libo11y
version=0.1.0
prerelease=false
lockstep=false
changelog=ruby/CHANGELOG.md
EOF
)" ruby/v0.1.0

expect_route "marks a ruby prerelease" "$(
	cat <<'EOF'
kind=ruby
dir=ruby
module=libo11y
version=0.2.0-rc.1
prerelease=true
lockstep=false
changelog=ruby/CHANGELOG.md
EOF
)" ruby/v0.2.0-rc.1
expect_route "routes the ops pack" "$(
	cat <<'EOF'
kind=ops
dir=ops
module=libo11y-ops
version=0.1.0
prerelease=false
lockstep=false
changelog=ops/CHANGELOG.md
EOF
)" ops/v0.1.0

expect_route "marks an ops prerelease" "$(
	cat <<'EOF'
kind=ops
dir=ops
module=libo11y-ops
version=0.2.0-rc.1
prerelease=true
lockstep=false
changelog=ops/CHANGELOG.md
EOF
)" ops/v0.2.0-rc.1

expect_route "routes the .NET packages" "$(
	cat <<'EOF'
kind=dotnet
dir=dotnet
module=libo11y-dotnet
version=0.1.0
prerelease=false
lockstep=false
changelog=dotnet/CHANGELOG.md
EOF
)" dotnet/v0.1.0

expect_route "marks a .NET prerelease" "$(
	cat <<'EOF'
kind=dotnet
dir=dotnet
module=libo11y-dotnet
version=0.2.0-rc.1
prerelease=true
lockstep=false
changelog=dotnet/CHANGELOG.md
EOF
)" dotnet/v0.2.0-rc.1

expect_failure "refuses a spec tag" 1 "spec/v1.2.0 is not a release tag" spec/v1.2.0
expect_failure "refuses a two-part go/o11yrum version" 1 "1 is not a semantic version" go/o11yrum/v1
expect_failure "refuses a nested go/o11yrum path" 1 "is not a release tag" go/o11yrum/cmd/v0.1.0
expect_failure "refuses a go/o11yrum version with a path" 1 "is not a semantic version" go/o11yrum/vfoo/v1.0.0
expect_failure "refuses an unknown go submodule" 1 "is not a release tag" go/o11yfoo/v1.0.0
expect_failure "refuses a tag without the v" 1 "is not a release tag" ts/0.1.0
expect_failure "refuses a nested ts path" 1 "is not a release tag" ts/core/v0.1.0
expect_failure "refuses a zig tag without the v" 1 "is not a release tag" zig/0.1.0
expect_failure "refuses a nested zig path" 1 "is not a release tag" zig/foo/v0.1.0
expect_failure "refuses a two-part zig version" 1 "1.2 is not a semantic version" zig/v1.2
expect_failure "refuses a python tag without the v" 1 "is not a release tag" python/0.1.0
expect_failure "refuses a nested python path" 1 "is not a release tag" python/foo/v0.1.0
expect_failure "refuses a two-part python version" 1 "1.2 is not a semantic version" python/v1.2
expect_failure "refuses a rust tag without the v" 1 "is not a release tag" rust/0.1.0
expect_failure "refuses a nested rust path" 1 "is not a release tag" rust/libo11y/v0.1.0
expect_failure "refuses a two-part rust version" 1 "1.2 is not a semantic version" rust/v1.2
expect_failure "refuses a c tag without the v" 1 "is not a release tag" c/0.1.0
expect_failure "refuses a nested c path" 1 "is not a release tag" c/foo/v0.1.0
expect_failure "refuses a two-part c version" 1 "1.2 is not a semantic version" c/v1.2
expect_failure "refuses a ruby tag without the v" 1 "is not a release tag" ruby/0.1.0
expect_failure "refuses a nested ruby path" 1 "is not a release tag" ruby/foo/v0.1.0
expect_failure "refuses a two-part ruby version" 1 "1.2 is not a semantic version" ruby/v1.2
expect_failure "refuses an ops tag without the v" 1 "ops/vX.Y.Z" ops/0.1.0
expect_failure "refuses a nested ops path" 1 "is not a release tag" ops/dashboards/v0.1.0
expect_failure "refuses a two-part ops version" 1 "1.2 is not a semantic version" ops/v1.2
expect_failure "refuses a dotnet tag without the v" 1 "dotnet/vX.Y.Z" dotnet/0.1.0
expect_failure "refuses a nested dotnet path" 1 "is not a release tag" dotnet/Libo11y/v0.1.0
expect_failure "refuses a two-part dotnet version" 1 "1.2 is not a semantic version" dotnet/v1.2
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
