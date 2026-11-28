//! Tests for the logger provider and the log processors, through the
//! in-memory log exporter.

const std = @import("std");
const testing = std.testing;
const Io = std.Io;
const Context = @import("../context.zig").Context;
const attribute = @import("attribute.zig");
const batch = @import("batch.zig");
const deadline = @import("deadline.zig");
const Deadline = deadline.Deadline;
const ids = @import("ids.zig");
const log_processor = @import("log_processor.zig");
const InMemoryLogExporter = log_processor.InMemoryLogExporter;
const log_record = @import("log_record.zig");
const LogData = log_record.LogData;
const kv = log_record.kv;
const logger_mod = @import("logger.zig");
const LoggerProvider = logger_mod.LoggerProvider;
const policy = @import("policy.zig");
const processor = @import("processor.zig");
const InMemoryExporter = @import("memory_exporter.zig").InMemoryExporter;
const tracer_mod = @import("tracer.zig");

const io = testing.io;
const gpa = testing.allocator;

/// A provider with a simple processor over an in-memory exporter.
const Harness = struct {
    exporter: InMemoryLogExporter,
    simple: log_processor.SimpleLogProcessor,
    provider: *LoggerProvider,

    fn init(h: *Harness, options: LoggerProvider.Options) !void {
        h.exporter = .init(gpa, io);
        h.simple = .init(io, h.exporter.exporter(), .{});
        var opts = options;
        const procs = [_]log_processor.LogProcessor{h.simple.processor()};
        if (opts.processors.len == 0) opts.processors = &procs;
        h.provider = try .create(gpa, io, opts);
    }

    fn deinit(h: *Harness) void {
        h.provider.shutdown(deadline.after(io, .fromSeconds(5))) catch {};
        h.exporter.deinit();
        h.provider.destroy();
    }

    fn logger(h: *Harness) *const logger_mod.Logger {
        return h.provider.logger(.{ .name = "test", .version = "1.0.0" });
    }

    fn only(h: *Harness) !*const LogData {
        try testing.expectEqual(@as(usize, 1), h.exporter.records.items.len);
        return h.exporter.records.items[0];
    }
};

test "a record carries its fields, the resource and the scope" {
    const res_attrs = [_]attribute.KeyValue{attribute.kv("service.name", "svc")};
    var h: Harness = undefined;
    try h.init(.{ .resource = .{ .attributes = &res_attrs, .schema_url = "https://schemas.o11y.ing/1.1.0" } });
    defer h.deinit();
    h.logger().emit(.background, .{
        .timestamp = 1_700_000_000_000_000_000,
        .severity = .warn,
        .severity_text = "WARN",
        .body = .from("disk almost full"),
        .attributes = &.{ kv("disk.free", 12), kv("mount", "/data") },
        .event_name = "disk.pressure",
    });
    const r = try h.only();
    try testing.expectEqual(@as(u64, 1_700_000_000_000_000_000), r.timestamp);
    try testing.expect(r.observed_timestamp > 0);
    try testing.expectEqual(log_record.Severity.warn, r.severity);
    try testing.expectEqualStrings("WARN", r.severity_text);
    try testing.expectEqualStrings("disk almost full", r.body.string);
    try testing.expectEqual(@as(i64, 12), log_record.find(r.attributes, "disk.free").?.int);
    try testing.expectEqualStrings("disk.pressure", r.event_name);
    try testing.expectEqualStrings("svc", r.resource.attributes[0].value.string);
    try testing.expectEqualStrings("test", r.scope.name);
    try testing.expectEqualStrings("1.0.0", r.scope.version);
    try testing.expect(!r.trace_id.isValid());
    try testing.expect(!r.span_id.isValid());
}

