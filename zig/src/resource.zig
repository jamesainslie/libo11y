//! Explicit environment lookup, resource composition, tier-0 identity
//! enforcement, container ID detection, and `service.instance.id` derivation.
//!
//! libo11y NEVER reads the process environment on its own; callers pass an
//! explicit `Env` value (`.hermetic`, `.map`, `.pairs`, or `.entries`).

const std = @import("std");
const builtin = @import("builtin");
const Allocator = std.mem.Allocator;
const Io = std.Io;
const build_info_mod = @import("build_info.zig");
const goquote = @import("goquote.zig");
const identity = @import("identity.zig");
const policy_runtime = @import("policy_runtime.zig");
const spec = @import("spec.zig");
const attribute = @import("pipeline/attribute.zig");
const pipeline_resource = @import("pipeline/resource.zig");

/// Fallback `service.version` when no version is resolvable.
pub const service_version_fallback = "0.0.0-unknown";

/// Explicit environment source. libo11y never reads ambient process env.
pub const Env = union(enum) {
    /// Ignores all environment variables (hermetic / test mode).
    hermetic,
    /// Zig 0.17's explicit `std.process.Environ.Map` handed to `main`.
    map: *const std.process.Environ.Map,
    /// Explicit key/value pairs.
    pairs: []const [2][]const u8,
    /// Explicit `"KEY=VALUE"` strings.
    entries: []const []const u8,

    pub fn isHermetic(e: Env) bool {
        return e == .hermetic;
    }

    pub fn get(e: Env, key: []const u8) ?[]const u8 {
        return switch (e) {
            .hermetic => null,
            .map => |m| m.get(key),
            .pairs => |ps| blk: {
                // Last pair wins if repeated.
                var i = ps.len;
                while (i > 0) {
                    i -= 1;
                    if (std.mem.eql(u8, ps[i][0], key)) break :blk ps[i][1];
                }
                break :blk null;
            },
            .entries => |es| blk: {
                var i = es.len;
                while (i > 0) {
                    i -= 1;
                    const entry = es[i];
                    if (std.mem.indexOfScalar(u8, entry, '=')) |eq| {
                        if (std.mem.eql(u8, entry[0..eq], key)) break :blk entry[eq + 1 ..];
                    }
                }
                break :blk null;
            },
        };
    }

    pub fn getOr(e: Env, key: []const u8, default: []const u8) []const u8 {
        if (e.get(key)) |v| {
            if (v.len > 0) return v;
        }
        return default;
    }
};

/// Diagnostic buffer receiving Go's human-readable error text when setup/init
/// returns an error. Stack-allocatable; needs no deinit.
pub const Diagnostic = struct {
    buf: [1024]u8 = undefined,
    len: usize = 0,

    pub fn message(d: *const Diagnostic) []const u8 {
        return d.buf[0..d.len];
    }

    pub fn set(d: *Diagnostic, msg: []const u8) void {
        const n = @min(msg.len, d.buf.len);
        @memcpy(d.buf[0..n], msg[0..n]);
        d.len = n;
    }

    pub fn print(d: *Diagnostic, comptime fmt: []const u8, args: anytype) void {
        var w: Io.Writer = .fixed(&d.buf);
        w.print(fmt, args) catch {};
        d.len = w.buffered().len;
    }
};

/// Resource identity validation errors.
pub const IdentityError = error{
    NoServiceName,
    NoEnvironment,
    InvalidEnvironment,
    OutOfMemory,
};

/// Options that shape resource composition.
pub const ResourceOptions = struct {
    env: Env = .hermetic,
    sdk_version: []const u8,
    service_name: ?[]const u8 = null,
    service_version: ?[]const u8 = null,
    service_namespace: ?[]const u8 = null,
    environment: ?[]const u8 = null,
    extra_environments: []const []const u8 = &.{},
    strict_identity: bool = true,
    resource_attributes: []const attribute.KeyValue = &.{},
    build_info: ?build_info_mod.BuildInfo = null,
    build_info_enabled: bool = true,
    diagnostic: ?*Diagnostic = null,
};

/// An owned telemetry resource backed by an arena.
pub const OwnedResource = struct {
    arena: std.heap.ArenaAllocator,
    resource: pipeline_resource.Resource,
    version_fallback: bool,

    pub fn deinit(r: *OwnedResource) void {
        r.arena.deinit();
    }
};

/// Violation rule names when `strict_identity = false`.
pub const rule_identity_service_name = "identity_service_name";
pub const rule_identity_environment = "identity_environment";
pub const rule_identity_environment_invalid = "identity_environment_invalid";

