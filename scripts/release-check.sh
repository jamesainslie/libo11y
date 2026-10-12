#!/usr/bin/env bash
# release-check.sh: validate the first release sequence (tag go/VERSION and
# go/o11ygin/VERSION on the same commit) against a throwaway local remote.
# It never touches the real repository's refs, its remote, or the shared
# module cache.
set -euo pipefail

version="${1:-v0.1.0}"
module="github.com/jamesainslie/libo11y"
repo_root="$(git rev-parse --show-toplevel)"

if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
	echo "release-check: commit or stash changes first; the check releases HEAD" >&2
	exit 1
fi

work="$(mktemp -d)"
cleanup() {
	chmod -R u+w "$work" 2>/dev/null || true
	rm -rf "$work"
}
trap cleanup EXIT

remote="$work/remote.git"
git clone --quiet --bare "$repo_root" "$remote"
git -C "$remote" tag "go/$version" HEAD
git -C "$remote" tag "go/o11ygin/$version" HEAD

# Route the module path to the throwaway remote for every git call below.
export GIT_CONFIG_GLOBAL="$work/gitconfig"
git config --file "$GIT_CONFIG_GLOBAL" "url.file://$remote.insteadOf" "https://$module"
git config --file "$GIT_CONFIG_GLOBAL" protocol.file.allow always
export GIT_ALLOW_PROTOCOL="file:https:ssh"

real_cache="$(go env GOMODCACHE)"
export GOMODCACHE="$work/modcache" # the simulated tags must never enter the real cache
export GOPROXY="file://$real_cache/cache/download,https://proxy.golang.org"
export GOPRIVATE="$module"
export GOFLAGS=-mod=mod
export GOWORK=off
export GOTOOLCHAIN=local

# 1. The gin module as published: no replace, parent resolved from the tag.
clone="$work/clone"
git clone --quiet "$remote" "$clone"
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
	go mod init example.com/consumer >/dev/null 2>&1
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
