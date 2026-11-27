#!/usr/bin/env bash
# c-release-check.sh: validate the libo11y C11 library at VERSION by checking
# c/build.zig.zon and c/CHANGELOG.md, installing a ReleaseSafe prefix, linking
# an external C11 consumer against libo11ytest.a and an in-process OTLP/HTTP
# receiver, and running the installed libo11y registry check CLI.
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

"$repo_root/scripts/release-notes.sh" "$plain" "$repo_root/c/CHANGELOG.md" >/dev/null
echo "c-release-check: c/build.zig.zon and c/CHANGELOG.md match $plain"

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
	lib/cmake/libo11y/libo11yConfig.cmake; do
	[[ -f "$prefix/$rel" ]] || fail "installed prefix missing $rel"
done
if [[ ! -f "$prefix/lib/libo11y.so" && ! -f "$prefix/lib/libo11y.dylib" ]]; then
	fail "installed prefix missing shared library (libo11y.so or libo11y.dylib)"
fi
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
