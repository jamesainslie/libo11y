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
if [[ "${plain%%.*}" == "0" ]]; then
	abi_ver="0.${plain#0.}"
	abi_ver="${abi_ver%.*}"
else
	abi_ver="${plain%%.*}"
fi

if [[ ! -f "$prefix/lib/libo11y.so" && ! -f "$prefix/lib/libo11y.dylib" ]]; then
	fail "installed prefix missing shared library (libo11y.so or libo11y.dylib)"
fi
# The shared library is versioned, with ABI version and plain name symlinks.
if [[ ! -f "$prefix/lib/libo11y.so.$plain" && ! -f "$prefix/lib/libo11y.$plain.dylib" ]]; then
	fail "installed prefix missing the versioned shared library for $plain"
fi
if [[ ! -L "$prefix/lib/libo11y.so.$abi_ver" && ! -L "$prefix/lib/libo11y.$abi_ver.dylib" ]]; then
	fail "installed prefix missing the ABI-versioned shared library symlink for $abi_ver"
fi
if [[ "$(uname -s)" == "Linux" ]]; then
	readelf -dW "$prefix/lib/libo11y.so" | grep -q "SONAME.*libo11y\.so\.$abi_ver" ||
		fail "libo11y.so missing expected ELF SONAME libo11y.so.$abi_ver"
	! readelf -lW "$prefix/lib/libo11y.so" | grep -q "GNU_STACK.*RWE" ||
		fail "libo11y.so has executable GNU_STACK"
	bad_syms="$(nm -D --defined-only "$prefix/lib/libo11y.so" | awk '$2 ~ /[TWDBR]/ && $3 !~ /^o11y_/ {print $3}')"
	[[ -z "$bad_syms" ]] || fail "libo11y.so exports non-o11y symbols: $bad_syms"
elif [[ "$(uname -s)" == "Darwin" ]]; then
	otool -D "$prefix/lib/libo11y.dylib" | grep -q "libo11y\.$abi_ver\.dylib" ||
		fail "libo11y.dylib missing expected install_name libo11y.$abi_ver.dylib"
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

    o11y_shutdown_report_t report = { O11Y_OK, O11Y_OK, O11Y_OK };
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
    if (!ok) return 1;

    /* Also verify exemplar-trace triangle on the hermetic recorder. */
    o11y_test_options_t topts = o11y_test_options_default();
    o11y_test_recorder_t *rec = NULL;
    if (o11y_test_start(&topts, &rec, NULL) != O11Y_OK || rec == NULL) {
        fprintf(stderr, "o11y_test_start failed\n");
        return 1;
    }
    o11y_sdk_t *tsdk = o11y_test_sdk(rec);
    o11y_span_t *tsp = o11y_tracer_start(o11y_tracer(tsdk, "smoke"), NULL, "smoke.tri", NULL);
    o11y_ctx_t *tctx = o11y_ctx_with_span(NULL, tsp);
    o11y_log_info(tsdk, tctx, "smoke tri", NULL, 0);
    o11y_counter_i64_t treqs = o11y_meter_counter_i64(o11y_meter(tsdk, "smoke"), "smoke.requests", NULL);
    o11y_counter_i64_add(treqs, tctx, 1, NULL, 0);
    o11y_ctx_destroy(tctx);
    o11y_span_end(tsp);
    o11y_test_report_t *tri = o11y_test_check_triangle(rec, "smoke.requests");
    int tri_ok = (o11y_test_exemplar_count(rec, "smoke.requests") >= 1) && o11y_test_report_ok(tri);
    if (!tri_ok) {
        fprintf(stderr, "exemplar/triangle smoke check failed (exemplars=%zu)\n",
            o11y_test_exemplar_count(rec, "smoke.requests"));
    }
    o11y_test_report_destroy(tri);
    o11y_test_destroy(rec);
    return tri_ok ? 0 : 1;
}
EOF

cat >"$tmp/shared_consumer.c" <<EOF
#include <string.h>
#include "o11y/o11y.h"

int main(void) {
    if (strcmp(o11y_version(), "$plain") != 0) return 1;
    o11y_options_t opts = o11y_options_default();
    opts.env_mode = O11Y_ENV_HERMETIC;
    opts.service_name = "c-shared-smoke";
    opts.environment = O11Y_ENVIRONMENT_TEST;
    opts.console_enabled = false;
    opts.runtime_metrics = false;
    o11y_sdk_t *sdk = NULL;
    if (o11y_init(&opts, &sdk, NULL) != O11Y_OK || sdk == NULL) return 2;
    o11y_span_t *sp = o11y_tracer_start(o11y_tracer(sdk, "smoke"), NULL, "op", NULL);
    o11y_ctx_t *ctx = o11y_ctx_with_span(NULL, sp);
    o11y_log_info(sdk, ctx, "ok", NULL, 0);
    o11y_counter_i64_t c = o11y_meter_counter_i64(o11y_meter(sdk, "smoke"), "smoke.n", NULL);
    o11y_counter_i64_add(c, ctx, 1, NULL, 0);
    o11y_ctx_destroy(ctx);
    o11y_span_end(sp);
    o11y_shutdown_report_t report = { O11Y_OK, O11Y_OK, O11Y_OK };
    o11y_err_t serr = o11y_shutdown(sdk, 5000, &report);
    o11y_destroy(sdk);
    return (serr == O11Y_OK && o11y_shutdown_report_ok(report)) ? 0 : 3;
}
EOF

