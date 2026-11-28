#!/usr/bin/env bash
# zig-release-check.sh: validate the libo11y Zig package as an external
# consumer fetches and runs it.
#
# Usage: zig-release-check.sh [VERSION] [--url URL]
#
# Defaults:
#   VERSION  v0.1.0 (leading v is optional; `make zig-release-check` passes
#            v$(ZIG_RELEASE_VERSION)).
#
# Without --url:
#   Requires a clean working tree, verifies that both build.zig.zon and
#   zig/build.zig.zon declare VERSION, verifies that zig/CHANGELOG.md has a
#   non-empty release notes section for VERSION, archives HEAD as a tarball,
#   and fetches that tarball into a throwaway consumer outside the repository.
#
# With --url URL (used by the release workflow's zig-smoke job):
#   Fetches URL (for example git+https://github.com/OWNER/REPO#zig/vX.Y.Z)
#   directly into a throwaway consumer without reading the repository tree.
#
# In both modes, the consumer runs with an isolated ZIG_GLOBAL_CACHE_DIR,
# checks that the fetched package contains no conformance/ or zig/test/
# directory, builds and runs a consumer binary against an in-process
# o11ytest.HttpReceiver across traces, metrics, and logs, and confirms that
# none of the optional lazy dependencies (httpz, pg, sqlite) were fetched.
set -euo pipefail

version="v0.1.0"
version_set=false
url=""

while (($# > 0)); do
	case "$1" in
	--url)
		if (($# < 2)) || [[ -z "$2" ]]; then
			echo "usage: zig-release-check.sh [VERSION] [--url URL]" >&2
			exit 2
		fi
		url="$2"
		shift 2
		;;
	--url=*)
		url="${1#--url=}"
		if [[ -z "$url" ]]; then
			echo "usage: zig-release-check.sh [VERSION] [--url URL]" >&2
			exit 2
		fi
		shift
		;;
	-h | --help)
		echo "usage: zig-release-check.sh [VERSION] [--url URL]" >&2
		exit 0
		;;
	-*)
		echo "zig-release-check: unknown option: $1" >&2
		exit 2
		;;
	*)
		if [[ "$version_set" == true ]]; then
			echo "usage: zig-release-check.sh [VERSION] [--url URL]" >&2
			exit 2
		fi
		version="$1"
		version_set=true
		shift
		;;
	esac
done

plain="${version#v}"
if [[ -z "$plain" ]]; then
	echo "zig-release-check: version must not be empty" >&2
	exit 1
fi

fail() {
	echo "zig-release-check: $*" >&2
	exit 1
}

tmp="$(mktemp -d)"
cleanup() {
	rm -rf "$tmp"
}
trap cleanup EXIT

if [[ -n "$url" ]]; then
	fetch_target="$url"
else
	repo_root="$(git rev-parse --show-toplevel)"
	if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
		fail "commit or stash changes first; the check archives HEAD"
	fi

	for manifest in "$repo_root/build.zig.zon" "$repo_root/zig/build.zig.zon"; do
		got="$(sed -nE 's/^[[:space:]]*\.version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$manifest" | head -n 1)"
		[[ "$got" == "$plain" ]] || fail "${manifest#"$repo_root/"} is at version ${got:-unset}, want $plain"
	done

	"$repo_root/scripts/release-notes.sh" "$plain" "$repo_root/zig/CHANGELOG.md" >/dev/null
	echo "zig-release-check: manifests and zig/CHANGELOG.md match $plain"

	tarball="$tmp/libo11y-v$plain.tar.gz"
	git -C "$repo_root" archive --format=tar.gz --prefix="libo11y-v$plain/" HEAD -o "$tarball"
	fetch_target="$tarball"
fi

# Isolate Zig's global cache and use the consumer's default relative zig-pkg
# directory so cached optional deps on the host cannot interfere with the
# lazy-dependency check. (Unsetting ZIG_LOCAL_PKG_DIR keeps nested .path
# dependencies relative to the build root in Zig 0.17.)
cache_dir="$tmp/zig-cache"
consumer="$tmp/consumer"
pkg_root="$consumer/zig-pkg"
export ZIG_GLOBAL_CACHE_DIR="$cache_dir"
unset ZIG_LOCAL_PKG_DIR

mkdir -p "$consumer/src"

cat >"$consumer/build.zig.zon" <<'EOF'
.{
    .name = .consumer,
    .version = "0.0.0",
    .fingerprint = 0x705b3727de3b6939,
    .minimum_zig_version = "0.17.1",
    .dependencies = .{},
    .paths = .{
        "build.zig",
        "build.zig.zon",
        "src",
    },
}
EOF

cat >"$consumer/build.zig" <<'EOF'
const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const libo11y = b.dependency("libo11y", .{
        .target = target,
        .optimize = optimize,
    });

    const exe = b.addExecutable(.{
        .name = "consumer",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "o11y", .module = libo11y.module("o11y") },
                .{ .name = "o11ytest", .module = libo11y.module("o11ytest") },
            },
        }),
    });

    const run_cmd = b.addRunArtifact(exe);
    const run_step = b.step("run", "Run the consumer smoke check");
    run_step.dependOn(&run_cmd.step);
}
EOF

(
	cd "$consumer"
	zig fetch --save "$fetch_target"
)

pkg_hash="$(awk '
	/\.libo11y[[:space:]]*=/ { in_dep = 1 }
	in_dep && /\.hash[[:space:]]*=/ {
		if (match($0, /"[^"]+"/)) {
			print substr($0, RSTART + 1, RLENGTH - 2)
			exit
		}
	}
