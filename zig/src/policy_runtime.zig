//! Runtime sensitivity policy enforcement across traces, metrics, logs, and
//! resource attributes.
//!
//! One `Policy` instance per `Telemetry` SDK enforces `o11y.spec` sensitivity
//! tables plus any loaded application registries:
//! - Secret attributes are ALWAYS dropped on every signal and in every mode.
//! - PII attributes are dropped by default (`.drop`), replaced with a keyed
//!   HMAC-SHA256 token via `pii.zig` in `.hash` mode, or kept in `.allow` mode.
//! - Metrics ALWAYS drop PII even in `.hash` mode (preventing cardinality
//!   explosion) and never increment `o11y.schema.violations`.
//! - Nested log values (maps and arrays) are walked recursively under dotted
//!   effective keys, failing closed past depth 16, on a cycle, or past a
//!   2048-node budget.

const std = @import("std");
const Allocator = std.mem.Allocator;
const Context = @import("context.zig").Context;
const pii = @import("pii.zig");
const spec = @import("spec.zig");
const attribute = @import("pipeline/attribute.zig");
const log_record = @import("pipeline/log_record.zig");
const metric_meter = @import("pipeline/metric/meter.zig");
const metric_reader = @import("pipeline/metric/reader.zig");
const pipeline_policy = @import("pipeline/policy.zig");

/// The instrumentation scope name for libo11y's own self-metrics.
pub const scope_name = "github.com/jamesainslie/libo11y/zig";

/// Maximum nesting depth for composite log attribute walks (matches Go).
pub const max_composite_depth: usize = 16;

/// Maximum node budget for one composite log attribute walk (matches Go).
pub const composite_walk_budget: usize = 2048;

/// Selects how attributes classified as PII are handled.
pub const PIIMode = enum {
    /// Remove PII attributes entirely. Default.
    drop,
    /// Replace PII values with a keyed `hmac-sha256:...` token. Requires a
    /// `pii_hash_key` of at least 32 bytes.
    hash,
    /// Emit PII attributes unchanged. Explicit opt-in only.
    allow,
};

/// Decision the policy takes on a single attribute key.
pub const Action = enum {
    keep,
    rewrite,
    drop,
};

/// Optional test-only override for sensitivity class lookups.
pub const LookupFn = *const fn (key: []const u8) ?spec.Sensitivity;

/// Counts specification violations on `o11y.schema.violations`.
pub const ViolationRecorder = struct {
    counter: metric_meter.Counter(i64) = .noop,

    pub fn init(mp: *metric_meter.MeterProvider) ViolationRecorder {
        const m = mp.meter(.{ .name = scope_name });
        return .{
            .counter = m.counter(i64, spec.metric.schema_violations, .{
                .unit = "{violation}",
                .description = "Telemetry records that violated the libo11y specification.",
            }),
        };
    }

    pub fn record(self: *const ViolationRecorder, signal: spec.Signal, rule: []const u8) void {
        self.add(signal, rule, 1);
    }

    pub fn add(self: *const ViolationRecorder, signal: spec.Signal, rule: []const u8, n: i64) void {
        if (n <= 0) return;
        const attrs = [_]attribute.KeyValue{
            attribute.kv(spec.Signal.key, signal.asStr()),
            attribute.kv(spec.attr.rule, rule),
        };
        self.counter.add(.background, n, &attrs);
    }
};

/// Per-rule violation counts accumulated before the violation counter exists
/// (for example during resource construction).
pub const ViolationCounts = struct {
    entries: std.StringHashMapUnmanaged(i64) = .empty,

    pub fn deinit(c: *ViolationCounts, gpa: Allocator) void {
        c.entries.deinit(gpa);
    }

    pub fn inc(c: *ViolationCounts, gpa: Allocator, rule: []const u8) Allocator.Error!void {
        const gop = try c.entries.getOrPut(gpa, rule);
        if (!gop.found_existing) {
            gop.value_ptr.* = 1;
        } else {
            gop.value_ptr.* += 1;
        }
    }

    pub fn get(c: *const ViolationCounts, rule: []const u8) i64 {
        return c.entries.get(rule) orelse 0;
    }

    pub fn recordAll(c: *const ViolationCounts, rec: *const ViolationRecorder, signal: spec.Signal) void {
        var it = c.entries.iterator();
        while (it.next()) |e| {
            rec.add(signal, e.key_ptr.*, e.value_ptr.*);
        }
    }
};

