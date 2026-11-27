# libo11y build targets. `make ci` runs the same targets the CI workflow
# (.github/workflows/ci.yml) calls; keep the two in step when adding a gate.

# Package parallelism for go test; lower it on a loaded machine.
GO_TEST_P ?= 4

# Every Go module in the repository. Each has its own go.mod and every Go
# gate runs on each module separately.
GO_MODULES := go go/o11ygin go/o11yconnect go/o11ysql

.PHONY: spec-check spec-generate spec-drift test lint vet tidy-check vuln release-check zig-release-check rust-release-check rust-release-check-test schema-published schema-published-test release-notes-test release-tag-test ts-browser-bundle-test ts-install ts-check ts-browser-test rust-check rust-msrv zig-check zig-integrations-check zig-hygiene-test python-check python-hygiene-test c-check ci

# Validate the spec registry against the libo11y policy suite (naming,
# ownership, sensitivity, cardinality, events, units).
spec-check:
	cd go && go run ./internal/specgen -root .. -check

# Directories holding generated artifacts.
GENERATED := go/spec go/internal/spectables docs/taxonomy spec/schemas ts/packages/spec/src/generated rust/libo11y-spec/src/generated zig/src/spec/generated python/src/libo11y/spec/_generated c/include/o11y/spec.h

# Validate the registry, then regenerate go/spec, go/internal/spectables,
# docs/taxonomy, spec/schemas, ts/packages/spec/src/generated,
# rust/libo11y-spec/src/generated, and zig/src/spec/generated from it.
# An invalid registry generates nothing.
spec-generate:
	cd go && go run ./internal/specgen -root ..

# CI gate: generated artifacts must match the registry, and the generator
# must not have produced files git does not track.
spec-drift: spec-generate
	git diff --exit-code -- $(GENERATED)
	@untracked="$$(git ls-files --others --exclude-standard -- $(GENERATED))"; \
	if [ -n "$$untracked" ]; then echo "untracked generated files:"; echo "$$untracked"; exit 1; fi

# TypeScript workspace (ts/): install the pinned dependencies, then lint,
# typecheck, build, check the committed API reports, and run every suite
# under Bun and under Node (needs bun and node).
ts-install:
	cd ts && bun install --frozen-lockfile

ts-check: ts-install
	cd ts && bun run lint && bun run typecheck && bun run build && bun run api:check && bun run test:bun && bun run test:node

# Browser suites for @libo11y/web and @libo11y/webext under Playwright and
# headless Chromium. Needs Playwright's Chromium for the pinned version:
# CI installs it with `bun x --no-install playwright install --with-deps
# chromium` in ts/.
ts-browser-test: ts-install
	cd ts && bun run test:browser

# Rust workspace (rust/): formatting, clippy with warnings as errors, the
# tests, and the docs with warnings as errors (needs cargo with rustfmt and
# clippy; CI pins the 1.95.0 toolchain). Cargo jobs and test threads are
# capped at RUST_JOBS; lower it on a loaded machine.
RUST_JOBS ?= 8

rust-check:
	cd rust && cargo fmt --all --check
	cd rust && cargo clippy --workspace --all-targets --all-features -j $(RUST_JOBS) -- -D warnings
	cd rust && cargo test --workspace --all-features -j $(RUST_JOBS) -- --test-threads=$(RUST_JOBS)
	cd rust && RUSTDOCFLAGS='-D warnings' cargo doc --workspace --no-deps --all-features -j $(RUST_JOBS)

# The minimum supported Rust version, rust-version in rust/Cargo.toml.
RUST_MSRV ?= 1.88

# The workspace must build on RUST_MSRV. Needs rustup with that toolchain
# installed (rustup toolchain install $(RUST_MSRV)); CI installs it.
# libo11y-sqlx is excluded because sqlx 0.9.0 requires Rust 1.94.
rust-msrv:
	cd rust && cargo +$(RUST_MSRV) check --workspace --exclude libo11y-sqlx --all-targets --all-features -j $(RUST_JOBS)

vet:
	@set -e; for m in $(GO_MODULES); do echo "go vet: $$m"; (cd $$m && go vet ./...); done

test:
	@set -e; for m in $(GO_MODULES); do echo "go test: $$m"; (cd $$m && go test -race -p $(GO_TEST_P) -count=1 ./...); done

