# libo11y build targets.

.PHONY: spec-check spec-generate spec-drift test lint release-check

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

test:
	cd go && go test -race ./...
	cd go/o11ygin && go test -race ./...

lint:
	cd go && golangci-lint run ./...
	cd go/o11ygin && golangci-lint run ./...

# Release version validated by release-check.
VERSION ?= v0.1.0

# Validate the first release sequence (go/VERSION and go/o11ygin/VERSION on
# HEAD) against a throwaway local remote. Needs a clean working tree.
release-check:
	scripts/release-check.sh $(VERSION)
