#!/usr/bin/env bash
# c-release-check.sh: validate the libo11y C11 library at VERSION. It checks
# c/build.zig.zon, the O11Y_VERSION macros in c/include/o11y/o11y.h and
# c/CHANGELOG.md, installs a ReleaseSafe prefix, checks the installed files
# and the version in the pkg-config and CMake metadata, links an external C11
# consumer against libo11ytest.a and an in-process OTLP/HTTP receiver, and
# runs the installed libo11y registry check CLI. When pkg-config or cmake is
# on PATH it also builds a consumer through each.
#
# Usage: c-release-check.sh [VERSION]
#   VERSION defaults to v0.1.0 (leading v is optional).
set -euo pipefail

version="${1:-v0.1.0}"
plain="${version#v}"
if [[ -z "$plain" ]]; then
	echo "c-release-check: version must not be empty" >&2
	exit 1
fi

fail() {
	echo "c-release-check: $*" >&2
	exit 1
}

repo_root="$(git rev-parse --show-toplevel)"

got="$(sed -nE 's/^[[:space:]]*\.version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$repo_root/c/build.zig.zon" | head -n 1)"
[[ "$got" == "$plain" ]] || fail "c/build.zig.zon is at version ${got:-unset}, want $plain"

header="$repo_root/c/include/o11y/o11y.h"
macro="$(sed -nE 's/^#define O11Y_VERSION "([^"]+)".*/\1/p' "$header")"
[[ "$macro" == "$plain" ]] || fail "O11Y_VERSION in c/include/o11y/o11y.h is ${macro:-unset}, want $plain"
parts="$(sed -nE 's/^#define O11Y_VERSION_(MAJOR|MINOR|PATCH) ([0-9]+).*/\2/p' "$header" | paste -sd. -)"
[[ "$parts" == "${plain%%-*}" ]] || fail "O11Y_VERSION_MAJOR.MINOR.PATCH in c/include/o11y/o11y.h is ${parts:-unset}, want ${plain%%-*}"

"$repo_root/scripts/release-notes.sh" "$plain" "$repo_root/c/CHANGELOG.md" >/dev/null
echo "c-release-check: c/build.zig.zon, o11y.h and c/CHANGELOG.md match $plain"

tmp="$(mktemp -d)"
cleanup() {
	rm -rf "$tmp"
}
trap cleanup EXIT

prefix="$tmp/prefix"
(cd "$repo_root/c" && zig build -j"${ZIG_BUILD_J:-4}" -Doptimize=ReleaseSafe --prefix "$prefix")

for rel in \
	include/o11y/spec.h \
	include/o11y/o11y.h \
	include/o11y/test.h \
	lib/libo11y.a \
	lib/libo11ytest.a \
	bin/libo11y \
	lib/pkgconfig/libo11y.pc \
	lib/pkgconfig/libo11ytest.pc \
	lib/cmake/libo11y/libo11yConfig.cmake \
	lib/cmake/libo11y/libo11yConfigVersion.cmake; do
	[[ -f "$prefix/$rel" ]] || fail "installed prefix missing $rel"
done
if [[ ! -f "$prefix/lib/libo11y.so" && ! -f "$prefix/lib/libo11y.dylib" ]]; then
	fail "installed prefix missing shared library (libo11y.so or libo11y.dylib)"
fi
# The shared library is versioned, with the plain name as a link to it.
if [[ ! -f "$prefix/lib/libo11y.so.$plain" && ! -f "$prefix/lib/libo11y.$plain.dylib" ]]; then
	fail "installed prefix missing the versioned shared library for $plain"
fi
for pc in libo11y libo11ytest; do
	grep -qx "Version: $plain" "$prefix/lib/pkgconfig/$pc.pc" || fail "$pc.pc does not carry Version: $plain"
	grep -qxF 'prefix=${pcfiledir}/../..' "$prefix/lib/pkgconfig/$pc.pc" || fail "$pc.pc is not relocatable"
done
grep -qxF "set(PACKAGE_VERSION \"$plain\")" "$prefix/lib/cmake/libo11y/libo11yConfigVersion.cmake" ||
	fail "libo11yConfigVersion.cmake does not carry version $plain"
echo "c-release-check: installed prefix artifacts verified"

# Verify the installed registry check CLI.
cat >"$tmp/registry.yaml" <<'EOF'
schema: libo11y.app-registry/v1
namespace: smoke
attributes:
  smoke.order.id: {type: string, sensitivity: internal, cardinality: unbounded}
EOF
"$prefix/bin/libo11y" registry check "$tmp/registry.yaml"

# Compile and run a standalone external C11 consumer against an in-process
# OTLP/HTTP receiver covering traces, logs, and metrics with exemplars.
cat >"$tmp/consumer.c" <<EOF
#include <stdio.h>
#include <string.h>

#include "o11y/test.h"

int main(void) {
    if (strcmp(o11y_version(), "$plain") != 0) {
        fprintf(stderr, "version mismatch: got %s, want $plain\n", o11y_version());
        return 1;
    }

    o11y_test_http_receiver_t *rx = NULL;
    if (o11y_test_http_receiver_start(NULL, &rx) != O11Y_OK || rx == NULL) {
        fprintf(stderr, "failed to start OTLP HTTP receiver\n");
        return 1;
    }

    const char *url = o11y_test_http_receiver_url(rx);
    o11y_env_pair_t env_pairs[] = {
        { "OTEL_EXPORTER_OTLP_ENDPOINT", url },
        { "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf" },
    };

    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_PAIRS;
    opts.env_pairs = env_pairs;
    opts.env_pairs_len = 2;
    opts.service_name = "c-release-smoke";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;

    o11y_sdk_t *sdk = NULL;
    o11y_diagnostic_t diag = {0};
    o11y_err_t err = o11y_init(&opts, &sdk, &diag);
    if (err != O11Y_OK || sdk == NULL) {
        fprintf(stderr, "o11y_init failed (%s): %s\n", o11y_err_name(err), diag.message);
        o11y_test_http_receiver_destroy(rx);
        return 1;
    }

    o11y_tracer_t *tr = o11y_tracer(sdk, "smoke");
    o11y_meter_t *m = o11y_meter(sdk, "smoke");
    o11y_counter_i64_t reqs = o11y_meter_counter_i64(m, "smoke.requests", NULL);

    o11y_span_t *sp = o11y_tracer_start(tr, NULL, "smoke.op", NULL);
    o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, sp);
    o11y_log_info(sdk, ctx, "smoke log", NULL, 0);
    o11y_counter_i64_add(reqs, ctx, 1, NULL, 0);
    o11y_ctx_destroy(ctx);
    o11y_span_end(sp);

    o11y_shutdown_report_t report = {0};
    o11y_err_t serr = o11y_shutdown(sdk, 5000, &report);
    o11y_destroy(sdk);

    int ok = (serr == O11Y_OK) &&
        o11y_shutdown_report_ok(report) &&
        o11y_test_http_receiver_wait_requests(rx, 3, 5000) &&
        o11y_test_http_receiver_span_count(rx) >= 1 &&
        o11y_test_http_receiver_metric_count(rx) >= 1 &&
        o11y_test_http_receiver_log_count(rx) >= 1 &&
        o11y_test_http_receiver_decode_errors(rx) == 0;

    if (!ok) {
        fprintf(stderr, "smoke assertions failed: spans=%zu metrics=%zu logs=%zu decode_errors=%zu\n",
            o11y_test_http_receiver_span_count(rx),
            o11y_test_http_receiver_metric_count(rx),
            o11y_test_http_receiver_log_count(rx),
            o11y_test_http_receiver_decode_errors(rx));
    }

    o11y_test_http_receiver_destroy(rx);
    return ok ? 0 : 1;
}
EOF

cc -std=c11 -Wall -Wextra -Werror -Wpedantic \
	-I"$prefix/include" "$tmp/consumer.c" "$prefix/lib/libo11ytest.a" -lpthread -lm \
	-o "$tmp/consumer"
"$tmp/consumer"
echo "c-release-check: consumer smoke test passed for libo11y-c v$plain"

# The same consumer through pkg-config, when it is installed.
if command -v pkg-config >/dev/null; then
	got="$(PKG_CONFIG_PATH="$prefix/lib/pkgconfig" pkg-config --modversion libo11y)"
	[[ "$got" == "$plain" ]] || fail "pkg-config reports libo11y $got, want $plain"
	read -r -a pc_flags < <(PKG_CONFIG_PATH="$prefix/lib/pkgconfig" pkg-config --cflags --libs libo11ytest)
	cc -std=c11 -Wall -Wextra -Werror -Wpedantic "$tmp/consumer.c" "${pc_flags[@]}" -o "$tmp/consumer-pc"
	"$tmp/consumer-pc"
	echo "c-release-check: pkg-config consumer passed"
else
	echo "c-release-check: pkg-config not on PATH, skipping its consumer"
fi

# The same consumer through CMake's find_package, when it is installed. The
# request names the major and minor version, which the version file accepts,
# and a second configure asks for the next minor, which it must refuse.
if command -v cmake >/dev/null; then
	minor="${plain%.*}"
	next_minor="${minor%.*}.$((${minor##*.} + 1))"
	mkdir "$tmp/cmake-src"
	cp "$tmp/consumer.c" "$tmp/cmake-src/consumer.c"
	cat >"$tmp/cmake-src/CMakeLists.txt" <<'EOF'
cmake_minimum_required(VERSION 3.16)
project(libo11y_consumer C)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
find_package(libo11y ${LIBO11Y_WANT} REQUIRED CONFIG)
add_executable(consumer consumer.c)
target_link_libraries(consumer PRIVATE libo11y::o11ytest)
EOF
	cmake -S "$tmp/cmake-src" -B "$tmp/cmake-build" -DCMAKE_PREFIX_PATH="$prefix" -DLIBO11Y_WANT="$minor" >"$tmp/cmake.log" 2>&1 ||
		{ cat "$tmp/cmake.log" >&2; fail "cmake could not configure a consumer of libo11y $minor"; }
	cmake --build "$tmp/cmake-build" >"$tmp/cmake.log" 2>&1 ||
		{ cat "$tmp/cmake.log" >&2; fail "cmake could not build the consumer"; }
	"$tmp/cmake-build/consumer"
	if cmake -S "$tmp/cmake-src" -B "$tmp/cmake-build-next" -DCMAKE_PREFIX_PATH="$prefix" -DLIBO11Y_WANT="$next_minor" >"$tmp/cmake.log" 2>&1; then
		fail "find_package(libo11y $next_minor) accepted version $plain"
	fi
	echo "c-release-check: CMake consumer passed"
else
	echo "c-release-check: cmake not on PATH, skipping its consumer"
fi
