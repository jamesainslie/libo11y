#!/usr/bin/env bash
# Tests for release-notes.sh against throwaway fixture changelogs: it prints
# exactly one version's section body and fails when the section is missing
# or empty.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/release-notes.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

changelog="$work/CHANGELOG.md"
cat >"$changelog" <<'EOF'
# Changelog

All notable changes are documented here.

## [Unreleased]

## [0.2.0-rc.1] - 2026-11-01

### Added

- Prerelease entry.

## [0.1.1] - 2026-10-20


### Fixed

- Middle entry with a [reference link][ref].

[ref]: https://example.com/ref

## [0.1.0] - 2026-10-12

### Added

- First entry.
- Second entry.

[Unreleased]: https://example.com/compare/go/v0.1.1...HEAD
[0.1.1]: https://example.com/compare/go/v0.1.0...go/v0.1.1
[0.1.0]: https://example.com/releases/tag/go/v0.1.0
EOF

empty="$work/EMPTY.md"
cat >"$empty" <<'EOF'
# Changelog

## [Unreleased]

## [0.3.0] - 2026-12-01


## [0.2.0] - 2026-11-01

- Entry.
EOF

cat >"$work/LAST.md" <<'EOF'
# Changelog

## [Unreleased]

- Pending entry.

## [0.1.0] - 2026-10-12

[Unreleased]: https://example.com/compare/go/v0.1.0...HEAD
[0.1.0]: https://example.com/releases/tag/go/v0.1.0
EOF

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

# expect_notes <name> <want> <args...>: the script succeeds and prints want.
expect_notes() {
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

# expect_failure <name> <stderr substring> <args...>: the script exits
# non-zero, prints nothing on stdout, and explains itself on stderr.
expect_failure() {
	local name="$1" want_err="$2"
	shift 2
	if "$script" "$@" >"$work/out" 2>"$work/err"; then
		fail "$name: exited zero"
		cat "$work/out" >&2
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

expect_notes "extracts a middle section" "$(
	cat <<'EOF'
### Fixed

- Middle entry with a [reference link][ref].

[ref]: https://example.com/ref
EOF
)" 0.1.1 "$changelog"

expect_notes "extracts the last section without link references" "$(
	cat <<'EOF'
### Added

- First entry.
- Second entry.
EOF
)" 0.1.0 "$changelog"

expect_notes "extracts a prerelease section" "$(
	cat <<'EOF'
### Added

- Prerelease entry.
EOF
)" 0.2.0-rc.1 "$changelog"

expect_notes "accepts a v prefix" "$(
	cat <<'EOF'
### Added

- First entry.
- Second entry.
EOF
)" v0.1.0 "$changelog"

expect_failure "missing version fails" "no ## [0.9.0] section" 0.9.0 "$changelog"
expect_failure "version prefix of another fails" "no ## [0.1] section" 0.1 "$changelog"
expect_failure "empty section fails" "## [0.3.0] section in $empty is empty" 0.3.0 "$empty"
expect_failure "empty section before another fails" "is empty" Unreleased "$empty"
expect_failure "empty last section fails" "is empty" 0.1.0 "$work/LAST.md"
expect_failure "missing changelog fails" "does not exist" 0.1.0 "$work/absent.md"
expect_failure "missing version argument fails" "usage" ""

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
