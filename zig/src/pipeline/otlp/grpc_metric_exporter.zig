//! The OTLP/gRPC metrics exporter: encodes collected `ResourceMetrics` as
//! protobuf and sends them over `grpc.Transport` to
//! `/opentelemetry.proto.collector.metrics.v1.MetricsService/Export`,
//! reporting partial successes as export errors just like `MetricExporter`.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const proto = @import("opentelemetry-proto");
const collector_metrics = proto.collector_metrics_v1;
const Deadline = @import("../deadline.zig").Deadline;
const data = @import("../metric/data.zig");
const instrument = @import("../metric/instrument.zig");
const reader_mod = @import("../metric/reader.zig");
const processor = @import("../processor.zig");
const encode = @import("encode.zig");
const env_mod = @import("env.zig");
const grpc = @import("grpc.zig");

/// The OTLP/gRPC default endpoint.
pub const default_endpoint = "http://localhost:4317";

/// The gRPC method path for OTLP metrics.
pub const method = "/opentelemetry.proto.collector.metrics.v1.MetricsService/Export";

const component = "otlp grpc metric exporter";

/// Exporter options. Mapping `OTEL_EXPORTER_OTLP_*` variables onto them is
/// `env.fromEnv` and `instrument.temporalityPreferenceFromEnv`'s job.
pub const Options = struct {
    /// Absolute `http://host:port` (h2c) or `https://host:port` (TLS ALPN h2).
    endpoint: []const u8 = default_endpoint,
    headers: []const grpc.Header = &.{},
    compression: grpc.Compression = .none,
    /// Bounds each export, retries included.
    timeout: Io.Duration = .fromSeconds(10),
    tls: grpc.TlsOptions = .{},
    retry: grpc.RetryOptions = .{},
    /// The temporality preference reported to the periodic reader.
    temporality: instrument.TemporalityPreference = .cumulative,
    /// Receives the detail of each failed export and of partial successes.
    on_error: processor.ErrorHandler = .ignore,
};

/// Why `GrpcMetricExporter.create` failed.
pub const InitError = grpc.InitError;

/// Why `GrpcMetricExporter.createFromEnv` failed.
pub const FromEnvError = InitError || env_mod.EnvError;

/// Exports collected `ResourceMetrics` via OTLP/gRPC over one lazily dialed,
/// persistent HTTP/2 connection.
pub const GrpcMetricExporter = struct {
    gpa: Allocator,
    io: Io,
    temporality: instrument.TemporalityPreference,
    transport: *grpc.Transport,
    on_error: processor.ErrorHandler,
    is_shutdown: std.atomic.Value(bool) = .init(false),

    /// Creates the exporter. Loads TLS files now and dials on the first export.
    pub fn create(gpa: Allocator, io: Io, options: Options) InitError!*GrpcMetricExporter {
        const self = try gpa.create(GrpcMetricExporter);
        errdefer gpa.destroy(self);
        self.* = .{
            .gpa = gpa,
            .io = io,
            .temporality = options.temporality,
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

    /// Creates a gRPC metrics exporter from `OTEL_EXPORTER_OTLP_*` and
    /// `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` in `env`.
    /// Fails with `error.UnsupportedProtocol` when the environment selects a
    /// non-gRPC protocol.
    pub fn createFromEnv(gpa: Allocator, io: Io, env: anytype, on_error: processor.ErrorHandler) FromEnvError!*GrpcMetricExporter {
        var opts = try env_mod.fromEnv(gpa, env, .metrics);
        defer opts.deinit();
        if (opts.protocol != .grpc) return error.UnsupportedProtocol;
        return create(gpa, io, .{
            .endpoint = opts.endpoint,
            .headers = opts.headers,
            .compression = opts.compression,
            .timeout = opts.timeout,
            .tls = opts.tls,
            .temporality = instrument.temporalityPreferenceFromEnv(env) orelse .cumulative,
            .on_error = on_error,
        });
    }

    /// Frees the exporter. Shut its reader down first.
    pub fn destroy(self: *GrpcMetricExporter) void {
        self.transport.destroy();
        self.gpa.destroy(self);
    }

    /// The `MetricExporter` interface. The exporter must outlive its reader.
    pub fn exporter(self: *GrpcMetricExporter) reader_mod.MetricExporter {
        return .{
            .ptr = self,
            .vtable = &.{ .exportMetrics = exportMetrics, .forceFlush = forceFlush, .shutdown = shutdown },
            .temporality = self.temporality,
        };
    }

    fn exportMetrics(ptr: *anyopaque, metrics: *const data.ResourceMetrics, dl: Deadline) processor.ExportError!void {
        const self: *GrpcMetricExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.load(.acquire)) return error.Shutdown;
        if (metrics.scope_metrics.len == 0) return;

        var arena_state: std.heap.ArenaAllocator = .init(self.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();

        var body: Io.Writer.Allocating = .init(arena);
        const request = encode.metricsRequest(arena, metrics) catch {
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

    fn checkPartialSuccess(self: *GrpcMetricExporter, arena: Allocator, body: []const u8) processor.ExportError!void {
        if (body.len == 0) return;
        var reader: Io.Reader = .fixed(body);
        const decoded = collector_metrics.ExportMetricsServiceResponse.decode(&reader, arena) catch {
            self.on_error.handle(component, error.ExportFailed, "decoding the export response failed");
            return error.ExportFailed;
        };
        const partial = decoded.partial_success orelse return;
        if (partial.rejected_data_points == 0 and partial.error_message.len == 0) return;
        var buf: [512]u8 = undefined;
        const detail = std.fmt.bufPrint(&buf, "OTLP partial success: {s} ({d} data points rejected)", .{
            partial.error_message[0..@min(partial.error_message.len, 400)],
            partial.rejected_data_points,
        }) catch "OTLP partial success";
        self.on_error.handle(component, error.ExportFailed, detail);
        return error.ExportFailed;
    }

    fn forceFlush(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
        const self: *GrpcMetricExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.load(.acquire)) return error.Shutdown;
    }

    fn shutdown(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
        const self: *GrpcMetricExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.swap(true, .acq_rel)) return;
        self.transport.close();
    }
};

test {
    _ = @import("grpc_metric_exporter_test.zig");
}
