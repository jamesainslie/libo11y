//! The tracer provider and its tracers, as the OTel Go SDK builds them
//! (sdk/trace/provider.go and tracer.go).

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Context = @import("../context.zig").Context;
const attribute = @import("attribute.zig");
const deadline_mod = @import("deadline.zig");
const Deadline = deadline_mod.Deadline;
const ids = @import("ids.zig");
const policy_mod = @import("policy.zig");
const processor = @import("processor.zig");
const resource_mod = @import("resource.zig");
const sampler_mod = @import("sampler.zig");
const span_mod = @import("span.zig");
const Span = span_mod.Span;
const SpanData = span_mod.SpanData;

/// Options for `Tracer.start`.
pub const StartOptions = struct {
    kind: span_mod.SpanKind = .internal,
    attributes: []const attribute.KeyValue = &.{},
    links: []const span_mod.Link = &.{},
    /// Unix nanoseconds; now when null.
    start_time: ?u64 = null,
    /// Ignore the span in the context and start a new trace.
    new_root: bool = false,
};

/// Creates spans for one instrumentation scope.
pub const Tracer = struct {
    /// Null for the no-op tracer.
    provider: ?*TracerProvider,
    scope: resource_mod.InstrumentationScope,

    /// A tracer whose spans record nothing and carry no span context.
    pub const noop: Tracer = .{ .provider = null, .scope = .{ .name = "" } };

    /// Starts a span as a child of the span context in `ctx`, unless
    /// `options.new_root` is set. The sampler decides whether it records;
    /// a span it drops still gets ids, so propagation continues, but
    /// records nothing. Never fails: when memory runs out, or after the
    /// provider has shut down, it returns a no-op span.
    pub fn start(tracer: *const Tracer, ctx: Context, name: []const u8, options: StartOptions) Span {
        const provider = tracer.provider orelse return .noop;
        if (provider.is_shutdown.load(.acquire)) return .noop;

        const parent: ids.SpanContext = if (options.new_root) .invalid else ctx.span_context;
        const parent_ctx = if (options.new_root) ctx.withSpanContext(.invalid) else ctx;
        const trace_id = if (parent.isValid()) parent.trace_id else provider.id_generator.traceId();
        const result = provider.sampler.shouldSample(.{
            .parent = parent_ctx,
            .trace_id = trace_id,
            .name = name,
            .kind = options.kind,
            .attributes = options.attributes,
            .links = options.links,
        });

        var flags = parent.flags;
        flags.sampled = result.decision == .record_and_sample;
        const sc: ids.SpanContext = .{
            .trace_id = trace_id,
            .span_id = provider.id_generator.spanId(),
            .flags = flags,
            .trace_state = result.trace_state,
        };
        const recording = result.decision != .drop;
        const start_time = options.start_time orelse span_mod.nowUnixNano(provider.io);
        const data = SpanData.create(tracer, provider.gpa, provider.io, recording, sc, parent, options.kind, name, start_time) orelse
            return .{ .span_context = .{ .trace_id = sc.trace_id, .span_id = sc.span_id, .flags = sc.flags } };
        if (recording) {
            data.initRecording(&.{ options.attributes, result.attributes }, options.links);
            for (provider.processors) |p| p.onStart(parent_ctx, data);
        }
        return .{ .span_context = data.span_context, .data = data };
    }
};

