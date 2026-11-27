#!/usr/bin/env bash
# Tests for rust-release-check.sh against self-contained fixture workspaces.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$root/scripts/rust-release-check.sh"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

failures=0
fail() {
	echo "FAIL $1" >&2
	failures=$((failures + 1))
}

# make_fixture <dir> <version> <dep_req> <changelog_body>
make_fixture() {
	local dir="$1" ver="$2" dep_req="$3" changelog_body="$4"
	mkdir -p "$dir/crate-a/src" "$dir/crate-b/src" "$dir/example/src"
	cat >"$dir/Cargo.toml" <<EOF
[workspace]
resolver = "3"
members = ["crate-a", "crate-b", "example"]

[workspace.package]
version = "$ver"
edition = "2024"
license = "Apache-2.0"
repository = "https://github.com/example/libo11y"

[workspace.dependencies]
crate-a = { version = "$dep_req", path = "crate-a" }
EOF

	cat >"$dir/crate-a/Cargo.toml" <<'EOF'
[package]
name = "crate-a"
description = "Fixture base crate."
readme = "README.md"
include = ["src/**/*.rs", "README.md", "LICENSE"]
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
EOF
	printf 'pub fn a() -> u32 { 1 }\n' >"$dir/crate-a/src/lib.rs"
	printf 'Apache-2.0\n' >"$dir/crate-a/LICENSE"
	printf '# crate-a\n' >"$dir/crate-a/README.md"

	cat >"$dir/crate-b/Cargo.toml" <<'EOF'
[package]
name = "crate-b"
description = "Fixture dependent crate."
readme = "README.md"
include = ["src/**/*.rs", "README.md", "LICENSE"]
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
crate-a.workspace = true
EOF
	printf 'pub fn b() -> u32 { crate_a::a() }\n' >"$dir/crate-b/src/lib.rs"
	printf 'Apache-2.0\n' >"$dir/crate-b/LICENSE"
	printf '# crate-b\n' >"$dir/crate-b/README.md"

	cat >"$dir/example/Cargo.toml" <<'EOF'
[package]
name = "fixture-example"
publish = false
version.workspace = true
edition.workspace = true

[dependencies]
crate-b = { path = "../crate-b" }
EOF
	printf 'fn main() { let _ = crate_b::b(); }\n' >"$dir/example/src/main.rs"

	printf '%s\n' "$changelog_body" >"$dir/CHANGELOG.md"
}

expect_pass() {
	local name="$1"
	shift
	if ! "$script" "$@" >"$work/out" 2>"$work/err"; then
		fail "$name: exited non-zero"
		cat "$work/out" "$work/err" >&2
		return
	fi
	echo "ok   $name"
}

