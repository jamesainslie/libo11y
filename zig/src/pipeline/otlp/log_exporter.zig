//! The OTLP/HTTP log exporter: protobuf (the default) or JSON to
//! `/v1/logs` over the shared transport, as otlploghttp does in Go.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const proto = @import("opentelemetry-proto");
const collector_logs = proto.collector_logs_v1;
const Deadline = @import("../deadline.zig").Deadline;
const processor = @import("../processor.zig");
const log_processor = @import("../log_processor.zig");
const LogData = @import("../log_record.zig").LogData;
const json = @import("json.zig");
const log_encode = @import("log_encode.zig");
const trace_exporter = @import("trace_exporter.zig");
const transport = @import("transport.zig");

/// The OTLP/HTTP payload encoding, shared with the trace exporter.
pub const Protocol = trace_exporter.Protocol;

/// The OTLP/HTTP default logs endpoint.
pub const default_endpoint = "http://localhost:4318/v1/logs";

const component = "otlp log exporter";

/// Exporter options. Mapping the `OTEL_EXPORTER_OTLP_*` variables onto
/// them is `env.fromEnv(gpa, env, .logs)`'s job.
pub const Options = struct {
    protocol: Protocol = .http_protobuf,
    /// The full URL, including `/v1/logs`.
    endpoint: []const u8 = default_endpoint,
    headers: []const transport.Header = &.{},
    compression: transport.Compression = .none,
    /// Bounds each export, retries included.
    timeout: Io.Duration = .fromSeconds(10),
    tls: transport.TlsOptions = .{},
    retry: transport.RetryOptions = .{},
    /// Receives the detail of each failed export and of partial
    /// successes.
    on_error: processor.ErrorHandler = .ignore,
};

/// Why `LogExporter.create` failed.
pub const InitError = transport.InitError;

/// Exports log batches with one OTLP/HTTP request each, over one
/// persistent connection that it dials on the first export.
pub const LogExporter = struct {
    gpa: Allocator,
    io: Io,
    protocol: Protocol,
    transport: *transport.Transport,
    on_error: processor.ErrorHandler,
    is_shutdown: std.atomic.Value(bool) = .init(false),

    /// Creates the exporter. It loads the TLS files now and dials later.
    pub fn create(gpa: Allocator, io: Io, options: Options) InitError!*LogExporter {
        const self = try gpa.create(LogExporter);
        errdefer gpa.destroy(self);
        self.* = .{
            .gpa = gpa,
            .io = io,
            .protocol = options.protocol,
            .on_error = options.on_error,
            .transport = try .create(gpa, io, .{
                .endpoint = options.endpoint,
                .content_type = options.protocol.contentType(),
                .headers = options.headers,
                .compression = options.compression,
                .timeout = options.timeout,
                .tls = options.tls,
                .retry = options.retry,
            }),
        };
        return self;
    }

    /// Frees the exporter. Shut its processor down first.
    pub fn destroy(self: *LogExporter) void {
        self.transport.destroy();
        self.gpa.destroy(self);
    }

    /// The exporter interface. The exporter must outlive its processor.
    pub fn exporter(self: *LogExporter) log_processor.LogExporter {
        return .{ .ptr = self, .vtable = &.{ .exportLogs = exportLogs, .forceFlush = forceFlush, .shutdown = shutdown } };
    }

    /// Encodes a batch as the configured protocol.
    pub fn encodeRequest(protocol: Protocol, arena: Allocator, records: []const *const LogData, w: *Io.Writer) error{ OutOfMemory, WriteFailed }!void {
        const request = try log_encode.logsRequest(arena, records);
        switch (protocol) {
            .http_protobuf => request.encode(w, arena) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => return error.WriteFailed,
            },
            .http_json => try json.encode(collector_logs.ExportLogsServiceRequest, request, w),
        }
    }

    fn exportLogs(ptr: *anyopaque, records: []const *const LogData, deadline: Deadline) processor.ExportError!void {
        const self: *LogExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.load(.acquire)) return error.Shutdown;
        if (records.len == 0) return;

        var arena_state: std.heap.ArenaAllocator = .init(self.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        var body: Io.Writer.Allocating = .init(arena);
        encodeRequest(self.protocol, arena, records, &body.writer) catch {
            self.on_error.handle(component, error.ExportFailed, "encoding the export request failed");
            return error.ExportFailed;
        };

        var err_buf: [512]u8 = undefined;
        var err_len: usize = 0;
        var response = self.transport.sendDetail(body.written(), deadline, &err_buf, &err_len) catch |err| {
            const mapped: processor.ExportError = switch (err) {
                error.Timeout => error.Timeout,
                error.Shutdown => error.Shutdown,
                error.Canceled => error.Canceled,
                error.Rejected, error.Unreachable, error.OutOfMemory => error.ExportFailed,
            };
            self.on_error.handle(component, mapped, err_buf[0..err_len]);
            return mapped;
        };
        defer response.deinit(self.gpa);
        return self.checkPartialSuccess(arena, response.content_type, response.body);
    }

    /// Reports a partial success, as Go joins it into the export error.
    /// As in Go, the response Content-Type picks the decoder, a body of
    /// another type is ignored, and a body that does not decode fails the
    /// export.
    fn checkPartialSuccess(self: *LogExporter, arena: Allocator, content_type: []const u8, body: []const u8) processor.ExportError!void {
        if (body.len == 0) return;
        const media = std.mem.trim(u8, content_type[0 .. std.mem.indexOfScalar(u8, content_type, ';') orelse content_type.len], " ");
        const decoded: collector_logs.ExportLogsServiceResponse = if (std.ascii.eqlIgnoreCase(media, "application/x-protobuf")) blk: {
            var reader: Io.Reader = .fixed(body);
            break :blk collector_logs.ExportLogsServiceResponse.decode(&reader, arena) catch return self.badResponse();
        } else if (std.ascii.eqlIgnoreCase(media, "application/json"))
            json.decode(collector_logs.ExportLogsServiceResponse, arena, body) catch return self.badResponse()
        else
            return;
        const partial = decoded.partial_success orelse return;
        if (partial.rejected_log_records == 0 and partial.error_message.len == 0) return;
        var buf: [512]u8 = undefined;
        const detail = std.fmt.bufPrint(&buf, "OTLP partial success: {s} ({d} log records rejected)", .{
            partial.error_message[0..@min(partial.error_message.len, 400)],
            partial.rejected_log_records,
        }) catch "OTLP partial success";
        self.on_error.handle(component, error.ExportFailed, detail);
        return error.ExportFailed;
    }

    fn badResponse(self: *LogExporter) processor.ExportError {
        self.on_error.handle(component, error.ExportFailed, "decoding the export response failed");
        return error.ExportFailed;
    }

    /// Nothing is buffered between exports, so a flush has nothing to do.
    fn forceFlush(_: *anyopaque, _: Deadline) processor.ExportError!void {}

    fn shutdown(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
        const self: *LogExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.swap(true, .acq_rel)) return;
        self.transport.close();
    }
};

test {
    _ = @import("log_exporter_test.zig");
}
