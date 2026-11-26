//! Inspection helpers for decoded OTLP protobuf messages (`KeyValue`,
//! `AnyValue`, `ResourceSpans`, `ResourceMetrics`, `ResourceLogs`).

const std = @import("std");
const Allocator = std.mem.Allocator;
const proto = @import("opentelemetry-proto");
const common_v1 = proto.common_v1;
const trace_v1 = proto.trace_v1;
const metrics_v1 = proto.metrics_v1;
const logs_v1 = proto.logs_v1;

/// Finds the last `KeyValue` matching `key` in `attrs`, or null.
pub fn findAttr(attrs: []const common_v1.KeyValue, key: []const u8) ?common_v1.AnyValue {
    var i = attrs.len;
    while (i > 0) {
        i -= 1;
        if (std.mem.eql(u8, attrs[i].key, key)) return attrs[i].value;
    }
    return null;
}

/// Reports whether `key` is present in `attrs`.
pub fn hasAttr(attrs: []const common_v1.KeyValue, key: []const u8) bool {
    for (attrs) |kv| {
        if (std.mem.eql(u8, kv.key, key)) return true;
    }
    return false;
}

/// Returns the string value of `key` in `attrs`, or null if missing or not a string.
pub fn attrString(attrs: []const common_v1.KeyValue, key: []const u8) ?[]const u8 {
    const av = findAttr(attrs, key) orelse return null;
    const val = av.value orelse return null;
    return switch (val) {
        .string_value => |s| s,
        else => null,
    };
}

/// Returns the int64 value of `key` in `attrs`, or null if missing or not an int.
pub fn attrInt(attrs: []const common_v1.KeyValue, key: []const u8) ?i64 {
    const av = findAttr(attrs, key) orelse return null;
    const val = av.value orelse return null;
    return switch (val) {
        .int_value => |v| v,
        else => null,
    };
}

/// Returns the double value of `key` in `attrs`, or null if missing or not a double.
pub fn attrDouble(attrs: []const common_v1.KeyValue, key: []const u8) ?f64 {
    const av = findAttr(attrs, key) orelse return null;
    const val = av.value orelse return null;
    return switch (val) {
        .double_value => |v| v,
        else => null,
    };
}

/// Returns the bool value of `key` in `attrs`, or null if missing or not a bool.
pub fn attrBool(attrs: []const common_v1.KeyValue, key: []const u8) ?bool {
    const av = findAttr(attrs, key) orelse return null;
    const val = av.value orelse return null;
    return switch (val) {
        .bool_value => |v| v,
        else => null,
    };
}

/// Renders an OTLP `AnyValue` recursively into text for substring leak checks.
/// Caller owns the returned slice.
pub fn anyValueToText(gpa: Allocator, av: ?common_v1.AnyValue) Allocator.Error![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(gpa);
    if (av) |v| {
        try appendAnyValue(gpa, &out, v, 0);
    }
    return out.toOwnedSlice(gpa);
}

fn appendAnyValue(gpa: Allocator, out: *std.ArrayList(u8), av: common_v1.AnyValue, depth: usize) Allocator.Error!void {
    if (depth > 32) return;
    const val = av.value orelse return;
    switch (val) {
        .string_value => |s| try out.appendSlice(gpa, s),
        .bool_value => |b| try out.appendSlice(gpa, if (b) "true" else "false"),
        .int_value => |i| {
            var buf: [32]u8 = undefined;
            const s = std.fmt.bufPrint(&buf, "{d}", .{i}) catch "";
            try out.appendSlice(gpa, s);
        },
        .double_value => |d| {
            var buf: [64]u8 = undefined;
            const s = std.fmt.bufPrint(&buf, "{d}", .{d}) catch "";
            try out.appendSlice(gpa, s);
        },
        .bytes_value => |b| {
            try out.appendSlice(gpa, b);
        },
        .array_value => |arr| {
            try out.append(gpa, '[');
            for (arr.values.items, 0..) |item, i| {
                if (i > 0) try out.append(gpa, ',');
                try appendAnyValue(gpa, out, item, depth + 1);
            }
            try out.append(gpa, ']');
        },
        .kvlist_value => |kvl| {
            try out.append(gpa, '{');
            for (kvl.values.items, 0..) |kv, i| {
                if (i > 0) try out.append(gpa, ',');
                try out.appendSlice(gpa, kv.key);
                try out.append(gpa, '=');
                if (kv.value) |inner| try appendAnyValue(gpa, out, inner, depth + 1);
            }
            try out.append(gpa, '}');
        },
        .string_value_strindex => {},
    }
}