test "the trace identity is copied from a context with a live span" {
    var spans: InMemoryExporter = .init(gpa, io);
    defer spans.deinit();
    var simple_spans: processor.SimpleSpanProcessor = .init(io, spans.exporter(), .{});
    const tp = try tracer_mod.TracerProvider.create(gpa, io, .{ .processors = &.{simple_spans.processor()} });
    defer tp.destroy();
    defer tp.shutdown(deadline.after(io, .fromSeconds(5))) catch {};

    var h: Harness = undefined;
    try h.init(.{});
    defer h.deinit();

    var span = tp.tracer(.{ .name = "t" }).start(.background, "op", .{});
    const ctx = Context.background.withSpan(&span);
    h.logger().emit(ctx, .{ .severity = .info, .body = .from("inside the span") });
    const sc = span.spanContext();
    span.end();

    const r = try h.only();
    try testing.expect(r.trace_id.isValid());
    try testing.expectEqualSlices(u8, &sc.trace_id.bytes, &r.trace_id.bytes);
    try testing.expectEqualSlices(u8, &sc.span_id.bytes, &r.span_id.bytes);
    try testing.expectEqual(sc.flags, r.trace_flags);
    try testing.expect(r.trace_flags.sampled);
}

test "the trace identity comes only from the context" {
    // SPEC section 4: TraceId and SpanId are injected from context and
    // are not caller-settable, so a record has no fields for them.
    try testing.expect(!@hasField(log_record.Record, "trace_id"));
    try testing.expect(!@hasField(log_record.Record, "span_id"));
    try testing.expect(!@hasField(log_record.Record, "trace_flags"));

    var h: Harness = undefined;
    try h.init(.{});
    defer h.deinit();
    const ctx_sc: ids.SpanContext = .{
        .trace_id = ids.TraceId.parseHex("4bf92f3577b34da6a3ce929d0e0e4736").?,
        .span_id = ids.SpanId.parseHex("00f067aa0ba902b7").?,
        .flags = .sampled_flag,
        .remote = true,
    };
    h.logger().emit(Context.background.withSpanContext(ctx_sc), .{});
    h.logger().emit(.background, .{});
    try testing.expectEqual(@as(usize, 2), h.exporter.records.items.len);
    const remote = h.exporter.records.items[0];
    try testing.expectEqualSlices(u8, &ctx_sc.trace_id.bytes, &remote.trace_id.bytes);
    try testing.expectEqualSlices(u8, &ctx_sc.span_id.bytes, &remote.span_id.bytes);
    try testing.expect(remote.trace_flags.sampled);
    const outside = h.exporter.records.items[1];
    try testing.expect(!outside.trace_id.isValid());
    try testing.expect(!outside.span_id.isValid());
}

test "the policy hook runs over the record's attributes" {
    const DropSecret = struct {
        fn apply(_: ?*anyopaque, _: policy.Target, attrs: []attribute.KeyValue, _: std.mem.Allocator) []attribute.KeyValue {
            return attrs;
        }
        fn applyLog(_: ?*anyopaque, attrs: []log_record.KeyValue, _: std.mem.Allocator) []log_record.KeyValue {
            var n: usize = 0;
            for (attrs) |a| {
                if (std.mem.eql(u8, a.key, "password")) continue;
                attrs[n] = a;
                n += 1;
            }
            return attrs[0..n];
        }
    };
    const drop: policy.AttributePolicy = .{ .ptr = null, .vtable = &.{ .apply = DropSecret.apply, .applyLog = DropSecret.applyLog } };
    var h: Harness = undefined;
    try h.init(.{ .policy = drop });
    defer h.deinit();
    h.logger().emit(.background, .{ .attributes = &.{ kv("user", "ada"), kv("password", "hunter2") } });
    const r = try h.only();
    try testing.expectEqual(@as(usize, 1), r.attributes.len);
    try testing.expectEqualStrings("user", r.attributes[0].key);
}

test "the provider's limits apply to emitted records" {
    var h: Harness = undefined;
    try h.init(.{ .limits = .{ .attribute_count = 1, .attribute_value_length = 2 } });
    defer h.deinit();
    h.logger().emit(.background, .{ .attributes = &.{ kv("a", "abcdef"), kv("b", 2) } });
    const r = try h.only();
    try testing.expectEqual(@as(usize, 1), r.attributes.len);
    try testing.expectEqualStrings("ab", r.attributes[0].value.string);
    try testing.expectEqual(@as(u32, 1), r.dropped_attributes_count);
}

