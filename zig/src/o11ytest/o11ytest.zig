//! `o11ytest`: hermetic test harness, specification conformance assertions,
//! and in-process OTLP/HTTP and OTLP/gRPC receivers for libo11y Zig.
//!
//! Example:
//! ```zig
//! const rec = try o11ytest.start(std.testing.allocator, std.testing.io, .{});
//! defer rec.deinit();
//!
//! var sp = rec.tracer("svc").start(.background, "checkout", .{});
//! const ctx = o11y.Context.background.withSpan(&sp);
//! rec.logger().info(ctx, "order accepted", .{ .order_id = "ord-1" });
//! sp.end();
//!
//! _ = try rec.expectSpan("checkout");
//! _ = try rec.expectLog("order accepted");
//! try rec.expectCorrelated();
//! try rec.expectConforms();
//! ```

const recorder_mod = @import("recorder.zig");
const http_receiver_mod = @import("http_receiver.zig");
const grpc_receiver_mod = @import("grpc_receiver.zig");

/// Re-exported OTLP protobuf message definitions for inspecting wire payloads.
pub const proto = @import("opentelemetry-proto");

/// Inspection helpers for decoded OTLP protobuf payloads.
pub const inspect = @import("otlp_inspect.zig");

/// Self-signed loopback TLS certificates for testing TLS and mTLS OTLP receivers.
pub const certs = @import("test_certs.zig");

// Hermetic Recorder & assertions.
pub const start = recorder_mod.start;
pub const Recorder = recorder_mod.Recorder;
pub const Options = recorder_mod.Options;
pub const LogRecord = recorder_mod.LogRecord;
pub const Exemplar = recorder_mod.Exemplar;
pub const ConformanceReport = recorder_mod.ConformanceReport;
pub const AssertError = recorder_mod.AssertError;
pub const CollectError = recorder_mod.CollectError;
pub const checkEvent = recorder_mod.checkEvent;

// In-process OTLP/HTTP receiver.
pub const HttpReceiver = http_receiver_mod.HttpReceiver;
pub const HttpReceiverOptions = http_receiver_mod.Options;
pub const HttpReply = http_receiver_mod.Reply;
pub const HttpRequest = http_receiver_mod.Request;
pub const HttpTlsOptions = http_receiver_mod.TlsOptions;
pub const HttpHeader = http_receiver_mod.Header;

// In-process OTLP/gRPC receiver.
pub const GrpcReceiver = grpc_receiver_mod.GrpcReceiver;
pub const GrpcReceiverOptions = grpc_receiver_mod.Options;
pub const GrpcReply = grpc_receiver_mod.Reply;
pub const GrpcRequest = grpc_receiver_mod.Request;
pub const GrpcTlsOptions = grpc_receiver_mod.TlsOptions;
pub const encodeRetryInfoBase64 = grpc_receiver_mod.encodeRetryInfoBase64;

test {
    _ = @import("recorder_test.zig");
    _ = @import("conforms_test.zig");
    _ = @import("exemplar_test.zig");
    _ = @import("hermetic_test.zig");
    _ = @import("receivers_test.zig");
    _ = @import("wire_test.zig");
    _ = @import("parity_test.zig");
}
