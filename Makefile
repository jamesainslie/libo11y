# libo11y build targets. `make ci` runs the same targets the CI workflow
# (.github/workflows/ci.yml) calls; keep the two in step when adding a gate.

# Package parallelism for go test; lower it on a loaded machine.
GO_TEST_P ?= 4

# Every Go module in the repository. Each has its own go.mod and every Go
# gate runs on each module separately.
GO_MODULES := go go/o11ygin go/o11yconnect go/o11ysql

.PHONY: spec-check spec-generate spec-drift test lint vet tidy-check vuln release-check schema-published schema-published-test release-notes-test ts-install ts-check ci

# Validate the spec registry against the libo11y policy suite (naming,
# ownership, sensitivity, cardinality, events, units).
spec-check:
	cd go && go run ./internal/specgen -root .. -check

# Directories holding generated artifacts.
GENERATED := go/spec go/internal/spectables docs/taxonomy spec/schemas ts/packages/spec/src/generated

# Validate the registry, then regenerate go/spec, go/internal/spectables,
# docs/taxonomy, spec/schemas, and ts/packages/spec/src/generated from it.
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
# typecheck, and test every package (needs bun).
ts-install:
	cd ts && bun install --frozen-lockfile

ts-check: ts-install
	cd ts && bun run lint && bun run typecheck && bun test

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

# Next unreleased version, validated by release-check. Bump it after each
# release (see scripts/release-check.sh). CI uses this default.
RELEASE_VERSION ?= v0.2.0

# Validate the release sequence (go/RELEASE_VERSION and
# go/o11ygin/RELEASE_VERSION on HEAD) against a throwaway local remote.
# Needs a clean working tree.
release-check:
	scripts/release-check.sh $(RELEASE_VERSION)

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

# vuln runs last: it depends on the advisory database and the toolchain's
# patch level, so local runs exercise every other gate first.
ci: lint vet test tidy-check spec-check spec-drift ts-check schema-published-test release-notes-test release-check vuln