test "loggers are cached by scope, and emits after shutdown are dropped" {
    var h: Harness = undefined;
    try h.init(.{});
    defer h.deinit();
    const a = h.provider.logger(.{ .name = "x", .version = "1" });
    const b = h.provider.logger(.{ .name = "x", .version = "1" });
    const c = h.provider.logger(.{ .name = "x", .version = "2" });
    try testing.expectEqual(a, b);
    try testing.expect(a != c);
    try testing.expect(a.enabled());
    try h.provider.shutdown(deadline.after(io, .fromSeconds(5)));
    try testing.expect(!a.enabled());
    a.emit(.background, .{ .body = .from("late") });
    try testing.expectEqual(@as(usize, 0), h.exporter.records.items.len);
    try testing.expect(h.exporter.is_shutdown);
    // A second shutdown and a flush after shutdown do nothing.
    try h.provider.shutdown(deadline.after(io, .fromSeconds(5)));
    try h.provider.forceFlush(deadline.after(io, .fromSeconds(5)));
}

test "the no-op logger and a provider without processors drop records" {
    logger_mod.Logger.noop.emit(.background, .{ .body = .from("x") });
    try testing.expect(!logger_mod.Logger.noop.enabled());
    const p = try LoggerProvider.create(gpa, io, .{});
    defer p.destroy();
    const l = p.logger(.{ .name = "t" });
    try testing.expect(!l.enabled());
    l.emit(.background, .{ .body = .from("x") });
    try p.shutdown(deadline.after(io, .fromSeconds(1)));
}

test "the simple processor reports export failures and flushes the exporter" {
    const Capture = struct {
        count: usize = 0,
        last: ?processor.ExportError = null,
        fn report(ptr: ?*anyopaque, component: []const u8, err: processor.ExportError, _: []const u8) void {
            const self: *@This() = @ptrCast(@alignCast(ptr.?));
            if (!std.mem.eql(u8, component, "simple log processor")) return;
            self.count += 1;
            self.last = err;
        }
    };
    var capture: Capture = .{};
    var exporter: InMemoryLogExporter = .init(gpa, io);
    defer exporter.deinit();
    exporter.fail_with = error.ExportFailed;
    var simple: log_processor.SimpleLogProcessor = .init(io, exporter.exporter(), .{ .on_error = .{ .ptr = &capture, .report = Capture.report } });
    const p = try LoggerProvider.create(gpa, io, .{ .processors = &.{simple.processor()} });
    defer p.destroy();
    p.logger(.{ .name = "t" }).emit(.background, .{});
    try testing.expectEqual(@as(usize, 1), capture.count);
    try testing.expectEqual(error.ExportFailed, capture.last.?);
    try p.forceFlush(deadline.after(io, .fromSeconds(1)));
    try testing.expectEqual(@as(usize, 1), exporter.flush_calls);
    try p.shutdown(deadline.after(io, .fromSeconds(1)));
    // Shutdown flushes the exporter before it shuts it down, as in Go.
    try testing.expectEqual(@as(usize, 2), exporter.flush_calls);
    try testing.expect(exporter.is_shutdown);
}

/// A log exporter that can block in its export until released, to fill
/// the batch processor's queue.
const BlockingExporter = struct {
    inner: InMemoryLogExporter,
    block: bool = false,
    entered: Io.Event = .unset,
    unblock: Io.Event = .unset,

    fn exporter(b: *BlockingExporter) log_processor.LogExporter {
        return .{ .ptr = b, .vtable = &.{ .exportLogs = exportLogs, .forceFlush = forceFlush, .shutdown = shutdown } };
    }

    fn exportLogs(ptr: *anyopaque, records: []const *const LogData, d: Deadline) processor.ExportError!void {
        const b: *BlockingExporter = @ptrCast(@alignCast(ptr));
        if (b.block) {
            b.entered.set(io);
            b.unblock.wait(io) catch return error.Canceled;
        }
        return b.inner.exporter().exportLogs(records, d);
    }

    fn forceFlush(ptr: *anyopaque, d: Deadline) processor.ExportError!void {
        const b: *BlockingExporter = @ptrCast(@alignCast(ptr));
        return b.inner.exporter().forceFlush(d);
    }

    fn shutdown(ptr: *anyopaque, d: Deadline) processor.ExportError!void {
        const b: *BlockingExporter = @ptrCast(@alignCast(ptr));
        return b.inner.exporter().shutdown(d);
    }
};