/// Single key-based sensitivity policy shared by every signal of one SDK.
pub const Policy = struct {
    gpa: Allocator,
    pii_mode: PIIMode,
    pii_hash_key: []u8,
    /// Application registry classifications (owned keys). Consulted only for
    /// keys that `spec.sensitivityOf` leaves unclassified.
    app_classes: std.StringHashMapUnmanaged(spec.Sensitivity),
    lookup_override: ?LookupFn = null,
    /// Attached once the `MeterProvider` exists.
    recorder: ?ViolationRecorder = null,

    pub fn init(
        gpa: Allocator,
        pii_mode: PIIMode,
        pii_hash_key: []const u8,
        app_classes: std.StringHashMapUnmanaged(spec.Sensitivity),
        lookup_override: ?LookupFn,
    ) Allocator.Error!Policy {
        const key_copy: []u8 = if (pii_hash_key.len > 0) try gpa.dupe(u8, pii_hash_key) else &.{};
        return .{
            .gpa = gpa,
            .pii_mode = pii_mode,
            .pii_hash_key = key_copy,
            .app_classes = app_classes,
            .lookup_override = lookup_override,
        };
    }

    pub fn deinit(self: *Policy) void {
        if (self.pii_hash_key.len > 0) {
            std.crypto.secureZero(u8, self.pii_hash_key);
            self.gpa.free(self.pii_hash_key);
        }
        var it = self.app_classes.keyIterator();
        while (it.next()) |k| self.gpa.free(k.*);
        self.app_classes.deinit(self.gpa);
    }

    /// Attaches the self-metric violation recorder once the meter provider is
    /// constructed.
    pub fn attachRecorder(self: *Policy, mp: *metric_meter.MeterProvider) void {
        self.recorder = ViolationRecorder.init(mp);
    }

    /// Looks up the sensitivity class of `key`: spec wins over app registries.
    pub fn lookup(self: *const Policy, key: []const u8) ?spec.Sensitivity {
        if (self.lookup_override) |f| {
            if (f(key)) |c| return c;
        } else {
            if (spec.sensitivityOf(key)) |c| return c;
        }
        return self.app_classes.get(key);
    }

    /// Maps a sensitivity class to the action this policy takes.
    pub fn actionFor(self: *const Policy, class: ?spec.Sensitivity) Action {
        const c = class orelse return .keep;
        return switch (c) {
            .secret => .drop,
            .pii => switch (self.pii_mode) {
                .drop => .drop,
                .hash => .rewrite,
                .allow => .keep,
            },
            .public, .internal => .keep,
        };
    }

    /// Returns the violation rule name for a dropped or rewritten class.
    pub fn ruleFor(class: ?spec.Sensitivity) []const u8 {
        if (class) |c| {
            if (c == .secret) return "secret_attribute";
        }
        return "pii_attribute";
    }

    /// Classifies `key` and records a violation when dropped or rewritten.
    pub fn decide(self: *const Policy, signal: spec.Signal, key: []const u8) Action {
        const class = self.lookup(key);
        const act = self.actionFor(class);
        if (act != .keep) {
            if (self.recorder) |*rec| rec.record(signal, ruleFor(class));
        }
        return act;
    }

    /// Reports whether a metric attribute may be kept. Drops secrets always
    /// and drops PII unless `pii_mode == .allow` (never hashes on metrics,
    /// never counts violations).
    pub fn metricKeep(self: *const Policy, key: []const u8) bool {
        const c = self.lookup(key) orelse return true;
        return switch (c) {
            .secret => false,
            .pii => self.pii_mode == .allow,
            .public, .internal => true,
        };
    }

    /// Returns the pipeline `AttributePolicy` vtable for spans, metrics, and
    /// OTLP log records.
    pub fn attributePolicy(self: *const Policy) pipeline_policy.AttributePolicy {
        return .{
            .ptr = @constCast(self),
            .vtable = &.{
                .apply = applyErased,
                .applyLog = applyLogErased,
            },
        };
    }

    /// Classifies resource attributes once at construction, returning the
    /// surviving attributes (allocated in `arena`) and violation counts per rule.
    pub fn classifyResourceAttrs(
        self: *const Policy,
        arena: Allocator,
        gpa: Allocator,
        attrs: []const attribute.KeyValue,
        counts: *ViolationCounts,
    ) Allocator.Error![]attribute.KeyValue {
        var kept: std.ArrayList(attribute.KeyValue) = try .initCapacity(arena, attrs.len);
        for (attrs) |kv| {
            const class = self.lookup(kv.key);
            switch (self.actionFor(class)) {
                .drop => try counts.inc(gpa, ruleFor(class)),
                .rewrite => {
                    try counts.inc(gpa, ruleFor(class));
                    if (self.tokenizeAttrValue(arena, kv.value)) |tok| {
                        kept.appendAssumeCapacity(.{ .key = kv.key, .value = .{ .string = tok } });
                    }
                    // On OOM while hashing, fail closed by dropping the attribute.
                },
                .keep => kept.appendAssumeCapacity(kv),
            }
        }
        return kept.items;
    }

    /// Classifies a slice of log attributes in `arena`, recursively walking
    /// nested maps and arrays with dotted effective keys. Fails closed on
    /// depth > 16, cycles, or node budget exhaustion (2048 nodes).
    pub fn classifyLogAttrs(self: *const Policy, attrs: []const log_record.KeyValue, arena: Allocator) []log_record.KeyValue {
        var out = std.ArrayList(log_record.KeyValue).initCapacity(arena, attrs.len) catch return &.{};
        for (attrs) |kv| {
            var walk: LogWalk = .{ .policy = self, .arena = arena };
            if (walk.classifyPair("", kv, 0)) |kept| {
                out.appendAssumeCapacity(kept);
            }
        }
        return out.items;
    }

    /// Computes the keyed HMAC token of an `attribute.Value`, allocating the
    /// token string in `arena`. Returns null on allocation failure (fail closed).
    pub fn tokenizeAttrValue(self: *const Policy, arena: Allocator, value: attribute.Value) ?[]const u8 {
        var scratch_state: std.heap.ArenaAllocator = .init(self.gpa);
        defer scratch_state.deinit();
        const scratch = scratch_state.allocator();

        const pii_val = attrToPiiValue(scratch, value) catch return null;
        const canon = pii.canonical(scratch, pii_val) catch return null;
        var tok_buf: [pii.token_len]u8 = undefined;
        const tok = pii.token(&tok_buf, self.pii_hash_key, canon);
        return arena.dupe(u8, tok) catch null;
    }

    /// Computes the keyed HMAC token of a `log_record.Value`, allocating the
    /// token string in `arena`. Returns null on allocation failure (fail closed).
    pub fn tokenizeLogValue(self: *const Policy, arena: Allocator, value: log_record.Value) ?[]const u8 {
        var scratch_state: std.heap.ArenaAllocator = .init(self.gpa);
        defer scratch_state.deinit();
        const scratch = scratch_state.allocator();

        const pii_val = logToPiiValue(scratch, value, 0) catch return null;
        const canon = pii.canonical(scratch, pii_val) catch return null;
        var tok_buf: [pii.token_len]u8 = undefined;
        const tok = pii.token(&tok_buf, self.pii_hash_key, canon);
        return arena.dupe(u8, tok) catch null;
    }

    fn applyErased(ptr: ?*anyopaque, target: pipeline_policy.Target, attrs: []attribute.KeyValue, arena: Allocator) []attribute.KeyValue {
        const p = ptr orelse return attrs;
        const self: *const Policy = @ptrCast(@alignCast(p));
        if (target == .metric) {
            var write_idx: usize = 0;
            for (attrs) |kv| {
                if (self.metricKeep(kv.key)) {
                    attrs[write_idx] = kv;
                    write_idx += 1;
                }
            }
            return attrs[0..write_idx];
        }
        // Span, event, or link attributes.
        var write_idx: usize = 0;
        for (attrs) |kv| {
            switch (self.decide(.traces, kv.key)) {
                .drop => {},
                .rewrite => {
                    if (self.tokenizeAttrValue(arena, kv.value)) |tok| {
                        attrs[write_idx] = .{ .key = kv.key, .value = .{ .string = tok } };
                        write_idx += 1;
                    }
                },
                .keep => {
                    attrs[write_idx] = kv;
                    write_idx += 1;
                },
            }
        }
        return attrs[0..write_idx];
    }

    fn applyLogErased(ptr: ?*anyopaque, attrs: []log_record.KeyValue, arena: Allocator) []log_record.KeyValue {
        const p = ptr orelse return attrs;
        const self: *const Policy = @ptrCast(@alignCast(p));
        return self.classifyLogAttrs(attrs, arena);
    }
};