cc -std=c11 -Wall -Wextra -Werror -Wpedantic \
	-I"$prefix/include" "$tmp/consumer.c" "$prefix/lib/libo11ytest.a" -lpthread -lm \
	-o "$tmp/consumer"
"$tmp/consumer"
cc -std=c11 -Wall -Wextra -Werror -Wpedantic \
	-I"$prefix/include" "$tmp/shared_consumer.c" -L"$prefix/lib" -Wl,-rpath,"$prefix/lib" -lo11y -lpthread -lm \
	-o "$tmp/shared_consumer"
"$tmp/shared_consumer"
c++ -std=c++17 -Wall -Wextra -Werror -Wpedantic \
	-I"$prefix/include" -x c++ "$tmp/shared_consumer.c" -L"$prefix/lib" -Wl,-rpath,"$prefix/lib" -lo11y -lpthread -lm \
	-o "$tmp/shared_consumer_cpp"
"$tmp/shared_consumer_cpp"
echo "c-release-check: consumer smoke test passed for libo11y-c v$plain"

# The same consumer through pkg-config, when it is installed.
if command -v pkg-config >/dev/null; then
	got="$(PKG_CONFIG_PATH="$prefix/lib/pkgconfig" pkg-config --modversion libo11y)"
	[[ "$got" == "$plain" ]] || fail "pkg-config reports libo11y $got, want $plain"
	read -r -a pc_shared_flags < <(PKG_CONFIG_PATH="$prefix/lib/pkgconfig" pkg-config --cflags --libs libo11y)
	cc -std=c11 -Wall -Wextra -Werror -Wpedantic "$tmp/shared_consumer.c" "${pc_shared_flags[@]}" -Wl,-rpath,"$prefix/lib" -o "$tmp/consumer-pc-shared"
	"$tmp/consumer-pc-shared"
	mkdir -p "$tmp/static-only/lib/pkgconfig"
	ln -s "$prefix/include" "$tmp/static-only/include"
	ln -s "$prefix/lib/libo11y.a" "$tmp/static-only/lib/libo11y.a"
	cp "$prefix/lib/pkgconfig/libo11y.pc" "$tmp/static-only/lib/pkgconfig/libo11y.pc"
	read -r -a pc_static_flags < <(PKG_CONFIG_PATH="$tmp/static-only/lib/pkgconfig" pkg-config --cflags --libs --static libo11y)
	cc -std=c11 -Wall -Wextra -Werror -Wpedantic "$tmp/shared_consumer.c" "${pc_static_flags[@]}" -o "$tmp/consumer-pc-static"
	"$tmp/consumer-pc-static"
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
	cp "$tmp/shared_consumer.c" "$tmp/cmake-src/shared_consumer.c"
	cat >"$tmp/cmake-src/CMakeLists.txt" <<'EOF'
cmake_minimum_required(VERSION 3.16)
project(libo11y_consumer C)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
find_package(libo11y ${LIBO11Y_WANT} REQUIRED CONFIG)
add_executable(consumer consumer.c)
target_link_libraries(consumer PRIVATE libo11y::o11ytest)
add_executable(shared_default shared_consumer.c)
target_link_libraries(shared_default PRIVATE libo11y::o11y)
add_executable(shared_explicit shared_consumer.c)
target_link_libraries(shared_explicit PRIVATE libo11y::o11y_shared)
add_executable(static_explicit shared_consumer.c)
target_link_libraries(static_explicit PRIVATE libo11y::o11y_static)
EOF
	cmake -S "$tmp/cmake-src" -B "$tmp/cmake-build" -DCMAKE_PREFIX_PATH="$prefix" -DLIBO11Y_WANT="$minor" >"$tmp/cmake.log" 2>&1 ||
		{ cat "$tmp/cmake.log" >&2; fail "cmake could not configure a consumer of libo11y $minor"; }
	cmake --build "$tmp/cmake-build" >"$tmp/cmake.log" 2>&1 ||
		{ cat "$tmp/cmake.log" >&2; fail "cmake could not build the consumer"; }
	"$tmp/cmake-build/consumer"
	"$tmp/cmake-build/shared_default"
	"$tmp/cmake-build/shared_explicit"
	"$tmp/cmake-build/static_explicit"
	if cmake -S "$tmp/cmake-src" -B "$tmp/cmake-build-next" -DCMAKE_PREFIX_PATH="$prefix" -DLIBO11Y_WANT="$next_minor" >"$tmp/cmake.log" 2>&1; then
		fail "find_package(libo11y $next_minor) accepted version $plain"
	fi
	echo "c-release-check: CMake consumer passed"
else
	echo "c-release-check: cmake not on PATH, skipping its consumer"
fi