fn bodyText(r: *const LogData) []const u8 {
    return r.body.string;
}

test "a full batch queue drops the oldest records and counts them" {
    var blocking: BlockingExporter = .{ .inner = .init(gpa, io), .block = true };
    defer blocking.inner.deinit();
    var config = log_processor.default_batch_config;
    config.max_queue_size = 3;
    config.max_export_batch_size = 1;
    config.schedule_delay = .fromSeconds(60);
    const blp = try log_processor.BatchLogProcessor.create(gpa, io, blocking.exporter(), .{ .config = config });
    defer blp.destroy();
    const p = try LoggerProvider.create(gpa, io, .{ .processors = &.{blp.processor()} });
    defer p.destroy();
    const l = p.logger(.{ .name = "t" });

    l.emit(.background, .{ .body = .from("first") });
    // The worker takes the first record and blocks in its export.
    try blocking.entered.wait(io);
    const names = [_][]const u8{ "r1", "r2", "r3", "r4", "r5" };
    for (names) |name| l.emit(.background, .{ .body = .from(name) });
    try testing.expectEqual(@as(u64, 2), blp.droppedCount());

    blocking.unblock.set(io);
    try p.shutdown(deadline.after(io, .fromSeconds(5)));
    const got = blocking.inner.records.items;
    try testing.expectEqual(@as(usize, 4), got.len);
    try testing.expectEqualStrings("first", bodyText(got[0]));
    try testing.expectEqualStrings("r3", bodyText(got[1]));
    try testing.expectEqualStrings("r4", bodyText(got[2]));
    try testing.expectEqualStrings("r5", bodyText(got[3]));
}

test "shutdown flushes every queued record and shuts the exporter down" {
    var exporter: InMemoryLogExporter = .init(gpa, io);
    defer exporter.deinit();
    var config = log_processor.default_batch_config;
    config.schedule_delay = .fromSeconds(60);
    config.max_export_batch_size = 4;
    const blp = try log_processor.BatchLogProcessor.create(gpa, io, exporter.exporter(), .{ .config = config });
    defer blp.destroy();
    const p = try LoggerProvider.create(gpa, io, .{ .processors = &.{blp.processor()} });
    defer p.destroy();
    const l = p.logger(.{ .name = "t" });
    for (0..10) |i| l.emit(.background, .{ .attributes = &.{kv("i", @as(i64, @intCast(i)))} });

    try p.shutdown(deadline.after(io, .fromSeconds(5)));
    try testing.expectEqual(@as(usize, 10), exporter.count());
    for (exporter.records.items, 0..) |r, i| try testing.expectEqual(@as(i64, @intCast(i)), r.attributes[0].value.int);
    try testing.expect(exporter.is_shutdown);
    try testing.expect(exporter.flush_calls >= 1);
    try testing.expectEqual(@as(u64, 0), blp.droppedCount());
}