expect_fail() {
	local name="$1" want_err="$2"
	shift 2
	if "$script" "$@" >"$work/out" 2>"$work/err"; then
		fail "$name: unexpectedly succeeded"
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

# 1. Valid unreleased workspace (v0.0.0).
fx_ok0="$work/ok0"
make_fixture "$fx_ok0" "0.0.0" "=0.0.0" $'# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Initial crates.\n'
expect_pass "accepts valid 0.0.0 workspace with publish=false example" v0.0.0 --workspace "$fx_ok0"

# 2. Valid released workspace (v0.1.0) with changelog section.
fx_ok1="$work/ok1"
make_fixture "$fx_ok1" "0.1.0" "=0.1.0" $'# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-27\n\n### Added\n\n- First release.\n'
expect_pass "accepts valid 0.1.0 workspace with changelog notes" v0.1.0 --workspace "$fx_ok1"

# 3. Missing changelog section for non-0.0.0 version fails.
fx_nonotes="$work/nonotes"
make_fixture "$fx_nonotes" "0.1.0" "=0.1.0" $'# Changelog\n\n## [Unreleased]\n\n- Stuff.\n'
expect_fail "rejects missing changelog section for 0.1.0" "missing or empty release notes for 0.1.0" v0.1.0 --workspace "$fx_nonotes"

# 4. Version mismatch fails.
expect_fail "rejects version mismatch" "crate-a is at version 0.0.0, want 0.2.0" v0.2.0 --workspace "$fx_ok0"

# 5. Non-lockstep internal dependency pin fails.
fx_badpin="$work/badpin"
make_fixture "$fx_badpin" "0.1.0" "^0.1.0" $'# Changelog\n\n## [0.1.0] - 2026-11-27\n\n- First.\n'
expect_fail "rejects non-exact workspace dependency pin" 'want "=0.1.0"' v0.1.0 --workspace "$fx_badpin"

# 6. Missing LICENSE file fails.
fx_nolic="$work/nolic"
make_fixture "$fx_nolic" "0.0.0" "=0.0.0" $'# Changelog\n\n## [Unreleased]\n'
rm "$fx_nolic/crate-a/LICENSE"
expect_fail "rejects missing LICENSE file" "missing LICENSE file" v0.0.0 --workspace "$fx_nolic"

# 7. Invalid version string fails.
expect_fail "rejects non-semver version" "not a semantic version" v1.2 --workspace "$fx_ok0"

# 8. Empty middle metadata field (missing license while repository & readme are set)
#    must report the exact missing field rather than shifting columns.
fx_nolic_meta="$work/nolic_meta"
make_fixture "$fx_nolic_meta" "0.0.0" "=0.0.0" $'# Changelog\n\n## [Unreleased]\n'
sed -i '/^license\.workspace = true$/d' "$fx_nolic_meta/crate-a/Cargo.toml"
expect_fail "reports exact missing middle metadata field (license)" "crate-a: missing package.license" v0.0.0 --workspace "$fx_nolic_meta"

# 9. Version-pinned workspace dev-dependencies are included in the topological
#    publish order (e.g., libo11y-test before crates that dev-depend on it),
#    and --write-order writes that exact space-separated order.
fx_devdag="$work/devdag"
mkdir -p "$fx_devdag/crate-a/src" "$fx_devdag/crate-http/src" "$fx_devdag/libo11y-test/src"
cat >"$fx_devdag/Cargo.toml" <<'EOF'
[workspace]
resolver = "3"
members = ["crate-a", "crate-http", "libo11y-test"]

[workspace.package]
version = "0.1.0"
edition = "2024"
license = "Apache-2.0"
repository = "https://github.com/example/libo11y"

[workspace.dependencies]
crate-a = { version = "=0.1.0", path = "crate-a" }
libo11y-test = { version = "=0.1.0", path = "libo11y-test" }
EOF
for c in crate-a libo11y-test crate-http; do
	printf 'Apache-2.0\n' >"$fx_devdag/$c/LICENSE"
	printf '# %s\n' "$c" >"$fx_devdag/$c/README.md"
	printf 'pub fn ok() -> u32 { 1 }\n' >"$fx_devdag/$c/src/lib.rs"
done
cat >"$fx_devdag/crate-a/Cargo.toml" <<'EOF'
[package]
name = "crate-a"
description = "Core crate."
readme = "README.md"
include = ["src/**/*.rs", "README.md", "LICENSE"]
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
EOF
cat >"$fx_devdag/libo11y-test/Cargo.toml" <<'EOF'
[package]
name = "libo11y-test"
description = "Test harness crate."
readme = "README.md"
include = ["src/**/*.rs", "README.md", "LICENSE"]
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
crate-a.workspace = true
EOF
cat >"$fx_devdag/crate-http/Cargo.toml" <<'EOF'
[package]
name = "crate-http"
description = "HTTP crate that dev-depends on libo11y-test."
readme = "README.md"
include = ["src/**/*.rs", "README.md", "LICENSE"]
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
crate-a.workspace = true

[dev-dependencies]
libo11y-test.workspace = true
EOF
printf '# Changelog\n\n## [0.1.0] - 2026-11-27\n\n- First.\n' >"$fx_devdag/CHANGELOG.md"
order_file="$work/order.txt"
expect_pass "orders version-pinned dev-dependency libo11y-test before crate-http" v0.1.0 --workspace "$fx_devdag" --write-order "$order_file"
got_order="$(cat "$order_file")"
if [[ "$got_order" != "crate-a libo11y-test crate-http" ]]; then
	fail "write-order produced \"$got_order\", want \"crate-a libo11y-test crate-http\""
else
	echo "ok   write-order matches exact topological order ($got_order)"
fi

# 10. A cycle through a version-pinned dev-dependency is rejected.
cat >>"$fx_devdag/libo11y-test/Cargo.toml" <<'EOF'

[dev-dependencies]
crate-http = { version = "=0.1.0", path = "../crate-http" }
EOF
expect_fail "rejects cyclic dependency through version-pinned dev-dependency" "cyclic workspace dependency" v0.1.0 --workspace "$fx_devdag"

if [[ "$failures" -gt 0 ]]; then
	echo "$failures case(s) failed" >&2
	exit 1
fi
echo "all cases passed"
