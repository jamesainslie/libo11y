//! The OTLP/HTTP metrics exporter: protobuf (the default) or JSON over
//! the shared transport, as otlpmetrichttp does in Go.

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
const json = @import("json.zig");
const trace_exporter = @import("trace_exporter.zig");
const transport = @import("transport.zig");

/// The OTLP/HTTP payload encoding.
pub const Protocol = trace_exporter.Protocol;

/// The OTLP/HTTP default metrics endpoint.
pub const default_endpoint = "http://localhost:4318/v1/metrics";

/// Exporter options. Mapping the `OTEL_EXPORTER_OTLP_*` variables onto
/// them is `env.fromEnv` and `instrument.temporalityPreferenceFromEnv`'s job.
pub const Options = struct {
    protocol: Protocol = .http_protobuf,
    /// The full URL, including `/v1/metrics`.
    endpoint: []const u8 = default_endpoint,
    headers: []const transport.Header = &.{},
    compression: transport.Compression = .none,
    /// Bounds each export, retries included.
    timeout: Io.Duration = .fromSeconds(10),
    tls: transport.TlsOptions = .{},
    retry: transport.RetryOptions = .{},
    /// The temporality preference reported to the periodic reader.
    temporality: instrument.TemporalityPreference = .cumulative,
    /// Receives the detail of each failed export and of partial
    /// successes.
    on_error: processor.ErrorHandler = .ignore,
};

/// Why `MetricExporter.create` failed.
pub const InitError = transport.InitError;

/// Why `MetricExporter.createFromEnv` failed.
pub const FromEnvError = InitError || env_mod.EnvError;

/// Exports collected `ResourceMetrics` with one OTLP/HTTP request each,
/// over one persistent connection that it dials on the first export.
pub const MetricExporter = struct {
    gpa: Allocator,
    io: Io,
    protocol: Protocol,
    temporality: instrument.TemporalityPreference,
    transport: *transport.Transport,
    on_error: processor.ErrorHandler,
    is_shutdown: std.atomic.Value(bool) = .init(false),

    /// Creates the exporter. It loads the TLS files now and dials later.
    pub fn create(gpa: Allocator, io: Io, options: Options) InitError!*MetricExporter {
        const self = try gpa.create(MetricExporter);
        errdefer gpa.destroy(self);
        self.* = .{
            .gpa = gpa,
            .io = io,
            .protocol = options.protocol,
            .temporality = options.temporality,
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

    /// Creates an HTTP metrics exporter from `OTEL_EXPORTER_OTLP_*` and
    /// `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE` in `env`.
    /// Fails with `error.UnsupportedProtocol` when the environment selects
    /// gRPC or an unknown protocol.
    pub fn createFromEnv(gpa: Allocator, io: Io, env: anytype, on_error: processor.ErrorHandler) FromEnvError!*MetricExporter {
        var opts = try env_mod.fromEnv(gpa, env, .metrics);
        defer opts.deinit();
        const protocol: Protocol = switch (opts.protocol) {
            .http_protobuf => .http_protobuf,
            .http_json => .http_json,
            .grpc => return error.UnsupportedProtocol,
        };
        return create(gpa, io, .{
            .protocol = protocol,
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
    pub fn destroy(self: *MetricExporter) void {
        self.transport.destroy();
        self.gpa.destroy(self);
    }

    /// The exporter interface. The exporter must outlive its reader.
    pub fn exporter(self: *MetricExporter) reader_mod.MetricExporter {
        return .{
            .ptr = self,
            .vtable = &.{ .exportMetrics = exportMetrics, .forceFlush = forceFlush, .shutdown = shutdown },
            .temporality = self.temporality,
        };
    }

    /// Encodes one collection as the configured protocol.
    pub fn encodeRequest(protocol: Protocol, arena: Allocator, metrics: *const data.ResourceMetrics, w: *Io.Writer) error{ OutOfMemory, WriteFailed }!void {
        const request = try encode.metricsRequest(arena, metrics);
        switch (protocol) {
            .http_protobuf => request.encode(w, arena) catch |err| switch (err) {
                error.OutOfMemory => return error.OutOfMemory,
                else => return error.WriteFailed,
            },
            .http_json => try json.encode(collector_metrics.ExportMetricsServiceRequest, request, w),
        }
    }

    fn exportMetrics(ptr: *anyopaque, metrics: *const data.ResourceMetrics, deadline: Deadline) processor.ExportError!void {
        const self: *MetricExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.load(.acquire)) return error.Shutdown;
        if (metrics.scope_metrics.len == 0) return;

        var arena_state: std.heap.ArenaAllocator = .init(self.gpa);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        var body: Io.Writer.Allocating = .init(arena);
        encodeRequest(self.protocol, arena, metrics, &body.writer) catch {
            self.on_error.handle("otlp metric exporter", error.ExportFailed, "encoding the export request failed");
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
            self.on_error.handle("otlp metric exporter", mapped, err_buf[0..err_len]);
            return mapped;
        };
        defer response.deinit(self.gpa);
        return self.checkPartialSuccess(arena, response.content_type, response.body);
    }

    /// Reports a partial success, as Go joins it into the export error.
    /// The response Content-Type picks the decoder, a body of another
    /// type is ignored, and a body that does not decode fails the export.
    fn checkPartialSuccess(self: *MetricExporter, arena: Allocator, content_type: []const u8, body: []const u8) processor.ExportError!void {
        if (body.len == 0) return;
        const media = std.mem.trim(u8, content_type[0 .. std.mem.indexOfScalar(u8, content_type, ';') orelse content_type.len], " ");
        const decoded: collector_metrics.ExportMetricsServiceResponse = if (std.ascii.eqlIgnoreCase(media, "application/x-protobuf")) blk: {
            var reader: Io.Reader = .fixed(body);
            break :blk collector_metrics.ExportMetricsServiceResponse.decode(&reader, arena) catch return self.badResponse();
        } else if (std.ascii.eqlIgnoreCase(media, "application/json"))
            json.decode(collector_metrics.ExportMetricsServiceResponse, arena, body) catch return self.badResponse()
        else
            return;
        const partial = decoded.partial_success orelse return;
        if (partial.rejected_data_points == 0 and partial.error_message.len == 0) return;
        var buf: [512]u8 = undefined;
        const detail = std.fmt.bufPrint(&buf, "OTLP partial success: {s} ({d} data points rejected)", .{
            partial.error_message[0..@min(partial.error_message.len, 400)],
            partial.rejected_data_points,
        }) catch "OTLP partial success";
        self.on_error.handle("otlp metric exporter", error.ExportFailed, detail);
        return error.ExportFailed;
    }

    fn badResponse(self: *MetricExporter) processor.ExportError {
        self.on_error.handle("otlp metric exporter", error.ExportFailed, "decoding the export response failed");
        return error.ExportFailed;
    }

    fn forceFlush(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
        const self: *MetricExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.load(.acquire)) return error.Shutdown;
    }

    fn shutdown(ptr: *anyopaque, _: Deadline) processor.ExportError!void {
        const self: *MetricExporter = @ptrCast(@alignCast(ptr));
        if (self.is_shutdown.swap(true, .acq_rel)) return;
        self.transport.close();
    }
};

test {
    _ = @import("metric_exporter_test.zig");
}