test "a later batch log processor shutdown returns the first call's failure" {
    const Rejecting = struct {
        fn exporter(self: *@This()) log_processor.LogExporter {
            return .{ .ptr = self, .vtable = &.{ .exportLogs = exportLogs, .forceFlush = noop, .shutdown = noop } };
        }
        fn exportLogs(_: *anyopaque, _: []const *const LogData, _: deadline.Deadline) processor.ExportError!void {
            return error.ExportFailed;
        }
        fn noop(_: *anyopaque, _: deadline.Deadline) processor.ExportError!void {}
    };
    var rejecting: Rejecting = .{};
    var config = log_processor.default_batch_config;
    config.schedule_delay = .fromSeconds(60);
    const blp = try log_processor.BatchLogProcessor.create(gpa, io, rejecting.exporter(), .{ .config = config });
    defer blp.destroy();
    const p = try LoggerProvider.create(gpa, io, .{ .processors = &.{blp.processor()} });
    defer p.destroy();
    p.logger(.{ .name = "t" }).emit(.background, .{});

    const proc = blp.processor();
    try testing.expectError(error.ExportFailed, proc.shutdown(deadline.after(io, .fromSeconds(5))));
    // As the batch span processor, the tracer provider and the periodic
    // reader do, a later call reports what the first one found.
    try testing.expectError(error.ExportFailed, proc.shutdown(deadline.after(io, .fromSeconds(5))));
}

test "forceFlush exports what is queued without waiting for the delay" {
    var exporter: InMemoryLogExporter = .init(gpa, io);
    defer exporter.deinit();
    var config = log_processor.default_batch_config;
    config.schedule_delay = .fromSeconds(60);
    const blp = try log_processor.BatchLogProcessor.create(gpa, io, exporter.exporter(), .{ .config = config });
    defer blp.destroy();
    const p = try LoggerProvider.create(gpa, io, .{ .processors = &.{blp.processor()} });
    defer p.destroy();
    defer p.shutdown(deadline.after(io, .fromSeconds(5))) catch {};
    p.logger(.{ .name = "t" }).emit(.background, .{ .body = .from("x") });
    try p.forceFlush(deadline.after(io, .fromSeconds(5)));
    try testing.expectEqual(@as(usize, 1), exporter.count());
    try testing.expectEqual(@as(usize, 1), exporter.flush_calls);
}

test "the batch log processor defaults are the OTel defaults" {
    const c = log_processor.default_batch_config;
    try testing.expectEqual(@as(usize, 2048), c.max_queue_size);
    try testing.expectEqual(@as(usize, 512), c.max_export_batch_size);
    try testing.expectEqual(@as(i64, 1000), c.schedule_delay.toMilliseconds());
    try testing.expectEqual(@as(i64, 30000), c.export_timeout.toMilliseconds());
    try testing.expectEqual(batch.Config.Overflow.drop_oldest, c.overflow);
}

const TestEnv = struct {
    pairs: []const [2][]const u8,

    pub fn get(e: TestEnv, key: []const u8) ?[]const u8 {
        for (e.pairs) |p| if (std.mem.eql(u8, p[0], key)) return p[1];
        return null;
    }
};

test "OTEL_BLRP_* map onto the batch settings as Go reads them" {
    const none: TestEnv = .{ .pairs = &.{} };
    try testing.expectEqual(log_processor.default_batch_config, log_processor.batchConfig(.{}, none));

    const env: TestEnv = .{ .pairs = &.{
        .{ "OTEL_BLRP_MAX_QUEUE_SIZE", "100" },
        .{ "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", "50" },
        .{ "OTEL_BLRP_SCHEDULE_DELAY", "250" },
        .{ "OTEL_BLRP_EXPORT_TIMEOUT", "+1500" },
    } };
    const c = log_processor.batchConfig(.{}, env);
    try testing.expectEqual(@as(usize, 100), c.max_queue_size);
    try testing.expectEqual(@as(usize, 50), c.max_export_batch_size);
    try testing.expectEqual(@as(i64, 250), c.schedule_delay.toMilliseconds());
    try testing.expectEqual(@as(i64, 1500), c.export_timeout.toMilliseconds());

    // Code wins over the environment.
    const coded = log_processor.batchConfig(.{ .max_queue_size = 10, .schedule_delay = .fromMilliseconds(5) }, env);
    try testing.expectEqual(@as(usize, 10), coded.max_queue_size);
    try testing.expectEqual(@as(i64, 5), coded.schedule_delay.toMilliseconds());
    // The batch size is clamped to the queue size.
    try testing.expectEqual(@as(usize, 10), coded.max_export_batch_size);

    // Values below one, in code or in the environment, and malformed
    // values fall through to the next source.
    const bad: TestEnv = .{ .pairs = &.{
        .{ "OTEL_BLRP_MAX_QUEUE_SIZE", "0" },
        .{ "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", " 50" },
        .{ "OTEL_BLRP_SCHEDULE_DELAY", "-5" },
        .{ "OTEL_BLRP_EXPORT_TIMEOUT", "1_000" },
    } };
    try testing.expectEqual(log_processor.default_batch_config, log_processor.batchConfig(.{}, bad));
    const zero_code = log_processor.batchConfig(.{ .max_queue_size = 0, .export_timeout = .zero }, env);
    try testing.expectEqual(@as(usize, 100), zero_code.max_queue_size);
    try testing.expectEqual(@as(i64, 1500), zero_code.export_timeout.toMilliseconds());
}