lint:
	@set -e; for m in $(GO_MODULES); do echo "golangci-lint: $$m"; (cd $$m && golangci-lint run ./...); done

# Each module's go.mod and go.sum must already be tidy on its own.
tidy-check:
	@set -e; for m in $(GO_MODULES); do echo "tidy: $$m"; (cd $$m && GOWORK=off go mod tidy -diff); done

# Known vulnerabilities reachable from any module (needs govulncheck).
vuln:
	@set -e; for m in $(GO_MODULES); do echo "govulncheck: $$m"; (cd $$m && govulncheck ./...); done

# The version release-check validates. It matches the version the
# submodules require, and a release commit moves both (see
# scripts/release-check.sh). CI uses this default.
RELEASE_VERSION ?= v0.3.0

# The version every @libo11y/* package carries, which ts-release-check.sh
# validates. Like RELEASE_VERSION, it moves only in a release commit,
# together with the packages' versions (bun scripts/release.ts version).
# The packages stay at 0.0.0 until the first TypeScript release.
TS_RELEASE_VERSION ?= v0.2.0

# The version the Zig package manifests (build.zig.zon and zig/build.zig.zon)
# carry, which zig-release-check.sh validates. Moves only in a release commit.
ZIG_RELEASE_VERSION ?= v0.1.0

# The lockstep version every publishable Rust crate in rust/ carries, which
# rust-release-check.sh validates. Moves only in a release commit.
RUST_RELEASE_VERSION ?= v0.0.0

# Validate the Zig package at ZIG_RELEASE_VERSION as an external consumer
# fetches and runs it against an in-process OTLP receiver.
# Needs a clean working tree and zig 0.17.1.
zig-release-check:
	scripts/zig-release-check.sh $(ZIG_RELEASE_VERSION)

# Validate the Rust workspace at RUST_RELEASE_VERSION: lockstep versions,
# exact internal dependency pins, crates.io metadata, changelog, publish
# order, and package file listings.
rust-release-check:
	scripts/rust-release-check.sh $(RUST_RELEASE_VERSION)

# Test rust-release-check.sh against fixture workspaces.
rust-release-check-test:
	scripts/rust-release-check_test.sh

# Validate the release sequence (go/RELEASE_VERSION and
# go/<sub>/RELEASE_VERSION for every Go submodule, o11ygin, o11yconnect
# and o11ysql, on HEAD) against a throwaway local remote. Then build and
# pack the TypeScript packages at TS_RELEASE_VERSION, install the
# tarballs into a throwaway consumer under Node and Bun, bundle the
# browser packages for the browser, validate the Zig consumer tarball at
# ZIG_RELEASE_VERSION, and validate the Rust workspace at
# RUST_RELEASE_VERSION.
# Needs a clean working tree.
release-check:
	scripts/release-check.sh $(RELEASE_VERSION)
	scripts/ts-release-check.sh $(TS_RELEASE_VERSION)
	scripts/zig-release-check.sh $(ZIG_RELEASE_VERSION)
	scripts/rust-release-check.sh $(RUST_RELEASE_VERSION)

# Release step, not a ci gate (it needs the network): confirm the schema URL
# serves spec/schemas/<version> byte for byte before tagging spec/vX.Y.Z.
schema-published:
	scripts/schema-published-check.sh

# Test schema-published-check.sh against a loopback HTTP server.
schema-published-test:
	scripts/schema-published-check_test.sh

# Test release-notes.sh, which the release workflow uses to turn a
# CHANGELOG section into GitHub Release notes, against fixture changelogs.
release-notes-test:
	scripts/release-notes_test.sh

# Test release-tag.sh, which routes a release tag to its family, directory,
# module and version in the release workflow.
release-tag-test:
	scripts/release-tag_test.sh

# Test ts-browser-bundle-check.sh, which the release check and the release
# workflow use to bundle the browser packages, against fixture packages
# (needs bun).
ts-browser-bundle-test:
	scripts/ts-browser-bundle-check_test.sh

# Job count for zig build; lower it on a loaded machine.
ZIG_BUILD_J ?= 8

# Zig sources zig fmt checks: the root shim and the zig/ package, without
# its build cache and fetched packages.
ZIG_FMT := zig fmt --check --exclude zig/.zig-cache --exclude zig/zig-pkg --exclude zig/zig-out build.zig build.zig.zon zig

