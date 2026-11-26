//! Builds OTLP log messages from pipeline log records, as the OTel Go
//! log exporters' transform does (exporters/otlp/otlplog/otlploghttp
//! internal/transform). The resource and scope builders are the ones
//! every signal shares in encode.zig.
//!
//! Every message is built in an arena and borrows the records' strings
//! where they are valid UTF-8, as encode.zig does.

const std = @import("std");
const Allocator = std.mem.Allocator;
const proto = @import("opentelemetry-proto");
const common = proto.common_v1;
const logs_v1 = proto.logs_v1;
const collector_logs = proto.collector_logs_v1;
const log_record = @import("../log_record.zig");
const LogData = log_record.LogData;
const resource_mod = @import("../resource.zig");
const encode = @import("encode.zig");

/// Converts a log value. An empty value is an `AnyValue` with nothing
/// set, as Go writes it.
pub fn anyValue(arena: Allocator, value: log_record.Value) Allocator.Error!common.AnyValue {
    return .{ .value = switch (value) {
        .empty => return .{},
        .string => |s| .{ .string_value = try encode.utf8(arena, s) },
        .bool => |b| .{ .bool_value = b },
        .int => |n| .{ .int_value = n },
        .double => |d| .{ .double_value = d },
        .bytes => |b| .{ .bytes_value = b },
        .array => |items| blk: {
            var values: std.ArrayList(common.AnyValue) = try .initCapacity(arena, items.len);
            for (items) |item| values.appendAssumeCapacity(try anyValue(arena, item));
            break :blk .{ .array_value = .{ .values = values } };
        },
        .map => |pairs| .{ .kvlist_value = .{ .values = try keyValues(arena, pairs) } },
    } };
}

/// Converts a list of log attributes or map entries.
pub fn keyValues(arena: Allocator, pairs: []const log_record.KeyValue) Allocator.Error!std.ArrayList(common.KeyValue) {
    var out: std.ArrayList(common.KeyValue) = try .initCapacity(arena, pairs.len);
    for (pairs) |p| out.appendAssumeCapacity(.{ .key = try encode.utf8(arena, p.key), .value = try anyValue(arena, p.value) });
    return out;
}

/// Converts one log record. The flags carry the W3C trace flags. The
/// trace and span ids are set only when valid, as in Go.
pub fn logRecord(arena: Allocator, d: *const LogData) Allocator.Error!logs_v1.LogRecord {
    var out: logs_v1.LogRecord = .{
        .time_unix_nano = d.timestamp,
        .observed_time_unix_nano = d.observed_timestamp,
        .severity_number = @fromBackingInt(@as(i32, @backingInt(d.severity))),
        .severity_text = try encode.utf8(arena, d.severity_text),
        .body = try anyValue(arena, d.body),
        .attributes = try keyValues(arena, d.attributes),
        .dropped_attributes_count = d.dropped_attributes_count,
        .flags = d.trace_flags.toByte(),
        .event_name = try encode.utf8(arena, d.event_name),
    };
    if (d.trace_id.isValid()) out.trace_id = &d.trace_id.bytes;
    if (d.span_id.isValid()) out.span_id = &d.span_id.bytes;
    return out;
}

/// Builds the export request for a batch of log records, grouped by
/// resource and then by scope, each in order of first appearance.
pub fn logsRequest(arena: Allocator, records: []const *const LogData) Allocator.Error!collector_logs.ExportLogsServiceRequest {
    var request: collector_logs.ExportLogsServiceRequest = .{};
    var resources: std.ArrayList(*const resource_mod.Resource) = .empty;
    var scopes: std.ArrayList(std.ArrayList(*const resource_mod.InstrumentationScope)) = .empty;
    for (records) |d| {
        const r_index = indexOf(resource_mod.Resource, resources.items, d.resource) orelse blk: {
            try resources.append(arena, d.resource);
            try scopes.append(arena, .empty);
            try request.resource_logs.append(arena, .{
                .resource = try encode.resource(arena, d.resource),
                .schema_url = d.resource.schema_url,
            });
            break :blk resources.items.len - 1;
        };
        const rl = &request.resource_logs.items[r_index];
        const scope_list = &scopes.items[r_index];
        const s_index = indexOf(resource_mod.InstrumentationScope, scope_list.items, d.scope) orelse blk: {
            try scope_list.append(arena, d.scope);
            try rl.scope_logs.append(arena, .{
                .scope = try encode.scope(arena, d.scope),
                .schema_url = d.scope.schema_url,
            });
            break :blk scope_list.items.len - 1;
        };
        try rl.scope_logs.items[s_index].log_records.append(arena, try logRecord(arena, d));
    }
    return request;
}

fn indexOf(comptime T: type, items: []const *const T, item: *const T) ?usize {
    for (items, 0..) |x, i| {
        if (x == item) return i;
    }
    return null;
}
