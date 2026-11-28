# libo11y build targets. `make ci` runs the same targets the CI workflow
# (.github/workflows/ci.yml) calls; keep the two in step when adding a gate.

# Package parallelism for go test; lower it on a loaded machine.
GO_TEST_P ?= 4

# Every Go module in the repository. Each has its own go.mod and every Go
# gate runs on each module separately.
GO_MODULES := go go/o11ygin go/o11yconnect go/o11ysql go/o11yrum ops

.PHONY: spec-check spec-generate spec-drift ops-generate ops-check ops-integration-up ops-integration-down ops-integration ops-promtool-test ops-release-check ops-release-check-test test lint vet tidy-check vuln release-check zig-release-check python-release-check rust-release-check rust-release-check-test c-release-check o11yrum-release-check print-o11yrum-release-version o11yrum-image schema-published schema-published-test release-notes-test release-tag-test ts-browser-bundle-test ts-rn-bundle-test ts-npm-plan-test ts-install ts-check ts-size ts-browser-test ts-rn-check rum-e2e rust-check rust-msrv zig-check zig-integrations-check zig-hygiene-test python-check python-hygiene-test c-check ruby-check dotnet-check java-check ci

# Validate the spec registry against the libo11y policy suite (naming,
# ownership, sensitivity, cardinality, events, units).
spec-check:
	cd go && go run ./internal/specgen -root .. -check

# Directories holding generated artifacts.
GENERATED := go/spec go/internal/spectables docs/taxonomy spec/schemas ts/packages/spec/src/generated rust/libo11y-spec/src/generated zig/src/spec/generated python/src/libo11y/spec/_generated c/include/o11y/spec.h ruby/lib/libo11y/spec/generated dotnet/src/Libo11y.Spec/Generated java/libo11y-spec/src/main/java/ing/o11y/libo11y/spec/generated go/o11yrum/internal/rumspec

# Validate the registry, then regenerate go/spec, go/internal/spectables,
# docs/taxonomy, spec/schemas, ts/packages/spec/src/generated,
# rust/libo11y-spec/src/generated, zig/src/spec/generated and the o11yrum
# gateway's go/o11yrum/internal/rumspec from it.
# An invalid registry generates nothing.
spec-generate:
	cd go && go run ./internal/specgen -root ..

# CI gate: generated artifacts must match the registry, and the generator
# must not have produced files git does not track.
spec-drift: spec-generate
	git diff --exit-code -- $(GENERATED)
	@untracked="$$(git ls-files --others --exclude-standard -- $(GENERATED))"; \
	if [ -n "$$untracked" ]; then echo "untracked generated files:"; echo "$$untracked"; exit 1; fi

# Regenerate the ops pack's dashboards, rules and kustomization from
# ops/internal/pack.
ops-generate:
	cd ops && go run ./cmd/opsgen -out .