const Ancestor = struct {
    is_map: bool,
    addr: usize,
};

const LogWalk = struct {
    policy: *const Policy,
    arena: Allocator,
    budget: usize = composite_walk_budget,
    ancestors: [max_composite_depth]Ancestor = undefined,
    ancestor_len: usize = 0,

    fn spend(w: *LogWalk) bool {
        if (w.budget == 0) return false;
        w.budget -= 1;
        return true;
    }

    fn enter(w: *LogWalk, is_map: bool, addr: usize) bool {
        for (w.ancestors[0..w.ancestor_len]) |a| {
            if (a.is_map == is_map and a.addr == addr) return false;
        }
        if (w.ancestor_len >= w.ancestors.len) return false;
        w.ancestors[w.ancestor_len] = .{ .is_map = is_map, .addr = addr };
        w.ancestor_len += 1;
        return true;
    }

    fn leave(w: *LogWalk) void {
        w.ancestor_len -= 1;
    }

    fn classifyPair(w: *LogWalk, prefix: []const u8, kv: log_record.KeyValue, depth: usize) ?log_record.KeyValue {
        const eff_key = if (prefix.len == 0)
            kv.key
        else
            std.fmt.allocPrint(w.arena, "{s}.{s}", .{ prefix, kv.key }) catch return null;

        switch (w.policy.decide(.logs, eff_key)) {
            .drop => return null,
            .rewrite => {
                const tok = w.policy.tokenizeLogValue(w.arena, kv.value) orelse return null;
                return .{ .key = kv.key, .value = .{ .string = tok } };
            },
            .keep => {},
        }

        const classified_val = w.classifyValue(eff_key, kv.value, depth) orelse return null;
        return .{ .key = kv.key, .value = classified_val };
    }

    fn classifyValue(w: *LogWalk, prefix: []const u8, v: log_record.Value, depth: usize) ?log_record.Value {
        switch (v) {
            .map => |pairs| {
                if (depth >= max_composite_depth or !w.spend()) return null;
                if (pairs.len == 0) return .{ .map = &.{} };
                const addr = @intFromPtr(pairs.ptr);
                if (!w.enter(true, addr)) return null;
                defer w.leave();

                var kept = std.ArrayList(log_record.KeyValue).initCapacity(w.arena, pairs.len) catch return null;
                for (pairs) |member| {
                    if (!w.spend()) break;
                    if (w.classifyPair(prefix, member, depth + 1)) |m_kept| {
                        kept.appendAssumeCapacity(m_kept);
                    }
                }
                if (kept.items.len == 0) return null;
                return .{ .map = kept.items };
            },
            .array => |items| {
                if (depth >= max_composite_depth or !w.spend()) return null;
                if (items.len == 0) return .{ .array = &.{} };
                const addr = @intFromPtr(items.ptr);
                if (!w.enter(false, addr)) return null;
                defer w.leave();

                var kept = std.ArrayList(log_record.Value).initCapacity(w.arena, items.len) catch return null;
                for (items) |elem| {
                    const is_comp = elem == .map or elem == .array;
                    if (is_comp and !w.spend()) {
                        break;
                    }
                    if (w.classifyValue(prefix, elem, depth + 1)) |e_kept| {
                        kept.appendAssumeCapacity(e_kept);
                    }
                }
                if (kept.items.len == 0) return null;
                return .{ .array = kept.items };
            },
            else => return v,
        }
    }
};