/// Owns the tracers, the sampler, the span limits, the processors and the
/// attribute policy hook.
pub const TracerProvider = struct {
    gpa: Allocator,
    io: Io,
    resource: resource_mod.Resource,
    sampler: sampler_mod.Sampler,
    limits: span_mod.Limits,
    processors: []const processor.SpanProcessor,
    policy: policy_mod.AttributePolicy,
    id_generator: ids.IdGenerator,
    mutex: Io.Mutex = .init,
    tracers: std.ArrayList(*Tracer) = .empty,
    is_shutdown: std.atomic.Value(bool) = .init(false),
    shutdown_result: ?processor.ExportError = null,

    pub const Options = struct {
        /// Borrowed: it must outlive the provider.
        resource: resource_mod.Resource = .empty,
        sampler: sampler_mod.Sampler = .default,
        limits: span_mod.Limits = .{},
        /// Copied; the processors themselves must outlive the provider.
        processors: []const processor.SpanProcessor = &.{},
        policy: policy_mod.AttributePolicy = .noop,
    };

    /// Creates a provider.
    pub fn create(gpa: Allocator, io: Io, options: Options) Allocator.Error!*TracerProvider {
        const p = try gpa.create(TracerProvider);
        errdefer gpa.destroy(p);
        p.* = .{
            .gpa = gpa,
            .io = io,
            .resource = options.resource,
            .sampler = options.sampler,
            .limits = options.limits,
            .processors = try gpa.dupe(processor.SpanProcessor, options.processors),
            .policy = options.policy,
            .id_generator = .{ .io = io },
        };
        return p;
    }

    /// Frees the provider and its tracers. Shut it down first, so the
    /// processors have released every span. Spans must not outlive it.
    pub fn destroy(p: *TracerProvider) void {
        const gpa = p.gpa;
        for (p.tracers.items) |t| {
            gpa.free(t.scope.name);
            gpa.free(t.scope.version);
            gpa.free(t.scope.schema_url);
            gpa.destroy(t);
        }
        p.tracers.deinit(gpa);
        gpa.free(p.processors);
        gpa.destroy(p);
    }

    /// Returns the tracer for a scope, creating it on first use. Tracers
    /// with the same name, version and schema URL are the same tracer.
    /// The scope's attributes are not copied and must outlive the
    /// provider. Returns the no-op tracer when out of memory.
    pub fn tracer(p: *TracerProvider, scope: resource_mod.InstrumentationScope) *const Tracer {
        p.mutex.lockUncancelable(p.io);
        defer p.mutex.unlock(p.io);
        for (p.tracers.items) |t| {
            if (std.mem.eql(u8, t.scope.name, scope.name) and
                std.mem.eql(u8, t.scope.version, scope.version) and
                std.mem.eql(u8, t.scope.schema_url, scope.schema_url)) return t;
        }
        return p.addTracer(scope) catch &Tracer.noop;
    }

    fn addTracer(p: *TracerProvider, scope: resource_mod.InstrumentationScope) Allocator.Error!*Tracer {
        const gpa = p.gpa;
        const t = try gpa.create(Tracer);
        errdefer gpa.destroy(t);
        const name = try gpa.dupe(u8, scope.name);
        errdefer gpa.free(name);
        const version = try gpa.dupe(u8, scope.version);
        errdefer gpa.free(version);
        const schema_url = try gpa.dupe(u8, scope.schema_url);
        errdefer gpa.free(schema_url);
        t.* = .{ .provider = p, .scope = .{ .name = name, .version = version, .schema_url = schema_url, .attributes = scope.attributes } };
        try p.tracers.append(gpa, t);
        return t;
    }

    /// Flushes every processor in order, under one deadline, and returns
    /// the first error.
    pub fn forceFlush(p: *TracerProvider, deadline: Deadline) processor.ExportError!void {
        var first: ?processor.ExportError = null;
        for (p.processors) |sp| {
            sp.forceFlush(deadline) catch |err| {
                if (first == null) first = err;
            };
        }
        if (first) |err| return err;
    }

    /// Shuts every processor down in order, under one deadline. Later
    /// spans are no-ops. A second call returns the first call's result.
    pub fn shutdown(p: *TracerProvider, deadline: Deadline) processor.ExportError!void {
        if (p.is_shutdown.swap(true, .acq_rel)) {
            if (p.shutdown_result) |err| return err;
            return;
        }
        var first: ?processor.ExportError = null;
        for (p.processors) |sp| {
            sp.shutdown(deadline) catch |err| {
                if (first == null) first = err;
            };
        }
        p.shutdown_result = first;
        if (first) |err| return err;
    }
};

test {
    _ = deadline_mod;
}
