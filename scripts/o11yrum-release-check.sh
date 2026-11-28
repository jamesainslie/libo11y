#!/usr/bin/env bash
# o11yrum-release-check.sh: validate an o11yrum release (tag
# go/o11yrum/VERSION on HEAD) against a throwaway local remote. o11yrum
# versions on its own line, so its go.mod may require any released parent
# version. The check requires that version to be a real go/ tag and the
# module to have no replace directive (`go install` refuses one), then
# builds, vets and tests the module against that parent release, installs the o11yrum-gateway command at the tag and checks it reports
# the version, and builds an external consumer. It never touches the real
# repository's refs, its remote, or the shared module cache.
#
# Needs git, go and jq.
#
# Usage: o11yrum-release-check.sh [VERSION]   (default v0.2.0; `make
# o11yrum-release-check` and `make release-check` pass
# O11YRUM_RELEASE_VERSION). A release commit moves the default here and in
# the Makefile together.
set -euo pipefail

version="${1:-v0.2.0}"
module="github.com/jamesainslie/libo11y"

work="$(mktemp -d)"
cleanup() {
	rm -rf "$work"
}
trap cleanup EXIT

# Isolate git configuration before the first git call: the user's global
# config (insteadOf rules, credential helpers) never applies, and the
# module path routes to the throwaway remote for every git call below.
remote="$work/remote.git"
export GIT_CONFIG_GLOBAL="$work/gitconfig"
git config --file "$GIT_CONFIG_GLOBAL" "url.file://$remote.insteadOf" "https://$module"
git config --file "$GIT_CONFIG_GLOBAL" protocol.file.allow always
git config --file "$GIT_CONFIG_GLOBAL" gc.auto 0
git config --file "$GIT_CONFIG_GLOBAL" maintenance.auto false
export GIT_ALLOW_PROTOCOL="file:https:ssh"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
	echo "o11yrum-release-check: commit or stash changes first; the check releases HEAD" >&2
	exit 1
fi
head="$(git -C "$repo_root" rev-parse HEAD)"

# --no-local copies objects through the pack protocol instead of
# hardlinking the real object store. The clone carries the real repo's
# tags, including the parent release o11yrum requires; -f moves this
# version's tag to HEAD in the throwaway remote only, so the check still
# works once a real go/o11yrum/VERSION tag exists.
git clone --quiet --bare --no-local "$repo_root" "$remote"
git -C "$remote" tag -f "go/o11yrum/$version" "$head" >/dev/null

real_cache="$(go env GOMODCACHE)"
export GOENV=off # ignore the user's go env file; everything below is explicit
export GOMODCACHE="$work/modcache" # the simulated tag must never enter the real cache
export GOPROXY="file://$real_cache/cache/download,https://proxy.golang.org"
export GOPRIVATE="$module"
export GONOPROXY="$module"
export GONOSUMDB="$module"
export GOFLAGS="-mod=mod -modcacherw" # writable cache, so cleanup needs no chmod
export GOWORK=off
export GOTOOLCHAIN=local

# 1. The module as published: the parent resolved from the go/ tag its
# go.mod requires. The go.work workspace resolves it from the checkout
# during development; GOWORK=off here, so nothing does.
clone="$work/clone"
git -c advice.detachedHead=false clone --quiet --branch "go/o11yrum/$version" "$remote" "$clone"
(
	cd "$clone/go/o11yrum"
	if go mod edit -json | jq -e '(.Replace // []) | length > 0' >/dev/null; then
		echo "o11yrum-release-check: go/o11yrum/go.mod has a replace directive; go install of the command at a tag refuses one" >&2
		exit 1
	fi
	required="$(go mod edit -json | jq -r '.Require[] | select(.Path == "github.com/jamesainslie/libo11y/go") | .Version')"
	if [[ -z "$required" ]] || ! git -C "$repo_root" rev-parse --verify --quiet "refs/tags/go/$required^{commit}" >/dev/null; then
		echo "o11yrum-release-check: go/o11yrum/go.mod requires the parent at ${required:-nothing}, which has no go/ release tag" >&2
		exit 1
	fi
	echo "$required" >"$work/required"
	go mod tidy -diff
	go build ./...
	go vet ./...
	go test -count=1 -p 4 ./...
)
required="$(cat "$work/required")"

# 2. The command as `go install` fetches it. With no linker flags it
# reports the module version Go records in the binary.
GOBIN="$work/bin" go install "$module/go/o11yrum/cmd/o11yrum-gateway@$version"
got="$("$work/bin/o11yrum-gateway" -version)"
if [[ "$got" != "$version" ]]; then
	echo "o11yrum-release-check: the installed o11yrum-gateway reports \"$got\", not $version" >&2
	exit 1
fi

# 3. An external consumer with no replace directives.
consumer="$work/consumer"
mkdir -p "$consumer"
cat >"$consumer/main.go" <<'EOF'
package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"

	"github.com/jamesainslie/libo11y/go/o11yrum"
)

func main() {
	cfg, err := o11yrum.ParseConfig([]byte("apps:\n  - {service_name: consumer, origins: [\"https://consumer.example\"]}\n"))
	if err != nil {
		panic(err)
	}
	h, err := o11yrum.NewHandler(o11yrum.WithConfig(cfg))
	if err != nil {
		panic(err)
	}
	defer func() { _ = h.Close() }()
	body := `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"consumer"}}]},` +
		`"scopeLogs":[{"logRecords":[{"body":{"stringValue":"hello"}}]}]}]}`
	r := httptest.NewRequest(http.MethodPost, "/_o11y/v1/logs", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Origin", "https://consumer.example")
	r.RemoteAddr = "192.0.2.1:1"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		panic(fmt.Sprintf("logs: status %d: %s", w.Code, w.Body.String()))
	}
	fmt.Println("ok")
}
EOF
(
	cd "$consumer"
	if ! init_out="$(go mod init example.com/consumer 2>&1)"; then
		echo "$init_out" >&2
		exit 1
	fi
	go get "$module/go/o11yrum@$version"
	go mod tidy
	if grep -q '^replace' go.mod; then
		echo "o11yrum-release-check: consumer go.mod contains a replace directive" >&2
		exit 1
	fi
	test "$(go run .)" = ok
)

echo "o11yrum-release-check: OK, go/o11yrum/$version builds against go/$required for an external consumer"