test "OTEL_LOGRECORD_* map onto the log record limits" {
    const none: TestEnv = .{ .pairs = &.{} };
    try testing.expectEqual(log_record.Limits{}, log_processor.limitsFromEnv(none));
    const env: TestEnv = .{ .pairs = &.{
        .{ "OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT", "10" },
        .{ "OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT", "64" },
    } };
    const l = log_processor.limitsFromEnv(env);
    try testing.expectEqual(@as(?u32, 10), l.attribute_count);
    try testing.expectEqual(@as(?usize, 64), l.attribute_value_length);
    try testing.expectEqual(@as(?u32, 64), l.attribute_value_depth);
    const unlimited: TestEnv = .{ .pairs = &.{
        .{ "OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT", "-1" },
        .{ "OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT", "abc" },
    } };
    const u = log_processor.limitsFromEnv(unlimited);
    try testing.expectEqual(@as(?u32, null), u.attribute_count);
    try testing.expectEqual(@as(?usize, null), u.attribute_value_length);
}

test "parseAtoi accepts what strconv.Atoi accepts" {
    try testing.expectEqual(@as(?i64, 42), log_processor.parseAtoi("42"));
    try testing.expectEqual(@as(?i64, -7), log_processor.parseAtoi("-7"));
    try testing.expectEqual(@as(?i64, 7), log_processor.parseAtoi("+7"));
    try testing.expectEqual(@as(?i64, null), log_processor.parseAtoi(""));
    try testing.expectEqual(@as(?i64, null), log_processor.parseAtoi("-"));
    try testing.expectEqual(@as(?i64, null), log_processor.parseAtoi("1_0"));
    try testing.expectEqual(@as(?i64, null), log_processor.parseAtoi("0x10"));
    try testing.expectEqual(@as(?i64, null), log_processor.parseAtoi("99999999999999999999"));
}

test "an emit racing shutdown neither crashes nor leaks" {
    var exporter: InMemoryLogExporter = .init(gpa, io);
    defer exporter.deinit();
    var config = log_processor.default_batch_config;
    config.max_export_batch_size = 8;
    const blp = try log_processor.BatchLogProcessor.create(gpa, io, exporter.exporter(), .{ .config = config });
    defer blp.destroy();
    const p = try LoggerProvider.create(gpa, io, .{ .processors = &.{blp.processor()} });
    defer p.destroy();
    const l = p.logger(.{ .name = "t" });

    const Emitter = struct {
        fn run(logger: *const logger_mod.Logger) void {
            for (0..500) |_| logger.emit(.background, .{ .body = .from("x") });
        }
    };
    var group: Io.Group = .init;
    errdefer group.cancel(io);
    for (0..4) |_| try group.concurrent(io, Emitter.run, .{l});
    try p.shutdown(deadline.after(io, .fromSeconds(10)));
    group.await(io) catch {};
    try testing.expect(exporter.count() <= 2000);
}