' "$consumer/build.zig.zon")"
[[ -n "$pkg_hash" ]] || fail "could not find saved libo11y hash in consumer build.zig.zon"

pkg_dir="$pkg_root/$pkg_hash"
if [[ ! -d "$pkg_dir" && -d "$cache_dir/p/$pkg_hash" ]]; then
	pkg_dir="$cache_dir/p/$pkg_hash"
fi
[[ -d "$pkg_dir" ]] || fail "fetched package directory missing: $pkg_dir"
[[ -d "$pkg_dir/zig/src" ]] || fail "fetched package missing zig/src"
[[ ! -e "$pkg_dir/conformance" ]] || fail "fetched package unexpectedly includes conformance/"
if [[ -d "$pkg_dir/zig/test" ]] && [[ -n "$(find "$pkg_dir/zig/test" -type f)" ]]; then
	fail "fetched package unexpectedly includes files under zig/test/"
fi
echo "zig-release-check: fetched package $pkg_hash excludes conformance/ and zig/test/ files"

cat >"$consumer/src/main.zig" <<EOF
const std = @import("std");
const o11y = @import("o11y");
const o11ytest = @import("o11ytest");

const expected_version = "$plain";

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;

    if (!std.mem.eql(u8, o11y.version, expected_version)) {
        return error.VersionMismatch;
    }

    const recv = try o11ytest.HttpReceiver.start(gpa, io, .{});
    defer recv.deinit();

    const base_url = try recv.baseUrl(gpa);
    defer gpa.free(base_url);

    const env_pairs = [_][2][]const u8{
        .{ "OTEL_EXPORTER_OTLP_ENDPOINT", base_url },
        .{ "OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf" },
        .{ "OTEL_TRACES_EXPORTER", "otlp" },
        .{ "OTEL_METRICS_EXPORTER", "otlp" },
        .{ "OTEL_LOGS_EXPORTER", "otlp" },
        .{ "OTEL_METRIC_EXPORT_INTERVAL", "3600000" },
        .{ "OTEL_BSP_SCHEDULE_DELAY", "60000" },
        .{ "OTEL_BLRP_SCHEDULE_DELAY", "60000" },
    };

    const sdk = try o11y.init(gpa, io, .{
        .env = .{ .pairs = &env_pairs },
        .service_name = "zig-release-smoke",
        .environment = o11y.spec.Environment.@"test".asStr(),
        .console_enabled = false,
        .runtime_metrics = false,
    });
    defer sdk.deinit();

    var sp = sdk.tracer("smoke").start(.background, "smoke-op", .{
        .attributes = &.{
            o11y.kv("http.request.method", "GET"),
        },
    });
    const ctx = o11y.Context.background.withSpan(&sp);
    const want_trace_id = sp.spanContext().trace_id;
    const want_span_id = sp.spanContext().span_id;

    const counter = sdk.meter("smoke").counter(i64, "smoke.requests", .{ .unit = "{request}" });
    counter.add(ctx, 1, &.{
        o11y.kv("http.request.method", "GET"),
    });

    sdk.logger().info(ctx, "smoke-log", .{ .smoke_ok = true });
    sp.end();

    const report = sdk.shutdown(.fromSeconds(10));
    if (!report.ok()) return error.ShutdownFailed;

    try recv.waitForRequests(3, .fromSeconds(5));
    if (recv.decodeErrors() != 0) return error.DecodeErrors;

    const span = o11ytest.inspect.findSpan(recv.traces(), "smoke-op") orelse return error.SpanMissing;
    if (!std.mem.eql(u8, &want_trace_id.bytes, span.trace_id)) return error.SpanTraceIdMismatch;
    if (!std.mem.eql(u8, &want_span_id.bytes, span.span_id)) return error.SpanSpanIdMismatch;

    if (recv.metrics().len == 0) return error.MetricsMissing;
    var found_metric = false;
    for (recv.metrics()) |*rm| {
        for (rm.scope_metrics.items) |*sm| {
            for (sm.metrics.items) |*m| {
                if (std.mem.eql(u8, m.name, "smoke.requests")) {
                    found_metric = true;
                }
            }
        }
    }
    if (!found_metric) return error.MetricMissing;

    const lr = o11ytest.inspect.findLogByBody(recv.logs(), "smoke-log") orelse return error.LogMissing;
    if (!std.mem.eql(u8, &want_trace_id.bytes, lr.trace_id)) return error.LogTraceIdMismatch;
    if (!std.mem.eql(u8, &want_span_id.bytes, lr.span_id)) return error.LogSpanIdMismatch;
}
EOF

(
	cd "$consumer"
	zig build run -j"${ZIG_BUILD_J:-4}"
)
echo "zig-release-check: consumer built and exported span, metric, and correlated log"

shopt -s nullglob
for dep in httpz pg sqlite; do
	matches=("$pkg_root"/"$dep"-* "$cache_dir"/p/"$dep"-*)
	if ((${#matches[@]} > 0)); then
		fail "lazy dependency $dep was unexpectedly fetched: ${matches[*]}"
	fi
done
shopt -u nullglob
echo "zig-release-check: no lazy integration dependencies (httpz, pg, sqlite) were fetched"
echo "zig-release-check: OK, libo11y-zig v$plain builds and runs cleanly for an external consumer"