# The Zig package (needs zig 0.17.1): zig fmt, the tests through the root
# shim in Debug and ReleaseSafe, and the hygiene check with its test. The
# check fails on @panic, std.debug.panic, std.debug.print and catch or
# orelse unreachable outside tests.
zig-check: zig-hygiene-test
	$(ZIG_FMT)
	zig build test -j$(ZIG_BUILD_J) -Doptimize=Debug
	zig build test -j$(ZIG_BUILD_J) -Doptimize=ReleaseSafe
	scripts/zig-hygiene.sh

# Optional Zig integration suites (o11yhttpz, o11ypg, o11ysqlite) in Debug and
# ReleaseSafe with all lazy integration dependencies enabled. Set
# O11YPG_TEST_DSN to run the live PostgreSQL tests against a server.
zig-integrations-check:
	$(ZIG_FMT)
	zig build test -j$(ZIG_BUILD_J) -Dhttpz=true -Dpg=true -Dsqlite=true -Doptimize=Debug
	zig build test -j$(ZIG_BUILD_J) -Dhttpz=true -Dpg=true -Dsqlite=true -Doptimize=ReleaseSafe
	scripts/zig-hygiene.sh

# Test zig-hygiene.sh against fixture trees.
zig-hygiene-test:
	scripts/zig-hygiene_test.sh

# Worker count for pytest-xdist, capped at a quarter of the machine's cores.
PYTHON_WORKERS ?= $(shell nproc 2>/dev/null | awk '{w=int($$1/4); if (w<1) w=1; print w}' || sysctl -n hw.ncpu 2>/dev/null | awk '{w=int($$1/4); if (w<1) w=1; print w}' || echo 2)
PYTHON_LD_PATH := $(if $(wildcard /run/current-system/sw/share/nix-ld/lib),LD_LIBRARY_PATH=/run/current-system/sw/share/nix-ld/lib$${LD_LIBRARY_PATH:+:$$LD_LIBRARY_PATH},)

# The Python package (needs uv): sync locked dependencies, format check,
# lint, strict typecheck, tests with branch coverage, and the hygiene gate.
python-check: python-hygiene-test
	cd python && uv sync --frozen --all-extras --dev
	cd python && uv run --frozen --no-sync ruff format --check src tests
	cd python && uv run --frozen --no-sync ruff check src tests
	cd python && uv run --frozen --no-sync pyright
	cd python && $(PYTHON_LD_PATH) uv run --frozen --no-sync pytest -n $(PYTHON_WORKERS) --cov=libo11y --cov-branch
	scripts/python-hygiene.sh

# Test python-hygiene.sh against fixture trees.
python-hygiene-test:
	scripts/python-hygiene_test.sh

# C11 library (c/): formatting and hygiene on the Zig ABI layer, static/shared
# library & CLI build, full C11 unit/conformance/wire test suites in Debug and
# ReleaseSafe, CLI verification, and standalone host C compiler static link check.
c-check:
	zig fmt --check --exclude c/.zig-cache --exclude c/zig-pkg --exclude c/zig-out c
	scripts/zig-hygiene.sh c/build.zig c/src
	cd c && zig build -j$(ZIG_BUILD_J) -Doptimize=Debug && zig build test -j$(ZIG_BUILD_J) -Doptimize=Debug
	cd c && zig build -j$(ZIG_BUILD_J) -Doptimize=ReleaseSafe && zig build test -j$(ZIG_BUILD_J) -Doptimize=ReleaseSafe
	c/tests/test_cli.sh c/zig-out/bin/libo11y
	@tmp="$$(mktemp)"; \
	cc -std=c11 -Wall -Wextra -Werror -Wpedantic -Ic/zig-out/include c/examples/quickstart.c c/zig-out/lib/libo11y.a -lpthread -lm -o "$$tmp" && "$$tmp"; \
	rc=$$?; rm -f "$$tmp"; exit $$rc

# vuln runs last: it depends on the advisory database and the toolchain's
# patch level, so local runs exercise every other gate first.
ci: lint vet test tidy-check spec-check spec-drift ts-check ts-browser-test rust-check rust-msrv zig-check python-check c-check schema-published-test release-notes-test release-tag-test rust-release-check-test ts-browser-bundle-test release-check vuln