/// Composes the resource layers in Go's exact precedence order (lowest to
/// highest), enforces tier-0 identity, derives `service.instance.id`,
/// classifies once with `policy`, and stamps `spec.schema_url`.
pub fn build(
    gpa: Allocator,
    io: Io,
    options: ResourceOptions,
    policy: *const policy_runtime.Policy,
    violations: *policy_runtime.ViolationCounts,
) IdentityError!OwnedResource {
    var arena_state: std.heap.ArenaAllocator = .init(gpa);
    errdefer arena_state.deinit();
    const arena = arena_state.allocator();

    var raw: std.ArrayList(attribute.KeyValue) = .empty;

    // 1. Build info (lowest precedence).
    if (options.build_info_enabled) {
        const bi = options.build_info orelse build_info_mod.BuildInfo.fromRoot();
        try bi.appendAttributes(arena, &raw);
    }

    // 2. Telemetry SDK attributes.
    try raw.append(arena, attribute.kv("telemetry.sdk.name", "libo11y"));
    try raw.append(arena, attribute.kv("telemetry.sdk.language", "zig"));
    try raw.append(arena, attribute.kv("telemetry.sdk.version", options.sdk_version));

    // 3. Host detector (host.name).
    var host_buf: [std.posix.HOST_NAME_MAX]u8 = undefined;
    if (std.posix.gethostname(&host_buf)) |hostname| {
        if (hostname.len > 0) {
            try raw.append(arena, attribute.kv(spec.attr.host_name, try arena.dupe(u8, hostname)));
        }
    } else |_| {}

    // 4. Process runtime attributes.
    try raw.append(arena, attribute.kv(spec.attr.process_runtime_name, "zig"));
    try raw.append(arena, attribute.kv(spec.attr.process_runtime_version, builtin.zig_version_string));

    // 5. Container ID (best-effort on Linux).
    if (detectContainerId(io, arena)) |cid| {
        try raw.append(arena, attribute.kv(spec.attr.container_id, cid));
    }

    // 6. Environment layer (skipped under .hermetic).
    if (!options.env.isHermetic()) {
        if (options.env.get("OTEL_RESOURCE_ATTRIBUTES")) |env_attrs| {
            try parseResourceAttributes(arena, env_attrs, &raw);
        }
        if (options.env.get("OTEL_SERVICE_NAME")) |svc| {
            const trimmed = std.mem.trim(u8, svc, " \t\r\n");
            if (trimmed.len > 0) {
                try raw.append(arena, attribute.kv("service.name", try arena.dupe(u8, trimmed)));
            }
        }
    }

    // 7. Explicit options (highest precedence).
    var version_resolved = false;
    if (options.service_name) |s| {
        const t = std.mem.trim(u8, s, " \t\r\n");
        if (t.len > 0) try raw.append(arena, attribute.kv("service.name", try arena.dupe(u8, t)));
    }
    if (options.service_version) |s| {
        const t = std.mem.trim(u8, s, " \t\r\n");
        if (t.len > 0) {
            try raw.append(arena, attribute.kv("service.version", try arena.dupe(u8, t)));
            version_resolved = true;
        }
    }
    if (options.service_namespace) |s| {
        const t = std.mem.trim(u8, s, " \t\r\n");
        if (t.len > 0) try raw.append(arena, attribute.kv("service.namespace", try arena.dupe(u8, t)));
    }
    if (options.environment) |s| {
        const t = std.mem.trim(u8, s, " \t\r\n");
        if (t.len > 0) try raw.append(arena, attribute.kv(spec.Environment.key, try arena.dupe(u8, t)));
    }
    for (options.resource_attributes) |kv| {
        try raw.append(arena, try kv.dupe(arena, null));
    }

    // Deduplicate: last value wins, keeping first-insertion position.
    var merged: std.ArrayList(attribute.KeyValue) = try .initCapacity(arena, raw.items.len + 2);
    for (raw.items) |kv| {
        if (kv.key.len == 0) continue;
        if (findIndex(merged.items, kv.key)) |idx| {
            merged.items[idx].value = kv.value;
        } else {
            merged.appendAssumeCapacity(kv);
        }
    }

    // Enforce tier-0 identity.
    try enforceIdentity(gpa, merged.items, options, violations);

    // Ensure service.version.
    var version_fallback = false;
    if (!version_resolved and findString(merged.items, "service.version").len == 0) {
        try setOrAppend(arena, &merged, attribute.kv("service.version", service_version_fallback));
        version_fallback = true;
    }

    // Ensure service.instance.id.
    if (findString(merged.items, "service.instance.id").len == 0) {
        const pod_uid = findString(merged.items, spec.attr.k8s_pod_uid);
        const pod_name = findString(merged.items, spec.attr.k8s_pod_name);
        const k8s_ns = findString(merged.items, spec.attr.k8s_namespace_name);
        var id_buf: [identity.uuid_text_len]u8 = undefined;
        const derived = identity.instanceId(&id_buf, pod_uid, pod_name, k8s_ns) orelse blk: {
            var seed: u64 = 0;
            io.random(std.mem.asBytes(&seed));
            var prng: std.Random.DefaultPrng = .init(seed);
            break :blk identity.randomV4(&id_buf, prng.random());
        };
        try setOrAppend(arena, &merged, attribute.kv("service.instance.id", try arena.dupe(u8, derived)));
    }

    // Classify resource attributes once with sensitivity policy.
    const classified = try policy.classifyResourceAttrs(arena, gpa, merged.items, violations);

    return .{
        .arena = arena_state,
        .resource = .{
            .attributes = classified,
            .schema_url = spec.schema_url,
        },
        .version_fallback = version_fallback,
    };
}