fn attrToPiiValue(arena: Allocator, v: attribute.Value) Allocator.Error!pii.Value {
    return switch (v) {
        .string => |s| .{ .string = s },
        .bool => |b| .{ .bool = b },
        .int => |i| .{ .int = i },
        .double => |d| .{ .float = d },
        .string_array => |items| blk: {
            const out = try arena.alloc(pii.Value, items.len);
            for (out, items) |*dst, s| dst.* = .{ .string = s };
            break :blk .{ .array = out };
        },
        .bool_array => |items| blk: {
            const out = try arena.alloc(pii.Value, items.len);
            for (out, items) |*dst, b| dst.* = .{ .bool = b };
            break :blk .{ .array = out };
        },
        .int_array => |items| blk: {
            const out = try arena.alloc(pii.Value, items.len);
            for (out, items) |*dst, i| dst.* = .{ .int = i };
            break :blk .{ .array = out };
        },
        .double_array => |items| blk: {
            const out = try arena.alloc(pii.Value, items.len);
            for (out, items) |*dst, d| dst.* = .{ .float = d };
            break :blk .{ .array = out };
        },
    };
}

fn logToPiiValue(arena: Allocator, v: log_record.Value, depth: usize) Allocator.Error!pii.Value {
    if (depth > pii.max_depth + 1) return .{ .string = pii.truncated };
    return switch (v) {
        .empty => .{ .string = "" },
        .string => |s| .{ .string = s },
        .bool => |b| .{ .bool = b },
        .int => |i| .{ .int = i },
        .double => |d| .{ .float = d },
        .bytes => |b| .{ .bytes = b },
        .array => |items| blk: {
            const out = try arena.alloc(pii.Value, items.len);
            for (out, items) |*dst, item| dst.* = try logToPiiValue(arena, item, depth + 1);
            break :blk .{ .array = out };
        },
        .map => |pairs| blk: {
            const out = try arena.alloc(pii.Member, pairs.len);
            for (out, pairs) |*dst, p| dst.* = .{ .key = p.key, .value = try logToPiiValue(arena, p.value, depth + 1) };
            break :blk .{ .map = out };
        },
    };
}

