//! The OTLP/gRPC trace exporter: encodes span batches as protobuf and sends
//! them over `grpc.Transport` to
//! `/opentelemetry.proto.collector.trace.v1.TraceService/Export`, reporting
//! partial successes as export errors just like `TraceExporter`.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const proto = @import("opentelemetry-proto");
const collector_trace = proto.collector_trace_v1;
const Deadline = @import("../deadline.zig").Deadline;
const processor = @import("../processor.zig");
const SpanData = @import("../span.zig").SpanData;
const encode = @import("encode.zig");
const env_mod = @import("env.zig");
const grpc = @import("grpc.zig");

/// The OTLP/gRPC default endpoint.
pub const default_endpoint = "http://localhost:4317";

/// The gRPC method path for OTLP traces.
pub const method = "/opentelemetry.proto.collector.trace.v1.TraceService/Export";

const component = "otlp grpc trace exporter";

/// Exporter options. Mapping `OTEL_EXPORTER_OTLP_*` variables onto them is
/// `env.fromEnv`'s job.
pub const Options = struct {
    /// Absolute `http://host:port` (h2c) or `https://host:port` (TLS ALPN h2).
    endpoint: []const u8 = default_endpoint,
    headers: []const grpc.Header = &.{},
    compression: grpc.Compression = .none,
    /// Bounds each export, retries included.
    timeout: Io.Duration = .fromSeconds(10),
    tls: grpc.TlsOptions = .{},
    retry: grpc.RetryOptions = .{},
    /// Receives the detail of each failed export and of partial successes.
    on_error: processor.ErrorHandler = .ignore,
};

/// Why `GrpcTraceExporter.create` failed.
pub const InitError = grpc.InitError;

/// Why `GrpcTraceExporter.createFromEnv` failed.
pub const FromEnvError = InitError || env_mod.EnvError;

/// Exports span batches via OTLP/gRPC over one lazily dialed, persistent
/// HTTP/2 connection.
pub const GrpcTraceExporter = struct {
    gpa: Allocator,
    io: Io,
    transport: *grpc.Transport,
    on_error: processor.ErrorHandler,
    is_shutdown: std.atomic.Value(bool) = .init(false),

    /// Creates the exporter. Loads TLS files now and dials on the first export.
    pub fn create(gpa: Allocator, io: Io, options: Options) InitError!*GrpcTraceExporter {
        const self = try gpa.create(GrpcTraceExporter);
        errdefer gpa.destroy(self);
        self.* = .{
            .gpa = gpa,
            .io = io,
            .on_error = options.on_error,
            .transport = try .create(gpa, io, .{
                .endpoint = options.endpoint,
                .method = method,
                .headers = options.headers,
                .compression = options.compression,
                .timeout = options.timeout,
                .tls = options.tls,
                .retry = options.retry,
            }),
        };
        return self;
    }

    /// Creates a gRPC trace exporter from `OTEL_EXPORTER_OTLP_*` variables in
    /// `env`. Fails with `error.UnsupportedProtocol` when the environment
    /// selects a non-gRPC protocol.
    pub fn createFromEnv(gpa: Allocator, io: Io, env: anytype, on_error: processor.ErrorHandler) FromEnvError!*GrpcTraceExporter {
        var opts = try env_mod.fromEnv(gpa, env, .traces);
        defer opts.deinit();
        if (opts.protocol != .grpc) return error.UnsupportedProtocol;
        return create(gpa, io, .{
            .endpoint = opts.endpoint,
            .headers = opts.headers,
            .compression = opts.compression,
            .timeout = opts.timeout,
            .tls = opts.tls,
            .on_error = on_error,
        });
    }

    /// Frees the exporter. Shut its processor down first.
    pub fn destroy(self: *GrpcTraceExporter) void {
        self.transport.destroy();
        self.gpa.destroy(self);
    }

    /// The `SpanExporter` interface. The exporter must outlive its processor.
    pub fn exporter(self: *GrpcTraceExporter) processor.SpanExporter {
        return .{ .ptr = self, .vtable = &.{ .exportSpans = exportSpans, .shutdown = shutdown } };
    }

    fn exportSpans(ptr: *anyopaque, spans: []const *const SpanData, dl: Deadline) processor.ExportError!void {
        const self: *GrpcTraceExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.load(.acquire)) return error.Shutdown;
        if (spans.len == 0) return;

        var arena_state: std.heap.ArenaAllocator = .init(self.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        var body: Io.Writer.Allocating = .init(arena);
        const request = encode.traceRequest(arena, spans) catch {
            self.on_error.handle(component, error.ExportFailed, "encoding the export request failed");
            return error.ExportFailed;
        };
        request.encode(&body.writer, arena) catch {
            self.on_error.handle(component, error.ExportFailed, "encoding the export request failed");
            return error.ExportFailed;
        };

        var err_buf: [512]u8 = undefined;
        var err_len: usize = 0;
        var response = self.transport.sendDetail(body.written(), dl, &err_buf, &err_len) catch |err| {
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

        return self.checkPartialSuccess(arena, response.body);
    }

    fn checkPartialSuccess(self: *GrpcTraceExporter, arena: Allocator, body: []const u8) processor.ExportError!void {
        if (body.len == 0) return;
        var reader: Io.Reader = .fixed(body);
        const decoded = collector_trace.ExportTraceServiceResponse.decode(&reader, arena) catch {
            self.on_error.handle(component, error.ExportFailed, "decoding the export response failed");
            return error.ExportFailed;
        };
        const partial = decoded.partial_success orelse return;
        if (partial.rejected_spans == 0 and partial.error_message.len == 0) return;
        var buf: [512]u8 = undefined;
        const detail = std.fmt.bufPrint(&buf, "OTLP partial success: {s} ({d} spans rejected)", .{
            partial.error_message[0..@min(partial.error_message.len, 400)],
            partial.rejected_spans,
        }) catch "OTLP partial success";
        self.on_error.handle(component, error.ExportFailed, detail);
        return error.ExportFailed;
    }

    fn shutdown(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
        const self: *GrpcTraceExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.swap(true, .acq_rel)) return;
        self.transport.close();
    }
};

test {
    _ = @import("grpc_trace_exporter_test.zig");
}