fn enforceIdentity(
    gpa: Allocator,
    attrs: []const attribute.KeyValue,
    options: ResourceOptions,
    violations: *policy_runtime.ViolationCounts,
) IdentityError!void {
    const svc = std.mem.trim(u8, findString(attrs, "service.name"), " \t\r\n");
    const has_svc = svc.len > 0 and !std.mem.eql(u8, svc, "unknown_service") and !std.mem.startsWith(u8, svc, "unknown_service:");
    if (!has_svc) {
        if (options.strict_identity) {
            if (options.diagnostic) |d| d.set("o11y: service name required: set service_name or OTEL_SERVICE_NAME");
            return error.NoServiceName;
        }
        try violations.inc(gpa, rule_identity_service_name);
    }

    const env_val = findString(attrs, spec.Environment.key);
    if (env_val.len == 0) {
        if (options.strict_identity) {
            if (options.diagnostic) |d| d.set("o11y: deployment environment required: set environment or deployment.environment.name");
            return error.NoEnvironment;
        }
        try violations.inc(gpa, rule_identity_environment);
    } else if (!environmentAllowed(env_val, options.extra_environments)) {
        if (options.strict_identity) {
            if (options.diagnostic) |d| formatInvalidEnvDiag(gpa, d, env_val, options.extra_environments);
            return error.InvalidEnvironment;
        }
        try violations.inc(gpa, rule_identity_environment_invalid);
    }
}

fn environmentAllowed(value: []const u8, extra: []const []const u8) bool {
    for (spec.environment_values) |v| {
        if (std.mem.eql(u8, v, value)) return true;
    }
    for (extra) |v| {
        const trimmed = std.mem.trim(u8, v, " \t\r\n");
        if (trimmed.len > 0 and std.mem.eql(u8, trimmed, value)) return true;
    }
    return false;
}

fn formatInvalidEnvDiag(gpa: Allocator, d: *Diagnostic, env_val: []const u8, extra: []const []const u8) void {
    var list: std.ArrayList([]const u8) = .empty;
    defer list.deinit(gpa);
    for (spec.environment_values) |v| list.append(gpa, v) catch {};
    for (extra) |v| {
        const t = std.mem.trim(u8, v, " \t\r\n");
        if (t.len == 0) continue;
        const dup = for (list.items) |e| {
            if (std.mem.eql(u8, e, t)) break true;
        } else false;
        if (!dup) list.append(gpa, t) catch {};
    }
    std.mem.sort([]const u8, list.items, {}, struct {
        fn less(_: void, a: []const u8, b: []const u8) bool {
            return std.mem.lessThan(u8, a, b);
        }
    }.less);

    var w: Io.Writer = .fixed(&d.buf);
    w.writeAll("o11y: deployment environment not in the allowed set: ") catch {};
    goquote.writeQuoted(&w, env_val) catch {};
    w.writeAll(" (allowed: ") catch {};
    for (list.items, 0..) |item, i| {
        if (i > 0) w.writeAll(", ") catch {};
        w.writeAll(item) catch {};
    }
    w.writeAll(")") catch {};
    d.len = w.buffered().len;
}

/// Parses `OTEL_RESOURCE_ATTRIBUTES` (`k1=v1,k2=v2`, percent-decoding values).
pub fn parseResourceAttributes(arena: Allocator, raw: []const u8, out: *std.ArrayList(attribute.KeyValue)) Allocator.Error!void {
    var it = std.mem.splitScalar(u8, raw, ',');
    while (it.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        const key = std.mem.trim(u8, pair[0..eq], " \t\r\n");
        if (key.len == 0) continue;
        const val_raw = std.mem.trim(u8, pair[eq + 1 ..], " \t\r\n");
        const val = try percentDecode(arena, val_raw);
        try out.append(arena, attribute.kv(try arena.dupe(u8, key), val));
    }
}