const testing = std.testing;

const test_key: [32]u8 = blk: {
    var k: [32]u8 = undefined;
    for (&k, 0..) |*b, i| b.* = @intCast(i);
    break :blk k;
};

test "Policy drops secrets always, handles PII per mode, and drops PII on metrics even in hash mode" {
    var app_classes: std.StringHashMapUnmanaged(spec.Sensitivity) = .empty;
    try app_classes.put(testing.allocator, try testing.allocator.dupe(u8, "shop.email"), .pii);
    try app_classes.put(testing.allocator, try testing.allocator.dupe(u8, "shop.token"), .secret);

    var policy = try Policy.init(testing.allocator, .hash, &test_key, app_classes, null);
    defer policy.deinit();

    // Wire a manual metric reader to verify o11y.schema.violations increments.
    var reader = metric_reader.ManualReader.init(testing.io, .{});
    const mp = try metric_meter.MeterProvider.create(testing.allocator, testing.io, .{
        .readers = &.{reader.reader()},
        .policy = policy.attributePolicy(),
    });
    defer mp.destroy();
    policy.attachRecorder(mp);

    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    // Span attributes: secret dropped, PII hashed, public kept.
    var span_attrs = [_]attribute.KeyValue{
        attribute.kv("http.request.header.authorization", "Bearer xyz"),
        attribute.kv("shop.token", "tok"),
        attribute.kv("shop.email", "alice@example.com"),
        attribute.kv("host.ip", "10.0.0.1"),
        attribute.kv("service.name", "checkout"),
    };
    const kept_span = policy.attributePolicy().apply(.span, &span_attrs, arena);
    try testing.expectEqual(@as(usize, 3), kept_span.len);
    try testing.expectEqualStrings("hmac-sha256:a59fc578d4cb46faab1d6eb348e7c74b", attribute.find(kept_span, "shop.email").?.string);
    try testing.expect(std.mem.startsWith(u8, attribute.find(kept_span, "host.ip").?.string, "hmac-sha256:"));
    try testing.expectEqualStrings("checkout", attribute.find(kept_span, "service.name").?.string);

    // Metric attributes: BOTH secret AND PII dropped even in hash mode!
    var metric_attrs = [_]attribute.KeyValue{
        attribute.kv("http.request.header.authorization", "Bearer xyz"),
        attribute.kv("host.ip", "10.0.0.1"),
        attribute.kv("shop.email", "alice@example.com"),
        attribute.kv("service.name", "checkout"),
    };
    const kept_metric = policy.attributePolicy().apply(.metric, &metric_attrs, arena);
    try testing.expectEqual(@as(usize, 1), kept_metric.len);
    try testing.expectEqualStrings("service.name", kept_metric[0].key);
    try testing.expectEqualStrings("checkout", kept_metric[0].value.string);

    // Check o11y.schema.violations: 2 secret + 2 pii on traces, 0 on metrics.
    var rm = try reader.collect(testing.allocator);
    defer rm.deinit();
    var secret_count: i64 = 0;
    var pii_count: i64 = 0;
    for (rm.scope_metrics) |sm| {
        for (sm.metrics) |m| {
            if (std.mem.eql(u8, m.name, spec.metric.schema_violations)) {
                for (m.data.sum.data_points) |pt| {
                    const rule = attribute.find(pt.attributes, spec.attr.rule).?.string;
                    const sig = attribute.find(pt.attributes, spec.Signal.key).?.string;
                    try testing.expectEqualStrings("traces", sig);
                    if (std.mem.eql(u8, rule, "secret_attribute")) secret_count += pt.value.int;
                    if (std.mem.eql(u8, rule, "pii_attribute")) pii_count += pt.value.int;
                }
            }
        }
    }
    try testing.expectEqual(@as(i64, 2), secret_count);
    try testing.expectEqual(@as(i64, 2), pii_count);
}

