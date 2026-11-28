//! ABI layout test. `c_types.zig` mirrors the public headers by hand, so a
//! field added, removed, reordered or retyped on one side only would corrupt
//! every call that passes the struct. This test translates the headers and
//! compares each mirror with its C declaration: the size, the alignment, and
//! the name, offset and size of every field, and the value of every enum
//! constant.

const std = @import("std");
const testing = std.testing;
const h = @import("o11y_h");
const c = @import("c_types.zig");

fn expectSameStruct(comptime Zig: type, comptime C: type) !void {
    try testing.expectEqual(@sizeOf(C), @sizeOf(Zig));
    try testing.expectEqual(@alignOf(C), @alignOf(Zig));
    const c_info = @typeInfo(C).@"struct";
    const zig_info = @typeInfo(Zig).@"struct";
    try testing.expectEqual(c_info.field_names.len, zig_info.field_names.len);
    inline for (c_info.field_names, zig_info.field_names, c_info.field_types, zig_info.field_types) |c_name, zig_name, CField, ZigField| {
        try testing.expectEqualStrings(c_name, zig_name);
        try testing.expectEqual(@offsetOf(C, c_name), @offsetOf(Zig, zig_name));
        try testing.expectEqual(@sizeOf(CField), @sizeOf(ZigField));
    }
}

fn expectSameUnion(comptime Zig: type, comptime C: type) !void {
    try testing.expectEqual(@sizeOf(C), @sizeOf(Zig));
    try testing.expectEqual(@alignOf(C), @alignOf(Zig));
    const c_info = @typeInfo(C).@"union";
    const zig_info = @typeInfo(Zig).@"union";
    try testing.expectEqual(c_info.field_names.len, zig_info.field_names.len);
    inline for (c_info.field_names, zig_info.field_names, c_info.field_types, zig_info.field_types) |c_name, zig_name, CField, ZigField| {
        try testing.expectEqualStrings(c_name, zig_name);
        try testing.expectEqual(@sizeOf(CField), @sizeOf(ZigField));
    }
}

/// A Zig tag whose C constant is not `prefix ++ UPPER(tag)`.
const Rename = struct { tag: []const u8, constant: []const u8 };

/// Checks that every tag of `Zig` has a C constant with the same value. The
/// constant is `prefix` followed by the tag in upper case, unless `renames`
/// names it.
fn expectSameEnum(comptime Zig: type, comptime prefix: []const u8, comptime renames: []const Rename) !void {
    try testing.expectEqual(@sizeOf(c_int), @sizeOf(Zig));
    const info = @typeInfo(Zig).@"enum";
    inline for (info.field_names, info.field_values) |tag, value| {
        const constant = comptime blk: {
            for (renames) |r| {
                if (std.mem.eql(u8, r.tag, tag)) break :blk r.constant;
            }
            var upper: [tag.len]u8 = undefined;
            _ = std.ascii.upperString(&upper, tag);
            const name = prefix ++ upper;
            break :blk name;
        };
        try testing.expectEqual(@as(i64, @intCast(@field(h, constant))), @as(i64, value));
    }
}