/// Reports whether any attribute (at any nesting depth, using dotted effective
/// keys for kvlists) matches `key` or has a value containing `needle`.
pub fn attrsContainKeyOrSentinel(
    gpa: Allocator,
    attrs: []const common_v1.KeyValue,
    forbidden_keys: []const []const u8,
    sentinels: []const []const u8,
) Allocator.Error!bool {
    return checkAttrsRecursive(gpa, "", attrs, forbidden_keys, sentinels, 0);
}

fn checkAttrsRecursive(
    gpa: Allocator,
    prefix: []const u8,
    attrs: []const common_v1.KeyValue,
    forbidden_keys: []const []const u8,
    sentinels: []const []const u8,
    depth: usize,
) Allocator.Error!bool {
    if (depth > 32) return false;
    for (attrs) |kv| {
        const eff = if (prefix.len == 0)
            try gpa.dupe(u8, kv.key)
        else
            try std.fmt.allocPrint(gpa, "{s}.{s}", .{ prefix, kv.key });
        defer gpa.free(eff);

        for (forbidden_keys) |fk| {
            if (std.mem.eql(u8, eff, fk)) return true;
        }
        if (kv.value) |av| {
            if (try checkValueRecursive(gpa, eff, av, forbidden_keys, sentinels, depth + 1)) return true;
        }
    }
    return false;
}

fn checkValueRecursive(
    gpa: Allocator,
    prefix: []const u8,
    av: common_v1.AnyValue,
    forbidden_keys: []const []const u8,
    sentinels: []const []const u8,
    depth: usize,
) Allocator.Error!bool {
    if (depth > 32) return false;
    const val = av.value orelse return false;
    switch (val) {
        .kvlist_value => |kvl| {
            return checkAttrsRecursive(gpa, prefix, kvl.values.items, forbidden_keys, sentinels, depth + 1);
        },
        .array_value => |arr| {
            for (arr.values.items) |item| {
                if (try checkValueRecursive(gpa, prefix, item, forbidden_keys, sentinels, depth + 1)) return true;
            }
            return false;
        },
        else => {
            const text = try anyValueToText(gpa, av);
            defer gpa.free(text);
            for (sentinels) |s| {
                if (s.len > 0 and std.mem.indexOf(u8, text, s) != null) return true;
            }
            return false;
        },
    }
}

/// Finds the first span named `name` across a slice of `ResourceSpans`.
pub fn findSpan(resource_spans: []const trace_v1.ResourceSpans, name: []const u8) ?*const trace_v1.Span {
    for (resource_spans) |*rs| {
        for (rs.scope_spans.items) |*ss| {
            for (ss.spans.items) |*sp| {
                if (std.mem.eql(u8, sp.name, name)) return sp;
            }
        }
    }
    return null;
}

/// Finds the first metric named `name` across a slice of `ResourceMetrics`.
pub fn findMetric(resource_metrics: []const metrics_v1.ResourceMetrics, name: []const u8) ?*const metrics_v1.Metric {
    for (resource_metrics) |*rm| {
        for (rm.scope_metrics.items) |*sm| {
            for (sm.metrics.items) |*m| {
                if (std.mem.eql(u8, m.name, name)) return m;
            }
        }
    }
    return null;
}

/// Finds the first log record whose string body equals `body` across `ResourceLogs`.
pub fn findLogByBody(resource_logs: []const logs_v1.ResourceLogs, body: []const u8) ?*const logs_v1.LogRecord {
    for (resource_logs) |*rl| {
        for (rl.scope_logs.items) |*sl| {
            for (sl.log_records.items) |*lr| {
                if (lr.body) |b| {
                    if (b.value) |v| {
                        if (v == .string_value and std.mem.eql(u8, v.string_value, body)) return lr;
                    }
                }
            }
        }
    }
    return null;
}

/// Finds the first log record whose `event.name` attribute (or `event_name`
/// field) equals `event_name` across `ResourceLogs`.
pub fn findLogByEvent(resource_logs: []const logs_v1.ResourceLogs, event_name: []const u8) ?*const logs_v1.LogRecord {
    for (resource_logs) |*rl| {
        for (rl.scope_logs.items) |*sl| {
            for (sl.log_records.items) |*lr| {
                if (std.mem.eql(u8, lr.event_name, event_name)) return lr;
                if (attrString(lr.attributes.items, "event.name")) |en| {
                    if (std.mem.eql(u8, en, event_name)) return lr;
                }
            }
        }
    }
    return null;
}