test "Policy log walk enforces dotted keys, depth 16, cycles, and 2048-node budget" {
    var policy = try Policy.init(testing.allocator, .drop, "", .empty, null);
    defer policy.deinit();

    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();

    // Dotted key inside nested map: host.ip is PII -> dropped, host.name is public -> kept.
    const host_map = [_]log_record.KeyValue{
        log_record.kv("ip", "1.2.3.4"),
        log_record.kv("name", "web-01"),
    };
    const attrs = [_]log_record.KeyValue{
        .{ .key = "host", .value = .{ .map = &host_map } },
    };
    const kept = policy.classifyLogAttrs(&attrs, arena);
    try testing.expectEqual(@as(usize, 1), kept.len);
    try testing.expectEqual(@as(usize, 1), kept[0].value.map.len);
    try testing.expectEqualStrings("name", kept[0].value.map[0].key);

    // Cycle fails closed (dropped).
    var cyclic: [1]log_record.KeyValue = undefined;
    cyclic[0] = .{ .key = "self", .value = .{ .map = &cyclic } };
    const cyclic_kept = policy.classifyLogAttrs(&.{.{ .key = "root", .value = .{ .map = &cyclic } }}, arena);
    try testing.expectEqual(@as(usize, 0), cyclic_kept.len);

    // Depth > 16 fails closed: build 18 nested maps.
    var deep_pairs: [18][1]log_record.KeyValue = undefined;
    deep_pairs[0][0] = log_record.kv("leaf", "ok");
    for (1..18) |i| {
        deep_pairs[i][0] = .{ .key = "n", .value = .{ .map = &deep_pairs[i - 1] } };
    }
    const deep_kept = policy.classifyLogAttrs(&.{.{ .key = "d", .value = .{ .map = &deep_pairs[17] } }}, arena);
    try testing.expectEqual(@as(usize, 0), deep_kept.len);

    // Budget > 2048 drops remaining members past budget.
    const wide = try testing.allocator.alloc(log_record.KeyValue, 2100);
    defer testing.allocator.free(wide);
    for (wide) |*kv| kv.* = log_record.kv("k", "v");
    const wide_kept = policy.classifyLogAttrs(&.{.{ .key = "big", .value = .{ .map = wide } }}, arena);
    try testing.expectEqual(@as(usize, 1), wide_kept.len);
    try testing.expect(wide_kept[0].value.map.len < 2100);
    try testing.expect(wide_kept[0].value.map.len == composite_walk_budget - 1);
}