fn percentDecode(arena: Allocator, text: []const u8) Allocator.Error![]const u8 {
    if (std.mem.indexOfScalar(u8, text, '%') == null) return arena.dupe(u8, text);
    var out = try arena.alloc(u8, text.len);
    var n: usize = 0;
    var i: usize = 0;
    while (i < text.len) : (i += 1) {
        if (text[i] == '%' and i + 2 < text.len) {
            const hi = std.fmt.charToDigit(text[i + 1], 16) catch null;
            const lo = std.fmt.charToDigit(text[i + 2], 16) catch null;
            if (hi != null and lo != null) {
                out[n] = hi.? * 16 + lo.?;
                n += 1;
                i += 2;
                continue;
            }
        }
        out[n] = text[i];
        n += 1;
    }
    return out[0..n];
}

/// Best-effort container ID detection on Linux from `/proc/self/mountinfo` and
/// `/proc/self/cgroup`, matching OpenTelemetry's container detector.
fn detectContainerId(io: Io, arena: Allocator) ?[]const u8 {
    if (builtin.os.tag != .linux) return null;
    if (readContainerIdFromFile(io, arena, "/proc/self/mountinfo")) |id| return id;
    if (readContainerIdFromFile(io, arena, "/proc/self/cgroup")) |id| return id;
    return null;
}

fn readContainerIdFromFile(io: Io, arena: Allocator, path: []const u8) ?[]const u8 {
    const content = Io.Dir.cwd().readFileAlloc(io, path, arena, .limited(64 * 1024)) catch return null;
    return extractContainerId(content);
}