test "concurrent provider shutdown callers wait for the first and share its result" {
    const BlockingProc = struct {
        entered: Io.Event = .unset,
        release: Io.Event = .unset,

        fn onEmit(_: *anyopaque, _: Context, _: *const LogData) void {}
        fn forceFlush(_: *anyopaque, _: Deadline) processor.ExportError!void {}
        fn shutdown(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            self.entered.set(io);
            self.release.wait(io) catch return error.Canceled;
            return error.ExportFailed;
        }
    };
    var proc: BlockingProc = .{};
    const lp: log_processor.LogProcessor = .{ .ptr = &proc, .vtable = &.{
        .onEmit = BlockingProc.onEmit,
        .forceFlush = BlockingProc.forceFlush,
        .shutdown = BlockingProc.shutdown,
    } };
    const provider = try LoggerProvider.create(gpa, io, .{ .processors = &.{lp} });
    defer provider.destroy();

    const Runner = struct {
        fn call(p: *LoggerProvider) processor.ExportError!void {
            return p.shutdown(deadline.after(io, .fromSeconds(5)));
        }
    };
    var f1 = try io.concurrent(Runner.call, .{provider});
    try proc.entered.wait(io);
    var f2 = try io.concurrent(Runner.call, .{provider});
    try io.sleep(.fromMilliseconds(10), .awake);
    proc.release.set(io);
    try testing.expectError(error.ExportFailed, f1.await(io));
    try testing.expectError(error.ExportFailed, f2.await(io));
}

test "concurrent batch log processor shutdown callers wait for the first to finish" {
    var blocking: BlockingExporter = .{ .inner = .init(gpa, io), .block = true };
    defer blocking.inner.deinit();
    var config = log_processor.default_batch_config;
    config.schedule_delay = .fromSeconds(60);
    config.max_export_batch_size = 1;
    const blp = try log_processor.BatchLogProcessor.create(gpa, io, blocking.exporter(), .{ .config = config });
    defer blp.destroy();
    const p = try LoggerProvider.create(gpa, io, .{ .processors = &.{blp.processor()} });
    defer p.destroy();
    p.logger(.{ .name = "t" }).emit(.background, .{ .body = .from("queued") });
    try blocking.entered.wait(io);

    const Runner = struct {
        fn call(lp: log_processor.LogProcessor) processor.ExportError!void {
            return lp.shutdown(deadline.after(io, .fromSeconds(5)));
        }
    };
    const lp = blp.processor();
    var f1 = try io.concurrent(Runner.call, .{lp});
    try io.sleep(.fromMilliseconds(10), .awake);
    var f2 = try io.concurrent(Runner.call, .{lp});
    try io.sleep(.fromMilliseconds(10), .awake);
    blocking.unblock.set(io);
    try f1.await(io);
    try f2.await(io);
    try testing.expect(blocking.inner.is_shutdown);
    try testing.expectEqual(@as(usize, 1), blocking.inner.count());
}

test "shutdown still shuts down processors when waiting for an emit times out" {
    const HangingEmitProc = struct {
        entered: Io.Event = .unset,
        release: Io.Event = .unset,
        shutdown_called: std.atomic.Value(bool) = .init(false),

        fn onEmit(ptr: *anyopaque, _: Context, _: *const LogData) void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            self.entered.set(io);
            self.release.wait(io) catch {};
        }
        fn forceFlush(_: *anyopaque, _: Deadline) processor.ExportError!void {}
        fn shutdown(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            self.shutdown_called.store(true, .release);
        }
    };
    var hanging: HangingEmitProc = .{};
    var exporter: InMemoryLogExporter = .init(gpa, io);
    defer exporter.deinit();
    var simple: log_processor.SimpleLogProcessor = .init(io, exporter.exporter(), .{});
    const lp1: log_processor.LogProcessor = .{ .ptr = &hanging, .vtable = &.{
        .onEmit = HangingEmitProc.onEmit,
        .forceFlush = HangingEmitProc.forceFlush,
        .shutdown = HangingEmitProc.shutdown,
    } };
    const provider = try LoggerProvider.create(gpa, io, .{ .processors = &.{ lp1, simple.processor() } });
    defer provider.destroy();

    const Emitter = struct {
        fn run(l: *const logger_mod.Logger) void {
            l.emit(.background, .{ .body = .from("hung") });
        }
    };
    var emit_future = try io.concurrent(Emitter.run, .{provider.logger(.{ .name = "t" })});
    try hanging.entered.wait(io);

    try testing.expectError(error.Timeout, provider.shutdown(deadline.after(io, .fromMilliseconds(50))));
    try testing.expect(hanging.shutdown_called.load(.acquire));
    try testing.expect(exporter.is_shutdown);

    hanging.release.set(io);
    emit_future.await(io);
}

