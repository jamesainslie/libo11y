#!/usr/bin/env bash
# release-check.sh: validate the release sequence (tag go/VERSION and each
# submodule's go/<name>/VERSION on the same commit) against a throwaway
# local remote. It never touches the real repository's refs, its remote,
# or the shared module cache.
#
# Usage: release-check.sh [VERSION]   (default v0.3.0; `make release-check`
# passes RELEASE_VERSION). The default matches the version the submodules
# require of the parent module, because the check asserts that requirement.
# A release commit moves it, here and RELEASE_VERSION in the Makefile,
# together with the submodules' go.mod requirements.
set -euo pipefail

version="${1:-v0.3.0}"
module="github.com/jamesainslie/libo11y"
# The Go submodules, each released as go/<name>/VERSION on the go/VERSION
# commit and requiring the parent module at the same version.
submodules=(o11ygin o11yconnect o11ysql)

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
for sub in "${submodules[@]}"; do
	git -C "$remote" tag -f "go/$sub/$version" "$head" >/dev/null
done

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

# 1. Each submodule as published: no replace, parent resolved from its tag.
# The release is lockstep, so each go.mod must require the parent at the
# version being released (the release workflow rejects anything else).
clone="$work/clone"
git -c advice.detachedHead=false clone --quiet --branch "go/$version" "$remote" "$clone"
for sub in "${submodules[@]}"; do
	(
		cd "$clone/go/$sub"
		# With the replace still in place, this reads the require line
		# without resolving anything.
		required="$(go list -m -f '{{.Version}}' "$module/go")"
		if [[ "$required" != "$version" ]]; then
			echo "release-check: go/$sub/go.mod requires the parent at ${required:-nothing}, not $version" >&2
			exit 1
		fi
		go mod edit -dropreplace="$module/go"
		go mod tidy
		go build ./...
		go vet ./...
		go test -count=1 -p 4 ./...
	)
done

# 2. An external consumer with no replace directives.
consumer="$work/consumer"
mkdir -p "$consumer"
cat >"$consumer/main.go" <<'EOF'
package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"

	"github.com/gin-gonic/gin"

	o11y "github.com/jamesainslie/libo11y/go"
	"github.com/jamesainslie/libo11y/go/o11yconnect"
	"github.com/jamesainslie/libo11y/go/o11ygin"
	"github.com/jamesainslie/libo11y/go/o11yproc"
	"github.com/jamesainslie/libo11y/go/o11ysql"
)

// fakeDriver lets o11ysql.Open reach its own wrapping and pool metrics
// without a real database. database/sql opens connections lazily, so Open
// never calls it.
type fakeDriver struct{}

func (fakeDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("fakeDriver opens no connections")
}

func main() {
	sql.Register("consumer-fake", fakeDriver{})
	ctx := context.Background()
	sdk, err := o11y.New(ctx,
		o11y.WithServiceName("consumer"), o11y.WithEnvironment("test"),
		o11y.WithoutOTELEnv(), o11y.WithoutConsoleLog(), o11y.WithoutRuntimeMetrics())
	if err != nil {
		panic(err)
	}
	defer func() { _ = sdk.Shutdown(context.Background()) }()
	router := gin.New()
	router.Use(o11ygin.Middleware("consumer", o11ygin.WithSDK(sdk)))
	if _, err := o11yconnect.ServerInterceptor(o11yconnect.WithSDK(sdk)); err != nil {
		panic(err)
	}
	if _, err := o11ysql.Open("no-such-driver", ""); err == nil {
		panic("o11ysql.Open accepted an unregistered driver")
	}
	db, err := o11ysql.Open("consumer-fake", "", o11ysql.WithSDK(sdk))
	if err != nil {
		panic(err)
	}
	if err := db.Close(); err != nil {
		panic(err)
	}
	if env := o11yproc.Env(ctx); env != nil {
		panic("o11yproc.Env returned entries outside any span")
	}
	if !sdk.Capture(ctx).IsZero() {
		panic("Capture returned a context outside any span")
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
	go get "$module/go@$version" "$module/go/o11ygin@$version" "$module/go/o11yconnect@$version" "$module/go/o11ysql@$version"
	go mod tidy
	if grep -q '^replace' go.mod; then
		echo "release-check: consumer go.mod contains a replace directive" >&2
		exit 1
	fi
	# Release mode keeps gin's debug banner off stdout.
	test "$(GIN_MODE=release go run .)" = ok
)

echo "release-check: OK, go/$version and go/{$(IFS=,; echo "${submodules[*]}")}/$version resolve and build for an external consumer"