test "structs match the headers" {
    try expectSameStruct(c.Diagnostic, h.o11y_diagnostic_t);
    try expectSameStruct(c.TraceId, h.o11y_trace_id_t);
    try expectSameStruct(c.SpanId, h.o11y_span_id_t);
    try expectSameStruct(c.SpanContext, h.o11y_span_context_t);
    try expectSameStruct(c.Attr, h.o11y_attr_t);
    try expectSameStruct(c.LogValue, h.o11y_log_value_t);
    try expectSameStruct(c.LogAttr, h.o11y_log_attr_t);
    try expectSameStruct(c.EnvPair, h.o11y_env_pair_t);
    try expectSameStruct(c.BuildInfo, h.o11y_build_info_t);
    try expectSameStruct(c.AppRegistrySource, h.o11y_app_registry_source_t);
    try expectSameStruct(c.HistogramBuckets, h.o11y_histogram_buckets_t);
    try expectSameStruct(c.LogSink, h.o11y_log_sink_t);
    try expectSameStruct(c.Carrier, h.o11y_carrier_t);
    try expectSameStruct(c.Propagator, h.o11y_propagator_t);
    try expectSameStruct(c.Options, h.o11y_options_t);
    try expectSameStruct(c.ShutdownReport, h.o11y_shutdown_report_t);
    try expectSameStruct(c.SignalOptions, h.o11y_signal_options_t);
    try expectSameStruct(c.SpanLink, h.o11y_span_link_t);
    try expectSameStruct(c.SpanStartOptions, h.o11y_span_start_options_t);
    try expectSameStruct(c.InstrumentOptions, h.o11y_instrument_options_t);
    try expectSameStruct(c.HistogramOptions, h.o11y_histogram_options_t);
    try expectSameStruct(c.InstHandle, h.o11y_counter_i64_t);
    try expectSameStruct(c.InstHandle, h.o11y_histogram_f64_t);
    try expectSameStruct(c.TestOptions, h.o11y_test_options_t);
    try expectSameStruct(c.TestExemplar, h.o11y_test_exemplar_t);
    try expectSameStruct(c.TestTlsOptions, h.o11y_test_tls_options_t);
    try expectSameStruct(c.TestHttpReply, h.o11y_test_http_reply_t);
    try expectSameStruct(c.TestHttpReceiverOptions, h.o11y_test_http_receiver_options_t);
    try expectSameStruct(c.TestGrpcReply, h.o11y_test_grpc_reply_t);
    try expectSameStruct(c.TestGrpcReceiverOptions, h.o11y_test_grpc_receiver_options_t);
}

test "unions match the headers" {
    const c_attr_value = @FieldType(h.o11y_attr_t, "value");
    try expectSameUnion(c.AttrValue, c_attr_value);
    const c_log_value = @FieldType(h.o11y_log_value_t, "value");
    try expectSameUnion(c.LogValueUnion, c_log_value);
}

test "enum constants match the headers" {
    try expectSameEnum(c.Sensitivity, "O11Y_SENSITIVITY_", &.{});
    try expectSameEnum(c.Cardinality, "O11Y_CARDINALITY_", &.{});
    try expectSameEnum(c.Err, "O11Y_ERR_", &.{.{ .tag = "ok", .constant = "O11Y_OK" }});
    try expectSameEnum(c.AttrKind, "O11Y_ATTR_", &.{});
    try expectSameEnum(c.LogValueKind, "O11Y_LOG_VAL_", &.{});
    try expectSameEnum(c.EnvMode, "O11Y_ENV_", &.{});
    try expectSameEnum(c.Protocol, "O11Y_PROTOCOL_", &.{});
    try expectSameEnum(c.Level, "O11Y_LEVEL_", &.{.{ .tag = "err", .constant = "O11Y_LEVEL_ERROR" }});
    try expectSameEnum(c.ConsoleFormat, "O11Y_CONSOLE_", &.{});
    try expectSameEnum(c.ConsoleTarget, "O11Y_CONSOLE_", &.{});
    try expectSameEnum(c.PiiMode, "O11Y_PII_", &.{});
    try expectSameEnum(c.SamplerKind, "O11Y_SAMPLER_", &.{});
    try expectSameEnum(c.ExemplarFilter, "O11Y_EXEMPLAR_FILTER_", &.{});
    try expectSameEnum(c.PropagatorKind, "O11Y_PROPAGATOR_", &.{});
    try expectSameEnum(c.SpanKind, "O11Y_SPAN_KIND_", &.{});
    try expectSameEnum(c.StatusCode, "O11Y_STATUS_", &.{.{ .tag = "err", .constant = "O11Y_STATUS_ERROR" }});
}

test "the header version is the manifest version" {
    const version: []const u8 = @import("c_build_options").c_version;
    try testing.expectEqualStrings(version, std.mem.span(@as([*:0]const u8, h.O11Y_VERSION)));
    var buf: [32]u8 = undefined;
    const from_parts = try std.fmt.bufPrint(&buf, "{d}.{d}.{d}", .{
        h.O11Y_VERSION_MAJOR,
        h.O11Y_VERSION_MINOR,
        h.O11Y_VERSION_PATCH,
    });
    try testing.expectEqualStrings(version, from_parts);
}
