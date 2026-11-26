//! The OTLP/HTTP trace exporter: protobuf (the default) or JSON over the
//! shared transport, as otlptracehttp does in Go.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const proto = @import("opentelemetry-proto");
const collector_trace = proto.collector_trace_v1;
const Deadline = @import("../deadline.zig").Deadline;
const processor = @import("../processor.zig");
const SpanData = @import("../span.zig").SpanData;
const encode = @import("encode.zig");
const json = @import("json.zig");
const transport = @import("transport.zig");

/// The OTLP/HTTP payload encoding.
pub const Protocol = enum {
    /// `application/x-protobuf`, the default.
    http_protobuf,
    /// `application/json`, with the OTLP/JSON mapping.
    http_json,

    /// The request Content-Type.
    pub fn contentType(p: Protocol) []const u8 {
        return switch (p) {
            .http_protobuf => "application/x-protobuf",
            .http_json => "application/json",
        };
    }
};

/// The OTLP/HTTP default traces endpoint.
pub const default_endpoint = "http://localhost:4318/v1/traces";

/// Exporter options. Mapping the `OTEL_EXPORTER_OTLP_*` variables onto
/// them is `env.fromEnv`'s job.
pub const Options = struct {
    protocol: Protocol = .http_protobuf,
    /// The full URL, including `/v1/traces`.
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

/// Why `TraceExporter.create` failed.
pub const InitError = transport.InitError;

/// Exports span batches with one OTLP/HTTP request each, over one
/// persistent connection that it dials on the first export.
pub const TraceExporter = struct {
    gpa: Allocator,
    io: Io,
    protocol: Protocol,
    transport: *transport.Transport,
    on_error: processor.ErrorHandler,
    is_shutdown: std.atomic.Value(bool) = .init(false),

    /// Creates the exporter. It loads the TLS files now and dials later.
    pub fn create(gpa: Allocator, io: Io, options: Options) InitError!*TraceExporter {
        const self = try gpa.create(TraceExporter);
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
    pub fn destroy(self: *TraceExporter) void {
        self.transport.destroy();
        self.gpa.destroy(self);
    }

    /// The exporter interface. The exporter must outlive its processor.
    pub fn exporter(self: *TraceExporter) processor.SpanExporter {
        return .{ .ptr = self, .vtable = &.{ .exportSpans = exportSpans, .shutdown = shutdown } };
    }

    /// Encodes a batch as the configured protocol.
    pub fn encodeRequest(protocol: Protocol, arena: Allocator, spans: []const *const SpanData, w: *Io.Writer) error{ OutOfMemory, WriteFailed }!void {
        const request = try encode.traceRequest(arena, spans);
        switch (protocol) {
            .http_protobuf => request.encode(w, arena) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => return error.WriteFailed,
            },
            .http_json => try json.encode(collector_trace.ExportTraceServiceRequest, request, w),
        }
    }

    fn exportSpans(ptr: *anyopaque, spans: []const *const SpanData, deadline: Deadline) processor.ExportError!void {
        const self: *TraceExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.load(.acquire)) return error.Shutdown;
        if (spans.len == 0) return;

        var arena_state: std.heap.ArenaAllocator = .init(self.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        var body: Io.Writer.Allocating = .init(arena);
        encodeRequest(self.protocol, arena, spans, &body.writer) catch {
            self.on_error.handle("otlp trace exporter", error.ExportFailed, "encoding the export request failed");
            return error.ExportFailed;
        };

        var response = self.transport.send(body.written(), deadline) catch |err| {
            const mapped: processor.ExportError = switch (err) {
                error.Timeout => error.Timeout,
                error.Shutdown => error.Shutdown,
                error.Canceled => error.Canceled,
                error.Rejected, error.Unreachable, error.OutOfMemory => error.ExportFailed,
            };
            self.on_error.handle("otlp trace exporter", mapped, self.transport.lastError());
            return mapped;
        };
        defer response.deinit(self.gpa);
        return self.checkPartialSuccess(arena, response.content_type, response.body);
    }

    /// Reports a partial success, as Go joins it into the export error.
    /// As in Go, the response Content-Type picks the decoder, a body of
    /// another type is ignored, and a body that does not decode fails the
    /// export.
    fn checkPartialSuccess(self: *TraceExporter, arena: Allocator, content_type: []const u8, body: []const u8) processor.ExportError!void {
        if (body.len == 0) return;
        const media = std.mem.trim(u8, content_type[0 .. std.mem.indexOfScalar(u8, content_type, ';') orelse content_type.len], " ");
        const decoded: collector_trace.ExportTraceServiceResponse = if (std.ascii.eqlIgnoreCase(media, "application/x-protobuf")) blk: {
            var reader: Io.Reader = .fixed(body);
            break :blk collector_trace.ExportTraceServiceResponse.decode(&reader, arena) catch return self.badResponse();
        } else if (std.ascii.eqlIgnoreCase(media, "application/json"))
            json.decode(collector_trace.ExportTraceServiceResponse, arena, body) catch return self.badResponse()
        else
            return;
        const partial = decoded.partial_success orelse return;
        if (partial.rejected_spans == 0 and partial.error_message.len == 0) return;
        var buf: [512]u8 = undefined;
        const detail = std.fmt.bufPrint(&buf, "OTLP partial success: {s} ({d} spans rejected)", .{
            partial.error_message[0..@min(partial.error_message.len, 400)],
            partial.rejected_spans,
        }) catch "OTLP partial success";
        self.on_error.handle("otlp trace exporter", error.ExportFailed, detail);
        return error.ExportFailed;
    }

    fn badResponse(self: *TraceExporter) processor.ExportError {
        self.on_error.handle("otlp trace exporter", error.ExportFailed, "decoding the export response failed");
        return error.ExportFailed;
    }

    fn shutdown(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
        const self: *TraceExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.swap(true, .acq_rel)) return;
        self.transport.close();
    }
};

test {
    _ = @import("trace_exporter_test.zig");
}
