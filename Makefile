# libo11y build targets. `make ci` runs the same targets the CI workflow
# (.github/workflows/ci.yml) calls; keep the two in step when adding a gate.

# Package parallelism for go test; lower it on a loaded machine.
GO_TEST_P ?= 4

.PHONY: spec-check spec-generate spec-drift test lint vet tidy-check vuln release-check ci

# Validate the spec registry against the libo11y policy suite (naming,
# ownership, sensitivity, cardinality, events, units).
spec-check:
	cd go && go run ./internal/specgen -root .. -check

# Directories holding generated artifacts.
GENERATED := go/spec go/internal/spectables docs/taxonomy spec/schemas

# Validate the registry, then regenerate go/spec, go/internal/spectables,
# docs/taxonomy, and spec/schemas from it. An invalid registry generates
# nothing.
spec-generate:
	cd go && go run ./internal/specgen -root ..

# CI gate: generated artifacts must match the registry, and the generator
# must not have produced files git does not track.
spec-drift: spec-generate
	git diff --exit-code -- $(GENERATED)
	@untracked="$$(git ls-files --others --exclude-standard -- $(GENERATED))"; \
	if [ -n "$$untracked" ]; then echo "untracked generated files:"; echo "$$untracked"; exit 1; fi

vet:
	cd go && go vet ./...
	cd go/o11ygin && go vet ./...

test:
	cd go && go test -race -p $(GO_TEST_P) -count=1 ./...
	cd go/o11ygin && go test -race -p $(GO_TEST_P) -count=1 ./...

lint:
	cd go && golangci-lint run ./...
	cd go/o11ygin && golangci-lint run ./...

# Each module's go.mod and go.sum must already be tidy on its own.
tidy-check:
	cd go && GOWORK=off go mod tidy -diff
	cd go/o11ygin && GOWORK=off go mod tidy -diff

# Known vulnerabilities reachable from either module (needs govulncheck).
vuln:
	cd go && govulncheck ./...
	cd go/o11ygin && govulncheck ./...

# Next unreleased version, validated by release-check. Bump it after each
# release (see scripts/release-check.sh). CI uses this default.
RELEASE_VERSION ?= v0.1.0

# Validate the release sequence (go/RELEASE_VERSION and
# go/o11ygin/RELEASE_VERSION on HEAD) against a throwaway local remote.
# Needs a clean working tree.
release-check:
	scripts/release-check.sh $(RELEASE_VERSION)

# vuln runs last: it depends on the advisory database and the toolchain's
# patch level, so local runs exercise every other gate first.
ci: lint vet test tidy-check spec-check spec-drift release-check vuln