# Test the ops pack: generator drift, the gateway name catalog, query lint,
# promtool check and unit tests of the alert rules (promtool 3.15.1, pinned
# by checksum), and the kustomization.
ops-check:
	cd ops && go test -race -p $(GO_TEST_P) -count=1 ./...
	scripts/ops-promtool.sh check rules ops/alerts/*.rules.yaml
	scripts/ops-promtool.sh test rules ops/alerts/tests/*.test.yaml
	kubectl kustomize ops >/dev/null

# The ops integration environment (ops/test/compose.yaml): Loki, Tempo,
# Prometheus, Grafana and an OpenTelemetry Collector, published on loopback.
OPS_COMPOSE := docker compose -p libo11y-ops-it -f ops/test/compose.yaml

ops-integration-up:
	$(OPS_COMPOSE) up -d --wait --wait-timeout 180

ops-integration-down:
	$(OPS_COMPOSE) down -v --remove-orphans

# Run every ops pack panel query through Grafana against real Loki, Tempo
# and Prometheus, behind the gateway built from this checkout, and check the
# explorer in headless Chrome (needs Docker with compose, and Chrome or
# Chromium). CI runs it; it starts five containers, so run it locally only
# on a machine with room for them. On failure it writes the containers'
# logs to ops-integration.log. It always tears the environment down.
ops-integration:
	@$(MAKE) ops-integration-up || { $(OPS_COMPOSE) logs --no-color >ops-integration.log 2>&1; $(MAKE) ops-integration-down; exit 1; }
	@status=0; (cd ops && go test -tags opsintegration -run '^TestIntegration$$' -count=1 -timeout 10m -v .) || status=$$?; \
	if [ $$status -ne 0 ]; then $(OPS_COMPOSE) logs --no-color >ops-integration.log 2>&1; fi; \
	$(MAKE) ops-integration-down; exit $$status

# TypeScript workspace (ts/): install the pinned dependencies, then lint,
# typecheck, build, check the committed API reports, and run every suite
# under Bun and under Node (needs bun and node).
ts-install:
	cd ts && bun install --frozen-lockfile

ts-check: ts-install
	cd ts && bun run lint && bun run typecheck && bun run build && bun run api:check && bun run test:bun && bun run test:node

# The browser bundle size budgets in ts/size-budget.json: each entry and each
# collector delta, minified and gzip-compressed, against its budget.
ts-size: ts-install
	cd ts && bun scripts/size.ts --check

# The React Native packages in a real Expo app (ts/fixtures/expo-app, SDK 58):
# build and pack every @libo11y/* package, install the tarballs, typecheck
# the fixture against the real Expo modules, run its jest-expo suite, export
# it for iOS and Android with Hermes bytecode, and check what @libo11y and
# @opentelemetry add to the Android bundle against ts/rn-bundle-budget.json
# (needs bun and node; downloads the fixture's dependencies). expo export
# empties its output directory first, so exactly one Android map remains.
ts-rn-check: ts-install
	bash ts/scripts/rn-fixture.sh
	cd ts/fixtures/expo-app && bun run typecheck && bun run test && bun run export:native && bun run export:size
	cd ts && set -- fixtures/expo-app/dist-size/_expo/static/js/android/*.js.map \
		&& { [ "$$#" -eq 1 ] && [ -f "$$1" ] || { echo "ts-rn-check: expected one Android source map, found: $$*" >&2; exit 1; }; } \
		&& bun scripts/rn-bundle-size.ts --check --summary "$${GITHUB_STEP_SUMMARY:-/dev/null}" --map "$$1" --bundle "$${1%.map}"

# Browser suites under Playwright: @libo11y/web and @libo11y/webext in
# headless Chromium, @libo11y/rum and its adapters in headless Chromium,
# Firefox and WebKit. Needs Playwright's browsers for the pinned version:
# CI installs them with `bun x --no-install playwright install --with-deps
# chromium firefox webkit` in ts/. A host with only Chromium runs
# `bun run test:browser --project=web --project=webext --project=rum-chromium`.
ts-browser-test: ts-install
	cd ts && bun run test:browser

# The RUM gateway end-to-end journeys: builds o11yrum-gateway and runs the
# journey in ts/packages/sourcemaps/src/e2e under Node and Bun against the
# in-process OTLP sink from @libo11y/test, then the session replay journey
# (ts/packages/rum-replay/browser/gateway-journey.pw.ts) in Playwright's
# Chromium: record in a browser, store through the gateway, read back with
# a token, replay with @rrweb/replay, erase. Needs Playwright's Chromium.
rum-e2e: ts-install
	@set -e; tmp="$$(mktemp -d)"; trap 'rm -rf "$$tmp"' EXIT; \
	(cd go/o11yrum && go build -o "$$tmp/o11yrum-gateway" ./cmd/o11yrum-gateway); \
	cd ts && O11YRUM_GATEWAY_BIN="$$tmp/o11yrum-gateway" node --test packages/sourcemaps/src/e2e/*.test.ts \
		&& O11YRUM_GATEWAY_BIN="$$tmp/o11yrum-gateway" bun test --timeout 60000 packages/sourcemaps/src/e2e \
		&& O11YRUM_GATEWAY_BIN="$$tmp/o11yrum-gateway" bun run test:browser --project=rum-chromium packages/rum-replay/browser/gateway-journey.pw.ts

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
RELEASE_VERSION ?= v0.4.0

# The version every @libo11y/* package carries, which ts-release-check.sh
# validates. Like RELEASE_VERSION, it moves only in a release commit,
# together with the packages' versions (bun scripts/release.ts version).
# The packages stay at 0.0.0 until the first TypeScript release.
TS_RELEASE_VERSION ?= v0.4.0

# The version the Zig package manifests (build.zig.zon and zig/build.zig.zon)
# carry, which zig-release-check.sh validates. Moves only in a release commit.
ZIG_RELEASE_VERSION ?= v0.1.0

# The version python/pyproject.toml carries, which python-release-check.sh
# validates. Moves only in a release commit.
PYTHON_RELEASE_VERSION ?= v0.1.0

# The lockstep version every publishable Rust crate in rust/ carries, which
# rust-release-check.sh validates. Moves only in a release commit.
RUST_RELEASE_VERSION ?= v0.1.0

# The version c/build.zig.zon carries, which c-release-check.sh validates.
# Moves only in a release commit.
C_RELEASE_VERSION ?= v0.1.0

# The o11yrum gateway module's own version line (go/o11yrum/vX.Y.Z), which
# o11yrum-release-check.sh validates and the release workflow requires to
# match the tag. Moves only in a release commit, together with the
# script's default and a dated go/o11yrum/CHANGELOG.md section.
O11YRUM_RELEASE_VERSION ?= v0.2.0

# The ops pack version (ops/vX.Y.Z), which ops-release-check.sh validates
# against ops/internal/version/version.go, ops/CHANGELOG.md and the
# runbook links in the generated rules. Moves only in a release commit.
OPS_RELEASE_VERSION ?= v0.1.0

# Validate the Zig package at ZIG_RELEASE_VERSION as an external consumer
# fetches and runs it against an in-process OTLP receiver.
# Needs a clean working tree and zig 0.17.1.
zig-release-check:
	scripts/zig-release-check.sh $(ZIG_RELEASE_VERSION)

# Build the Python sdist and wheel at PYTHON_RELEASE_VERSION, verify packaged
# contents, install into a fresh venv, and run a consumer smoke test against
# an in-process OTLP/HTTP receiver.
python-release-check:
	scripts/python-release-check.sh $(PYTHON_RELEASE_VERSION)

# Validate the Rust workspace at RUST_RELEASE_VERSION: lockstep versions,
# exact internal dependency pins, crates.io metadata, changelog, publish
# order, and package file listings.
rust-release-check:
	scripts/rust-release-check.sh $(RUST_RELEASE_VERSION)

# Test rust-release-check.sh against fixture workspaces.
rust-release-check-test:
	scripts/rust-release-check_test.sh

# Validate the C11 library at C_RELEASE_VERSION: manifest, changelog, clean
# ReleaseSafe install prefix, external C11 consumer against an in-process
# OTLP/HTTP receiver, and installed CLI.
c-release-check:
	scripts/c-release-check.sh $(C_RELEASE_VERSION)

# Validate the release sequence (go/RELEASE_VERSION and
# go/<sub>/RELEASE_VERSION for every Go submodule, o11ygin, o11yconnect
# and o11ysql, on HEAD) against a throwaway local remote. Then build and
# pack the TypeScript packages at TS_RELEASE_VERSION, install the
# tarballs into a throwaway consumer under Node and Bun, bundle the
# browser packages for the browser, validate the Zig consumer tarball at
# ZIG_RELEASE_VERSION, validate the Python wheel and sdist at
# PYTHON_RELEASE_VERSION, validate the Rust workspace at
# RUST_RELEASE_VERSION, and validate the C11 install prefix at
# C_RELEASE_VERSION. The o11yrum module is checked at
# O11YRUM_RELEASE_VERSION after the lockstep Go modules, and the ops pack
# and its release archive at OPS_RELEASE_VERSION.
# Needs a clean working tree.
release-check:
	scripts/release-check.sh $(RELEASE_VERSION)
	scripts/o11yrum-release-check.sh $(O11YRUM_RELEASE_VERSION)
	scripts/ts-release-check.sh $(TS_RELEASE_VERSION)
	scripts/zig-release-check.sh $(ZIG_RELEASE_VERSION)
	scripts/python-release-check.sh $(PYTHON_RELEASE_VERSION)
	scripts/rust-release-check.sh $(RUST_RELEASE_VERSION)
	scripts/c-release-check.sh $(C_RELEASE_VERSION)
	scripts/ops-release-check.sh $(OPS_RELEASE_VERSION)

# Validate the o11yrum release at O11YRUM_RELEASE_VERSION against a
# throwaway local remote: the parent version it requires is a real go/
# tag, the module builds, vets and tests without its replace directive,
# the installed command reports the version, and an external consumer
# builds. Needs a clean working tree.
o11yrum-release-check:
	scripts/o11yrum-release-check.sh $(O11YRUM_RELEASE_VERSION)

# Validate the ops pack at OPS_RELEASE_VERSION: version.go, the changelog,
# generator drift for that version, the runbook links, the release archive
# contents and, when kubectl is on PATH, kustomize of the unpacked archive.
ops-release-check:
	scripts/ops-release-check.sh $(OPS_RELEASE_VERSION)

# Test ops-release-check.sh against this checkout, including the --archive
# mode the release workflow uses.
ops-release-check-test:
	OPS_RELEASE_VERSION=$(OPS_RELEASE_VERSION) scripts/ops-release-check_test.sh

# Prints O11YRUM_RELEASE_VERSION, for the release workflow.
print-o11yrum-release-version:
	@echo $(O11YRUM_RELEASE_VERSION)

# Build the o11yrum-gateway image for the local platform and check it: the
# version it reports, the 40 MiB size budget, the numeric non-root user,
# the example configuration, and /healthz and /readyz from a read-only
# root filesystem (needs docker with buildx, and curl). The release
# workflow builds linux/amd64 and linux/arm64 from the same Dockerfile.
o11yrum-image:
	scripts/o11yrum-image-check.sh

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

# Test ops-promtool.sh, which installs promtool only when its tarball matches
# the pinned checksum.
ops-promtool-test:
	scripts/ops-promtool_test.sh

# Test ts-browser-bundle-check.sh, which the release check and the release
# workflow use to bundle the browser packages, against fixture packages
# (needs bun).
ts-browser-bundle-test:
	scripts/ts-browser-bundle-check_test.sh

# Test ts-rn-bundle-check.sh, which the release check and the release
# workflow use to bundle the React Native packages, against fixture
# packages (needs bun).
ts-rn-bundle-test:
	scripts/ts-rn-bundle-check_test.sh

# Test ts-npm-plan.sh, which decides what a TypeScript release publishes to
# npm and what stays a tarball on the GitHub Release, against fixture
# tarballs and a fake npm (needs jq, node and npm, and no network).
ts-npm-plan-test:
	scripts/ts-npm-plan_test.sh

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

# Ruby gem (ruby/): install locked/bundle deps, RSpec (including shared
# conformance, integrations, and OTLP wire suites), RuboCop, and hygiene check.
ruby-check:
	cd ruby && bundle check || bundle install
	cd ruby && bundle exec rspec
	cd ruby && bundle exec rubocop --format simple
	scripts/ruby-hygiene.sh ruby/lib

# .NET solution (dotnet/): build with TreatWarningsAsErrors, xUnit suites
# (including shared conformance, integrations, and OTLP wire tests), CLI check,
# and hygiene check.
dotnet-check:
	cd dotnet && dotnet test Libo11y.sln --configuration Release
	cd dotnet && dotnet run --project src/Libo11y.Cli -- registry check ../conformance/appregistry/valid.yaml
	scripts/dotnet-hygiene.sh dotnet/src

# Java Maven reactor (java/): compile with -Xlint:all -Werror on Java 21, run
# all unit, shared conformance, Micrometer, Spring Boot, CLI, and OTLP wire
# suites, plus the hygiene gate.
java-check:
	cd java && mvn -B test
	scripts/java-hygiene.sh java

# vuln runs last: it depends on the advisory database and the toolchain's
# patch level, so local runs exercise every other gate first.
ci: lint vet test tidy-check spec-check spec-drift ops-check ops-integration ts-check ts-size ts-browser-test ts-rn-check rum-e2e o11yrum-image rust-check rust-msrv zig-check python-check c-check ruby-check dotnet-check java-check schema-published-test release-notes-test release-tag-test ops-promtool-test ops-release-check-test rust-release-check-test ts-browser-bundle-test ts-rn-bundle-test ts-npm-plan-test release-check vuln