test "shutdown waits for an in-flight forceFlush before shutting down processors" {
    const BlockingFlushProc = struct {
        entered_flush: Io.Event = .unset,
        release_flush: Io.Event = .unset,
        flush_done: std.atomic.Value(bool) = .init(false),
        shutdown_saw_flush_done: std.atomic.Value(bool) = .init(false),

        fn onEmit(_: *anyopaque, _: Context, _: *const LogData) void {}
        fn forceFlush(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            self.entered_flush.set(io);
            self.release_flush.wait(io) catch return error.Canceled;
            self.flush_done.store(true, .release);
        }
        fn shutdown(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            self.shutdown_saw_flush_done.store(self.flush_done.load(.acquire), .release);
        }
    };
    var proc: BlockingFlushProc = .{};
    const lp: log_processor.LogProcessor = .{ .ptr = &proc, .vtable = &.{
        .onEmit = BlockingFlushProc.onEmit,
        .forceFlush = BlockingFlushProc.forceFlush,
        .shutdown = BlockingFlushProc.shutdown,
    } };
    const provider = try LoggerProvider.create(gpa, io, .{ .processors = &.{lp} });
    defer provider.destroy();

    const Flusher = struct {
        fn run(p: *LoggerProvider) processor.ExportError!void {
            return p.forceFlush(deadline.after(io, .fromSeconds(5)));
        }
    };
    const Shutdowner = struct {
        fn run(p: *LoggerProvider) processor.ExportError!void {
            return p.shutdown(deadline.after(io, .fromSeconds(5)));
        }
    };
    var flush_future = try io.concurrent(Flusher.run, .{provider});
    try proc.entered_flush.wait(io);
    var shutdown_future = try io.concurrent(Shutdowner.run, .{provider});
    try io.sleep(.fromMilliseconds(20), .awake);
    try testing.expect(!proc.shutdown_saw_flush_done.load(.acquire));
    proc.release_flush.set(io);
    try flush_future.await(io);
    try shutdown_future.await(io);
    try testing.expect(proc.shutdown_saw_flush_done.load(.acquire));
}

test "SimpleLogProcessor forceFlush and shutdown respect deadlines during a slow export" {
    var blocking: BlockingExporter = .{ .inner = .init(gpa, io), .block = true };
    defer blocking.inner.deinit();
    var simple: log_processor.SimpleLogProcessor = .init(io, blocking.exporter(), .{});
    const lp = simple.processor();
    const provider = try LoggerProvider.create(gpa, io, .{ .processors = &.{lp} });
    defer provider.destroy();

    const Emitter = struct {
        fn run(l: *const logger_mod.Logger) void {
            l.emit(.background, .{ .body = .from("slow") });
        }
    };
    var emit_future = try io.concurrent(Emitter.run, .{provider.logger(.{ .name = "t" })});
    try blocking.entered.wait(io);

    const flush_start = deadline.after(io, .zero);
    try testing.expectError(error.Timeout, lp.forceFlush(deadline.after(io, .fromMilliseconds(100))));
    const flush_ms = -deadline.remaining(io, flush_start).toMilliseconds();
    try testing.expect(flush_ms >= 80 and flush_ms < 2000);

    const shut_start = deadline.after(io, .zero);
    try testing.expectError(error.Timeout, lp.shutdown(deadline.after(io, .fromMilliseconds(100))));
    const shut_ms = -deadline.remaining(io, shut_start).toMilliseconds();
    try testing.expect(shut_ms >= 80 and shut_ms < 2000);
    try testing.expect(blocking.inner.is_shutdown);

    blocking.unblock.set(io);
    emit_future.await(io);
    try provider.shutdown(deadline.after(io, .fromSeconds(5)));
}
