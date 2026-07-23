# libo11y build targets.

.PHONY: spec-check spec-generate spec-drift test lint

# Validate the spec registry against the libo11y policy suite (naming,
# ownership, sensitivity, cardinality, events, units).
spec-check:
	cd go && go run ./internal/specgen -root .. -check

# Regenerate go/spec, go/internal/spectables, and docs/taxonomy from the
# registry.
spec-generate:
	cd go && go run ./internal/specgen -root ..

# CI gate: generated artifacts must match the registry.
spec-drift: spec-generate
	git diff --exit-code -- go/spec go/internal/spectables docs/taxonomy

test:
	cd go && go test -race ./...
	cd go/o11ygin && go test -race ./...

lint:
	cd go && golangci-lint run ./...
	cd go/o11ygin && golangci-lint run ./...
