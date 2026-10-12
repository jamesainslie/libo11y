#!/usr/bin/env bash
# release-check.sh: validate the release sequence (tag go/VERSION and
# go/o11ygin/VERSION on the same commit) against a throwaway local remote.
# It never touches the real repository's refs, its remote, or the shared
# module cache.
#
# Usage: release-check.sh [VERSION]   (default v0.2.0; `make release-check`
# passes RELEASE_VERSION). The default names the next unreleased version.
# After go/v0.2.0 is published, bump it (here and RELEASE_VERSION in the
# Makefile) to the next unreleased version so the check keeps validating
# the release that is actually coming.
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
export GIT_ALLOW_PROTOCOL="file:https:ssh"

repo_root="$(git rev-parse --show-toplevel)"
if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
	echo "release-check: commit or stash changes first; the check releases HEAD" >&2
	exit 1
fi
head="$(git -C "$repo_root" rev-parse HEAD)"

# --no-local copies objects through the pack protocol instead of
# hardlinking the real object store. The clone carries the real repo's
# tags; -f moves this version's tags to HEAD in the throwaway remote only,
# so the check still works once a real go/VERSION tag exists.
git clone --quiet --bare --no-local "$repo_root" "$remote"
git -C "$remote" tag -f "go/$version" "$head" >/dev/null
git -C "$remote" tag -f "go/o11ygin/$version" "$head" >/dev/null

real_cache="$(go env GOMODCACHE)"
export GOENV=off # ignore the user's go env file; everything below is explicit
export GOMODCACHE="$work/modcache" # the simulated tags must never enter the real cache
export GOPROXY="file://$real_cache/cache/download,https://proxy.golang.org"
export GOPRIVATE="$module"
export GONOPROXY="$module"
export GONOSUMDB="$module"
export GOFLAGS="-mod=mod -modcacherw" # writable cache, so cleanup needs no chmod
export GOWORK=off
export GOTOOLCHAIN=local

# 1. The gin module as published: no replace, parent resolved from the tag.
clone="$work/clone"
git -c advice.detachedHead=false clone --quiet --branch "go/o11ygin/$version" "$remote" "$clone"
(
	cd "$clone/go/o11ygin"
	go mod edit -dropreplace="$module/go"
	go mod tidy
	go build ./...
	go vet ./...
	go test -count=1 ./...
)

# 2. An external consumer with no replace directives.
consumer="$work/consumer"
mkdir -p "$consumer"
cat >"$consumer/main.go" <<'EOF'
package main

import (
	"context"
	"fmt"

	"github.com/gin-gonic/gin"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11ygin"
)

func main() {
	sdk, err := o11y.New(context.Background(),
		o11y.WithServiceName("consumer"), o11y.WithEnvironment("test"),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics())
	if err != nil {
		panic(err)
	}
	defer func() { _ = sdk.Shutdown(context.Background()) }()
	router := gin.New()
	router.Use(o11ygin.Middleware("consumer", o11ygin.WithSDK(sdk)))
	fmt.Println("ok")
}
EOF
(
	cd "$consumer"
	if ! init_out="$(go mod init example.com/consumer 2>&1)"; then
		echo "$init_out" >&2
		exit 1
	fi
	go get "$module/go@$version" "$module/go/o11ygin@$version"
	go mod tidy
	if grep -q '^replace' go.mod; then
		echo "release-check: consumer go.mod contains a replace directive" >&2
		exit 1
	fi
	# Release mode keeps gin's debug banner off stdout.
	test "$(GIN_MODE=release go run .)" = ok
)

echo "release-check: OK, go/$version and go/o11ygin/$version resolve and build for an external consumer"