/// Scans lines from `/proc/self/mountinfo` or `/proc/self/cgroup` for a
/// 64-character lowercase hex container ID segment.
pub fn extractContainerId(content: []const u8) ?[]const u8 {
    var lines = std.mem.splitScalar(u8, content, '\n');
    while (lines.next()) |line| {
        var tokens = std.mem.tokenizeAny(u8, line, "/ -:.\t\r");
        while (tokens.next()) |tok| {
            var candidate = tok;
            if (std.mem.endsWith(u8, candidate, ".scope")) {
                candidate = candidate[0 .. candidate.len - ".scope".len];
            }
            if (candidate.len == 64 and isLowerHex(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}

fn isLowerHex(s: []const u8) bool {
    for (s) |c| {
        if (!((c >= '0' and c <= '9') or (c >= 'a' and c <= 'f'))) return false;
    }
    return true;
}

fn findIndex(attrs: []const attribute.KeyValue, key: []const u8) ?usize {
    for (attrs, 0..) |kv, i| {
        if (std.mem.eql(u8, kv.key, key)) return i;
    }
    return null;
}

fn findString(attrs: []const attribute.KeyValue, key: []const u8) []const u8 {
    const val = attribute.find(attrs, key) orelse return "";
    return switch (val) {
        .string => |s| s,
        else => "",
    };
}

fn setOrAppend(arena: Allocator, list: *std.ArrayList(attribute.KeyValue), kv: attribute.KeyValue) Allocator.Error!void {
    if (findIndex(list.items, kv.key)) |idx| {
        list.items[idx].value = kv.value;
    } else {
        try list.append(arena, kv);
    }
}

const testing = std.testing;

test "strict identity enforces service.name and allowed deployment.environment.name" {
    var policy = try policy_runtime.Policy.init(testing.allocator, .drop, "", .empty, null);
    defer policy.deinit();
    var counts: policy_runtime.ViolationCounts = .{};
    defer counts.deinit(testing.allocator);

    var diag: Diagnostic = .{};
    try testing.expectError(error.NoServiceName, build(testing.allocator, testing.io, .{
        .sdk_version = "0.1.0",
        .environment = "production",
        .diagnostic = &diag,
    }, &policy, &counts));
    try testing.expect(std.mem.indexOf(u8, diag.message(), "service name required") != null);

    // unknown_service prefix rejected too.
    try testing.expectError(error.NoServiceName, build(testing.allocator, testing.io, .{
        .sdk_version = "0.1.0",
        .service_name = "unknown_service:mybin",
        .environment = "production",
    }, &policy, &counts));

    // Missing environment rejected.
    try testing.expectError(error.NoEnvironment, build(testing.allocator, testing.io, .{
        .sdk_version = "0.1.0",
        .service_name = "checkout",
        .diagnostic = &diag,
    }, &policy, &counts));
    try testing.expect(std.mem.indexOf(u8, diag.message(), "deployment environment required") != null);

    // Invalid environment rejected with sorted allowed list.
    try testing.expectError(error.InvalidEnvironment, build(testing.allocator, testing.io, .{
        .sdk_version = "0.1.0",
        .service_name = "checkout",
        .environment = "canary",
        .diagnostic = &diag,
    }, &policy, &counts));
    try testing.expect(std.mem.indexOf(u8, diag.message(), "\"canary\"") != null);
    try testing.expect(std.mem.indexOf(u8, diag.message(), "development, production, staging, test") != null);

    // Extra environment extends allowed set.
    var res = try build(testing.allocator, testing.io, .{
        .sdk_version = "0.1.0",
        .service_name = "checkout",
        .environment = "canary",
        .extra_environments = &.{"canary"},
    }, &policy, &counts);
    defer res.deinit();
    try testing.expectEqualStrings(spec.schema_url, res.resource.schema_url);
    try testing.expect(res.version_fallback);
    try testing.expectEqualStrings(service_version_fallback, attribute.find(res.resource.attributes, "service.version").?.string);
}

test "resource precedence: explicit > env > detectors, and hermetic ignores env" {
    var policy = try policy_runtime.Policy.init(testing.allocator, .drop, "", .empty, null);
    defer policy.deinit();
    var counts: policy_runtime.ViolationCounts = .{};
    defer counts.deinit(testing.allocator);

    const env: Env = .{ .pairs = &.{
        .{ "OTEL_SERVICE_NAME", "env-svc" },
        .{ "OTEL_RESOURCE_ATTRIBUTES", "deployment.environment.name=staging,k8s.pod.uid=0f0c5e8e-3b8a-4c1e-9d3a-2f6b7a1c9e42,host.ip=10.0.0.1,http.request.header.authorization=secret" },
    } };

    // Env resolves identity, derives UUIDv5 instance id, and policy drops PII+secret from resource!
    var res = try build(testing.allocator, testing.io, .{
        .env = env,
        .sdk_version = "0.1.0",
        .service_name = "code-svc",
        .build_info = .{ .version = "1.2.3", .revision = "deadbeef" },
    }, &policy, &counts);
    defer res.deinit();

    try testing.expectEqualStrings("code-svc", attribute.find(res.resource.attributes, "service.name").?.string);
    try testing.expectEqualStrings("staging", attribute.find(res.resource.attributes, spec.Environment.key).?.string);
    try testing.expectEqualStrings("1.2.3", attribute.find(res.resource.attributes, "service.version").?.string);
    try testing.expectEqualStrings("deadbeef", attribute.find(res.resource.attributes, spec.attr.vcs_ref_head_revision).?.string);
    try testing.expect(!res.version_fallback);
    try testing.expectEqualStrings(
        "fceeac15-05b1-5132-b02a-910f70fb6aac",
        attribute.find(res.resource.attributes, "service.instance.id").?.string,
    );
    // Sensitivity policy stripped PII & secret from resource and counted them.
    try testing.expectEqual(null, attribute.find(res.resource.attributes, "host.ip"));
    try testing.expectEqual(null, attribute.find(res.resource.attributes, "http.request.header.authorization"));
    try testing.expectEqual(@as(i64, 1), counts.get("pii_attribute"));
    try testing.expectEqual(@as(i64, 1), counts.get("secret_attribute"));

    // Non-strict identity counts identity violations instead of failing.
    var non_strict_counts: policy_runtime.ViolationCounts = .{};
    defer non_strict_counts.deinit(testing.allocator);
    var res2 = try build(testing.allocator, testing.io, .{
        .env = .hermetic,
        .sdk_version = "0.1.0",
        .strict_identity = false,
    }, &policy, &non_strict_counts);
    defer res2.deinit();
    try testing.expectEqual(@as(i64, 1), non_strict_counts.get(rule_identity_service_name));
    try testing.expectEqual(@as(i64, 1), non_strict_counts.get(rule_identity_environment));
}

test "extractContainerId parses cgroup and mountinfo lines" {
    const cid = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    try testing.expectEqualStrings(cid, extractContainerId("0::/system.slice/docker-" ++ cid ++ ".scope\n").?);
    try testing.expectEqualStrings(cid, extractContainerId("123 45 0:1 /docker/containers/" ++ cid ++ "/hostname /etc/hostname rw\n").?);
    try testing.expectEqual(null, extractContainerId("0::/user.slice/user-1000.slice\n"));
}
