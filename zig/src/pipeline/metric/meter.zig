//! The meter provider, its meters and their instruments, as the OTel Go
//! SDK builds them (sdk/metric provider.go, meter.go, instrument.go and
//! pipeline.go).
//!
//! The provider keeps one pipeline per reader. Creating an instrument
//! resolves the views into streams for every pipeline. Recording a
//! measurement copies and canonicalizes its attributes, runs the policy
//! hook over them once, and hands the classified set to each stream, so
//! every stream and exemplar sees classified attributes.
//!
//! Instrument handles are small values. Recording never fails and
//! returns nothing: a measurement that cannot be stored is dropped.
//!
//! Callbacks run during a collection while the provider's lock is held.
//! A callback must not create instruments or register or unregister
//! callbacks.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const Context = @import("../../context.zig").Context;
const attribute = @import("../attribute.zig");
const KeyValue = attribute.KeyValue;
const deadline_mod = @import("../deadline.zig");
const Deadline = deadline_mod.Deadline;
const policy_mod = @import("../policy.zig");
const processor = @import("../processor.zig");
const ExportError = processor.ExportError;
const resource_mod = @import("../resource.zig");
const span_mod = @import("../span.zig");
const aggregate = @import("aggregate.zig");
const attrset = @import("attrset.zig");
const data = @import("data.zig");
const exemplar = @import("exemplar.zig");
const instrument = @import("instrument.zig");
const InstrumentKind = instrument.InstrumentKind;
const reader_mod = @import("reader.zig");
const view_mod = @import("view.zig");
const View = view_mod.View;

/// The default cardinality limit per stream.
pub const default_cardinality_limit: usize = 2000;

/// Options shared by every instrument.
pub const InstrumentOptions = struct {
    description: []const u8 = "",
    unit: []const u8 = "",
};

/// Options for a histogram.
pub const HistogramOptions = struct {
    description: []const u8 = "",
    unit: []const u8 = "",
    /// Advisory bucket bounds, used unless a view sets the aggregation.
    /// Bounds that are not strictly increasing are ignored.
    explicit_bucket_boundaries: ?[]const f64 = null,
};

/// Options for an observable instrument.
pub fn ObservableOptions(comptime N: type) type {
    return struct {
        description: []const u8 = "",
        unit: []const u8 = "",
        /// Called at every collection. Copied.
        callbacks: []const InstrumentCallback(N) = &.{},
    };
}

/// A callback of one observable instrument.
pub fn InstrumentCallback(comptime N: type) type {
    return struct {
        ptr: ?*anyopaque = null,
        func: *const fn (ptr: ?*anyopaque, observation: Observation(N)) void,
    };
}

/// What an instrument callback reports through.
pub fn Observation(comptime N: type) type {
    return struct {
        inst: *Instrument(N),
        pipeline: usize,

        /// Reports the current value for one attribute set.
        pub fn observe(o: @This(), value: N, attrs: []const KeyValue) void {
            o.inst.observe(o.pipeline, value, attrs);
        }
    };
}

/// An observable instrument, for `Meter.registerCallback`.
pub const Observable = struct {
    ptr: *const anyopaque,
};

/// A callback over several observable instruments.
pub const Callback = struct {
    ptr: ?*anyopaque = null,
    func: *const fn (ptr: ?*anyopaque, observer: Observer) void,
};

/// What a multi-instrument callback reports through.
pub const Observer = struct {
    pipeline: usize,
    allowed: []const Observable,

    /// Reports the current value of `inst`, an observable instrument
    /// handle, for one attribute set. An instrument the callback was not
    /// registered for is ignored, as Go rejects it.
    pub fn observe(o: Observer, inst: anytype, value: anytype, attrs: []const KeyValue) void {
        const target = inst.inst orelse return;
        const registered = for (o.allowed) |a| {
            if (a.ptr == @as(*const anyopaque, target)) break true;
        } else false;
        if (!registered) return;
        target.observe(o.pipeline, value, attrs);
    }
};

/// The handle `registerCallback` returns.
pub const Registration = struct {
    provider: ?*MeterProvider = null,
    entry: ?*RegistrationEntry = null,

    /// Stops calling the callback. Later calls do nothing. Call it before
    /// the provider is destroyed.
    pub fn unregister(r: *Registration) void {
        const p = r.provider orelse return;
        const entry = r.entry orelse return;
        r.entry = null;
        p.mutex.lockUncancelable(p.io);
        defer p.mutex.unlock(p.io);
        for (p.registrations.items, 0..) |e, i| {
            if (e == entry) {
                _ = p.registrations.orderedRemove(i);
                p.gpa.free(entry.instruments);
                p.gpa.destroy(entry);
                return;
            }
        }
    }
};

const RegistrationEntry = struct {
    callback: Callback,
    instruments: []Observable,
};

/// A synchronous counter: monotonic sums.
pub fn Counter(comptime N: type) type {
    return struct {
        inst: ?*Instrument(N) = null,

        pub const noop: @This() = .{};

        /// Adds a non-negative increment.
        pub fn add(c: @This(), ctx: Context, value: N, attrs: []const KeyValue) void {
            if (c.inst) |i| i.measure(ctx, value, attrs);
        }
    };
}

/// A synchronous up-down counter: sums that can go down.
pub fn UpDownCounter(comptime N: type) type {
    return struct {
        inst: ?*Instrument(N) = null,

        pub const noop: @This() = .{};

        /// Adds an increment or decrement.
        pub fn add(c: @This(), ctx: Context, value: N, attrs: []const KeyValue) void {
            if (c.inst) |i| i.measure(ctx, value, attrs);
        }
    };
}

/// A synchronous histogram.
pub fn Histogram(comptime N: type) type {
    return struct {
        inst: ?*Instrument(N) = null,

        pub const noop: @This() = .{};

        /// Records one measurement.
        pub fn record(h: @This(), ctx: Context, value: N, attrs: []const KeyValue) void {
            if (h.inst) |i| i.measure(ctx, value, attrs);
        }
    };
}

/// A synchronous gauge: the last recorded value.
pub fn Gauge(comptime N: type) type {
    return struct {
        inst: ?*Instrument(N) = null,

        pub const noop: @This() = .{};

        /// Records the current value.
        pub fn record(g: @This(), ctx: Context, value: N, attrs: []const KeyValue) void {
            if (g.inst) |i| i.measure(ctx, value, attrs);
        }
    };
}

/// An observable instrument handle: counter, up-down counter or gauge.
pub fn ObservableInstrument(comptime N: type, comptime kind: InstrumentKind) type {
    comptime std.debug.assert(kind.isObservable());
    return struct {
        inst: ?*Instrument(N) = null,

        pub const noop: @This() = .{};

        /// The instrument, for `Meter.registerCallback`.
        pub fn observable(o: @This()) ?Observable {
            const i = o.inst orelse return null;
            return .{ .ptr = i };
        }
    };
}

pub fn ObservableCounter(comptime N: type) type {
    return ObservableInstrument(N, .observable_counter);
}

pub fn ObservableUpDownCounter(comptime N: type) type {
    return ObservableInstrument(N, .observable_up_down_counter);
}

pub fn ObservableGauge(comptime N: type) type {
    return ObservableInstrument(N, .observable_gauge);
}

/// Reports whether `name` is a valid instrument name: a letter, then up
/// to 254 letters, digits, `_`, `.`, `-` or `/` (Go's
/// `validateInstrumentName`). Instruments with other names still work, as
/// in Go; the caller decides whether to report them.
pub fn validInstrumentName(name: []const u8) bool {
    if (name.len == 0 or name.len > 255) return false;
    if (!std.ascii.isAlphabetic(name[0])) return false;
    for (name[1..]) |c| {
        if (!(std.ascii.isAlphanumeric(c) or c == '_' or c == '.' or c == '-' or c == '/')) return false;
    }
    return true;
}

/// One instrument, with its streams for every reader. Internal; use the
/// handles.
pub fn Instrument(comptime N: type) type {
    return struct {
        const Self = @This();
        const StreamN = aggregate.Stream(N);

        provider: *MeterProvider,
        meter: *const Meter,
        kind: InstrumentKind,
        /// Owns the strings.
        arena: std.heap.ArenaAllocator,
        name: []const u8,
        description: []const u8,
        unit: []const u8,
        streams: std.ArrayList(*StreamN) = .empty,
        callbacks: std.ArrayList(InstrumentCallback(N)) = .empty,

        fn destroy(i: *Self) void {
            const gpa = i.provider.gpa;
            for (i.streams.items) |s| s.destroy();
            i.streams.deinit(gpa);
            i.callbacks.deinit(gpa);
            i.arena.deinit();
            gpa.destroy(i);
        }

        /// Records a synchronous measurement. Dropped after shutdown.
        fn measure(i: *Self, ctx: Context, value: N, attrs: []const KeyValue) void {
            if (i.provider.is_shutdown.load(.acquire)) return;
            i.dispatch(ctx, value, attrs, null);
        }

        /// Records an observation for one reader's streams.
        fn observe(i: *Self, pipeline: usize, value: N, attrs: []const KeyValue) void {
            i.dispatch(.background, value, attrs, pipeline);
        }

        fn dispatch(i: *Self, ctx: Context, value: N, attrs: []const KeyValue, pipeline: ?usize) void {
            if (i.streams.items.len == 0) return;
            var buf: [2048]u8 = undefined;
            var first: std.heap.BufferFirstAllocator = .init(&buf, i.provider.gpa);
            var arena: std.heap.ArenaAllocator = .init(first.allocator());
            defer arena.deinit();
            const a = arena.allocator();
            const copy = a.dupe(KeyValue, attrs) catch return;
            var set = attrset.canonicalize(copy);
            set = attrset.canonicalize(i.provider.policy.apply(.metric, set, a));
            for (i.streams.items) |s| {
                if (pipeline) |p| if (s.config.pipeline != p) continue;
                s.record(ctx, value, set, a);
            }
        }

        fn runCallbacks(ptr: *anyopaque, pipeline: usize) void {
            const i: *Self = @ptrCast(@alignCast(ptr));
            for (i.callbacks.items) |cb| cb.func(cb.ptr, .{ .inst = i, .pipeline = pipeline });
        }

        fn destroyErased(ptr: *anyopaque) void {
            const i: *Self = @ptrCast(@alignCast(ptr));
            i.destroy();
        }
    };
}

const NumberKind = enum { int, double };

fn numberKind(comptime N: type) NumberKind {
    return switch (N) {
        i64 => .int,
        f64 => .double,
        else => @compileError("metric instruments record i64 or f64, not " ++ @typeName(N)),
    };
}

const AnyInstrument = struct {
    ptr: *anyopaque,
    meter: *const Meter,
    number: NumberKind,
    kind: InstrumentKind,
    name: []const u8,
    description: []const u8,
    unit: []const u8,
    runCallbacksFn: *const fn (ptr: *anyopaque, pipeline: usize) void,
    destroyFn: *const fn (ptr: *anyopaque) void,
};

/// Creates instruments for one instrumentation scope.
pub const Meter = struct {
    /// Null for the no-op meter.
    provider: ?*MeterProvider,
    scope: resource_mod.InstrumentationScope,

    /// A meter whose instruments record nothing.
    pub const noop: Meter = .{ .provider = null, .scope = .{ .name = "" } };

    pub fn counter(m: *const Meter, comptime N: type, name: []const u8, options: InstrumentOptions) Counter(N) {
        return .{ .inst = m.lookup(N, .counter, name, options.description, options.unit, null) };
    }

    pub fn upDownCounter(m: *const Meter, comptime N: type, name: []const u8, options: InstrumentOptions) UpDownCounter(N) {
        return .{ .inst = m.lookup(N, .up_down_counter, name, options.description, options.unit, null) };
    }

    pub fn histogram(m: *const Meter, comptime N: type, name: []const u8, options: HistogramOptions) Histogram(N) {
        return .{ .inst = m.lookup(N, .histogram, name, options.description, options.unit, options.explicit_bucket_boundaries) };
    }

    pub fn gauge(m: *const Meter, comptime N: type, name: []const u8, options: InstrumentOptions) Gauge(N) {
        return .{ .inst = m.lookup(N, .gauge, name, options.description, options.unit, null) };
    }

    pub fn observableCounter(m: *const Meter, comptime N: type, name: []const u8, options: ObservableOptions(N)) ObservableCounter(N) {
        return .{ .inst = m.lookupObservable(N, .observable_counter, name, options) };
    }

    pub fn observableUpDownCounter(m: *const Meter, comptime N: type, name: []const u8, options: ObservableOptions(N)) ObservableUpDownCounter(N) {
        return .{ .inst = m.lookupObservable(N, .observable_up_down_counter, name, options) };
    }

    pub fn observableGauge(m: *const Meter, comptime N: type, name: []const u8, options: ObservableOptions(N)) ObservableGauge(N) {
        return .{ .inst = m.lookupObservable(N, .observable_gauge, name, options) };
    }

    /// Calls `callback` at every collection, with an observer for the
    /// listed instruments. Null entries, from no-op instruments, are
    /// skipped. Returns an empty registration when nothing is left to
    /// observe or memory runs out.
    pub fn registerCallback(m: *const Meter, callback: Callback, instruments: []const ?Observable) Registration {
        const p = m.provider orelse return .{};
        if (p.is_shutdown.load(.acquire)) return .{};
        var n: usize = 0;
        for (instruments) |o| {
            if (o != null) n += 1;
        }
        if (n == 0) return .{};
        const list = p.gpa.alloc(Observable, n) catch return .{};
        var i: usize = 0;
        for (instruments) |o| if (o) |obs| {
            list[i] = obs;
            i += 1;
        };
        const entry = p.gpa.create(RegistrationEntry) catch {
            p.gpa.free(list);
            return .{};
        };
        entry.* = .{ .callback = callback, .instruments = list };
        p.mutex.lockUncancelable(p.io);
        defer p.mutex.unlock(p.io);
        if (p.is_shutdown.load(.acquire)) {
            p.gpa.free(list);
            p.gpa.destroy(entry);
            return .{};
        }
        p.registrations.append(p.gpa, entry) catch {
            p.gpa.free(list);
            p.gpa.destroy(entry);
            return .{};
        };
        return .{ .provider = p, .entry = entry };
    }

    fn lookupObservable(m: *const Meter, comptime N: type, kind: InstrumentKind, name: []const u8, options: ObservableOptions(N)) ?*Instrument(N) {
        const inst = m.lookup(N, kind, name, options.description, options.unit, null) orelse return null;
        if (options.callbacks.len == 0) return inst;
        const p = inst.provider;
        p.mutex.lockUncancelable(p.io);
        defer p.mutex.unlock(p.io);
        inst.callbacks.appendSlice(p.gpa, options.callbacks) catch {};
        return inst;
    }

    /// Returns the instrument with this identity, creating it on first
    /// use. As in Go, the name compares without case and the first
    /// spelling is kept. Returns null after shutdown or when out of
    /// memory, which gives a no-op handle.
    fn lookup(m: *const Meter, comptime N: type, kind: InstrumentKind, name: []const u8, description: []const u8, unit: []const u8, advisory: ?[]const f64) ?*Instrument(N) {
        const p = m.provider orelse return null;
        if (p.is_shutdown.load(.acquire)) return null;
        p.mutex.lockUncancelable(p.io);
        defer p.mutex.unlock(p.io);
        if (p.is_shutdown.load(.acquire)) return null;
        for (p.instruments.items) |any| {
            if (any.meter == m and any.number == numberKind(N) and any.kind == kind and
                std.ascii.eqlIgnoreCase(any.name, name) and std.mem.eql(u8, any.unit, unit) and
                std.mem.eql(u8, any.description, description))
            {
                return @ptrCast(@alignCast(any.ptr));
            }
        }
        return p.createInstrument(N, m, kind, name, description, unit, advisory) catch null;
    }
};

/// One reader's view of the provider: its streams and its temporality.
const Pipeline = struct {
    provider: *MeterProvider,
    index: usize,
    reader: reader_mod.Reader,
    preference: instrument.TemporalityPreference,
    /// Guarded by the provider's lock.
    streams: std.ArrayList(aggregate.AnyStream) = .empty,

    fn producer(pl: *Pipeline) reader_mod.Producer {
        return .{ .ptr = pl, .produceFn = produce };
    }

    fn produce(ptr: *anyopaque, gpa: Allocator) Allocator.Error!data.ResourceMetrics {
        const pl: *Pipeline = @ptrCast(@alignCast(ptr));
        const p = pl.provider;
        p.mutex.lockUncancelable(p.io);
        defer p.mutex.unlock(p.io);

        // Instrument callbacks first, then multi-instrument callbacks, as
        // Go's pipeline.produce runs them.
        for (p.instruments.items) |any| any.runCallbacksFn(any.ptr, pl.index);
        for (p.registrations.items) |entry| {
            entry.callback.func(entry.callback.ptr, .{ .pipeline = pl.index, .allowed = entry.instruments });
        }

        var arena: std.heap.ArenaAllocator = .init(gpa);
        errdefer arena.deinit();
        const a = arena.allocator();
        const now = span_mod.nowUnixNano(p.io);
        var scopes: std.ArrayList(data.ScopeMetrics) = .empty;
        for (p.meters.items) |m| {
            var metrics: std.ArrayList(data.Metric) = .empty;
            for (pl.streams.items) |s| {
                if (s.owner != @as(*const anyopaque, m)) continue;
                if (try s.collect(a, now)) |metric| try metrics.append(a, metric);
            }
            if (metrics.items.len == 0) continue;
            try scopes.append(a, .{
                .scope = try data.deepCopy(resource_mod.InstrumentationScope, a, m.scope),
                .metrics = metrics.items,
            });
        }
        const res = try data.deepCopy(resource_mod.Resource, a, p.resource);
        const scope_metrics = scopes.items;
        return .{ .arena = arena, .resource = res, .scope_metrics = scope_metrics };
    }
};

/// Owns the meters, their instruments, the views and one pipeline per
/// reader.
pub const MeterProvider = struct {
    gpa: Allocator,
    io: Io,
    resource: resource_mod.Resource,
    views: []const View,
    exemplar_filter: exemplar.Filter,
    cardinality_limit: usize,
    policy: policy_mod.AttributePolicy,
    reservoir_size: usize,
    start_time: u64,
    pipelines: []Pipeline,

    mutex: Io.Mutex = .init,
    meters: std.ArrayList(*Meter) = .empty,
    instruments: std.ArrayList(AnyInstrument) = .empty,
    registrations: std.ArrayList(*RegistrationEntry) = .empty,
    is_shutdown: std.atomic.Value(bool) = .init(false),
    shutdown_done: Io.Event = .unset,
    shutdown_result: ?ExportError = null,

    pub const Options = struct {
        /// Borrowed: it must outlive the provider.
        resource: resource_mod.Resource = .empty,
        /// Copied; the readers themselves must outlive the provider.
        readers: []const reader_mod.Reader = &.{},
        /// Copied; their strings and slices must outlive the provider.
        views: []const View = &.{},
        /// Which measurements are offered to exemplar reservoirs. The
        /// environment value comes from `exemplar.filterFromEnv`.
        exemplar_filter: exemplar.Filter = .trace_based,
        /// The most series per stream, the overflow series included.
        /// Zero means no limit.
        cardinality_limit: usize = default_cardinality_limit,
        /// Classifies measurement attributes with `Target.metric`.
        policy: policy_mod.AttributePolicy = .noop,
        /// The slots of a fixed-size exemplar reservoir; null means one
        /// per CPU, as in Go.
        exemplar_reservoir_size: ?usize = null,
    };

    /// Creates a provider and registers it with every reader.
    pub fn create(gpa: Allocator, io: Io, options: Options) Allocator.Error!*MeterProvider {
        const p = try gpa.create(MeterProvider);
        errdefer gpa.destroy(p);
        const views = try gpa.dupe(View, options.views);
        errdefer gpa.free(views);
        const pipelines = try gpa.alloc(Pipeline, options.readers.len);
        errdefer gpa.free(pipelines);
        p.* = .{
            .gpa = gpa,
            .io = io,
            .resource = options.resource,
            .views = views,
            .exemplar_filter = options.exemplar_filter,
            .cardinality_limit = options.cardinality_limit,
            .policy = options.policy,
            .reservoir_size = options.exemplar_reservoir_size orelse (std.Thread.getCpuCount() catch 1),
            .start_time = span_mod.nowUnixNano(io),
            .pipelines = pipelines,
        };
        for (pipelines, options.readers, 0..) |*pl, r, i| {
            pl.* = .{ .provider = p, .index = i, .reader = r, .preference = r.temporality() };
        }
        for (pipelines) |*pl| pl.reader.register(pl.producer());
        return p;
    }

    /// Frees the provider, its meters and instruments. Shut it down
    /// first, and destroy its readers after it.
    pub fn destroy(p: *MeterProvider) void {
        const gpa = p.gpa;
        for (p.registrations.items) |entry| {
            gpa.free(entry.instruments);
            gpa.destroy(entry);
        }
        p.registrations.deinit(gpa);
        for (p.instruments.items) |any| any.destroyFn(any.ptr);
        p.instruments.deinit(gpa);
        for (p.meters.items) |m| {
            gpa.free(m.scope.name);
            gpa.free(m.scope.version);
            gpa.free(m.scope.schema_url);
            gpa.destroy(m);
        }
        p.meters.deinit(gpa);
        for (p.pipelines) |*pl| pl.streams.deinit(gpa);
        gpa.free(p.pipelines);
        gpa.free(p.views);
        gpa.destroy(p);
    }

    /// Returns the meter for a scope, creating it on first use. Meters
    /// with the same name, version and schema URL are the same meter. The
    /// scope's attributes are not copied and must outlive the provider.
    /// Returns the no-op meter when out of memory.
    pub fn meter(p: *MeterProvider, scope: resource_mod.InstrumentationScope) *const Meter {
        p.mutex.lockUncancelable(p.io);
        defer p.mutex.unlock(p.io);
        for (p.meters.items) |m| {
            if (std.mem.eql(u8, m.scope.name, scope.name) and
                std.mem.eql(u8, m.scope.version, scope.version) and
                std.mem.eql(u8, m.scope.schema_url, scope.schema_url)) return m;
        }
        return p.addMeter(scope) catch &Meter.noop;
    }

    fn addMeter(p: *MeterProvider, scope: resource_mod.InstrumentationScope) Allocator.Error!*Meter {
        const gpa = p.gpa;
        const m = try gpa.create(Meter);
        errdefer gpa.destroy(m);
        const name = try gpa.dupe(u8, scope.name);
        errdefer gpa.free(name);
        const version = try gpa.dupe(u8, scope.version);
        errdefer gpa.free(version);
        const schema_url = try gpa.dupe(u8, scope.schema_url);
        errdefer gpa.free(schema_url);
        m.* = .{ .provider = p, .scope = .{ .name = name, .version = version, .schema_url = schema_url, .attributes = scope.attributes } };
        try p.meters.append(gpa, m);
        return m;
    }

    /// Creates an instrument and its streams. Called with the lock held.
    fn createInstrument(p: *MeterProvider, comptime N: type, m: *const Meter, kind: InstrumentKind, name: []const u8, description: []const u8, unit: []const u8, advisory: ?[]const f64) Allocator.Error!*Instrument(N) {
        const Inst = Instrument(N);
        const gpa = p.gpa;
        const inst = try gpa.create(Inst);
        inst.* = .{
            .provider = p,
            .meter = m,
            .kind = kind,
            .arena = .init(gpa),
            .name = "",
            .description = "",
            .unit = "",
        };
        errdefer inst.destroy();
        const a = inst.arena.allocator();
        inst.name = try a.dupe(u8, name);
        inst.description = try a.dupe(u8, description);
        inst.unit = try a.dupe(u8, unit);

        // Reserve the list entries first, so nothing fails once streams
        // are registered with the pipelines.
        try p.instruments.ensureUnusedCapacity(gpa, 1);
        const match: view_mod.Instrument = .{
            .name = inst.name,
            .description = inst.description,
            .kind = kind,
            .unit = inst.unit,
            .meter_name = m.scope.name,
            .meter_version = m.scope.version,
            .meter_schema_url = m.scope.schema_url,
        };
        for (p.pipelines) |*pl| {
            var matched = false;
            for (p.views) |v| {
                if (!v.matches(match)) continue;
                matched = true;
                try p.addStream(N, inst, pl, v, advisory);
            }
            if (!matched) try p.addStream(N, inst, pl, null, advisory);
        }
        for (p.pipelines) |*pl| try pl.streams.ensureUnusedCapacity(gpa, inst.streams.items.len);
        for (inst.streams.items) |s| {
            p.pipelines[s.config.pipeline].streams.appendAssumeCapacity(s.any(m));
        }
        p.instruments.appendAssumeCapacity(.{
            .ptr = inst,
            .meter = m,
            .number = numberKind(N),
            .kind = kind,
            .name = inst.name,
            .description = inst.description,
            .unit = inst.unit,
            .runCallbacksFn = Inst.runCallbacks,
            .destroyFn = Inst.destroyErased,
        });
        return inst;
    }

    fn addStream(p: *MeterProvider, comptime N: type, inst: *Instrument(N), pl: *Pipeline, v: ?View, advisory: ?[]const f64) Allocator.Error!void {
        const config = p.resolveStream(inst, pl, v, advisory) orelse return;
        try inst.streams.ensureUnusedCapacity(p.gpa, 1);
        const s = try aggregate.Stream(N).create(p.gpa, p.io, config, p.start_time);
        inst.streams.appendAssumeCapacity(s);
    }

    /// Resolves the stream a view, or the default when `v` is null, gives
    /// the instrument on one pipeline. Returns null for a dropped stream
    /// and for an aggregation the instrument kind cannot use, which Go
    /// reports as an error and also leaves without a stream.
    fn resolveStream(p: *MeterProvider, inst: anytype, pl: *Pipeline, v: ?View, advisory: ?[]const f64) ?aggregate.Config {
        const kind = inst.kind;
        var agg: view_mod.Aggregation = .default;
        var name = inst.name;
        var description = inst.description;
        var unit = inst.unit;
        var keys: ?[]const []const u8 = null;
        if (v) |view| {
            if (view.name.len > 0) name = view.name;
            if (view.description.len > 0) description = view.description;
            if (view.unit.len > 0) unit = view.unit;
            if (view.aggregation) |a| agg = a;
            keys = view.attribute_keys;
        }
        switch (agg) {
            .explicit_bucket_histogram => |b| if (!b.valid()) {
                agg = .default;
            },
            else => {},
        }
        if (agg == .default) {
            agg = view_mod.defaultAggregation(kind);
            if (advisory) |bounds| if (agg == .explicit_bucket_histogram and (view_mod.Aggregation.ExplicitBuckets{ .boundaries = bounds }).valid()) {
                agg = .{ .explicit_bucket_histogram = .{ .boundaries = bounds } };
            };
        }
        if (!agg.compatible(kind)) return null;
        const resolved: aggregate.Aggregation = switch (agg) {
            .default, .drop => return null,
            .sum => .{ .sum = .{ .monotonic = switch (kind) {
                .counter, .histogram, .observable_counter => true,
                else => false,
            } } },
            .last_value => .last_value,
            .explicit_bucket_histogram => |b| .{ .histogram = .{
                .bounds = b.boundaries,
                .record_min_max = !b.no_min_max,
                .record_sum = !kind.canBeNegative(),
            } },
        };
        return .{
            .name = name,
            .description = description,
            .unit = unit,
            .kind = kind,
            .aggregation = resolved,
            .temporality = pl.preference.temporality(kind),
            .attribute_keys = keys,
            .cardinality_limit = p.cardinality_limit,
            .filter = p.exemplar_filter,
            .reservoir_size = p.reservoir_size,
            .pipeline = pl.index,
        };
    }

    /// Flushes every reader in order, under one deadline, and returns the
    /// first error.
    pub fn forceFlush(p: *MeterProvider, deadline: Deadline) ExportError!void {
        var first: ?ExportError = null;
        for (p.pipelines) |*pl| {
            pl.reader.forceFlush(deadline) catch |err| {
                if (first == null) first = err;
            };
        }
        if (first) |err| return err;
    }

    /// Stops recording and shuts every reader down in order, under one
    /// deadline. A periodic reader runs its final collection and export
    /// here. Concurrent and later callers wait for the first to finish
    /// (bounded by their own deadline) and return its result.
    pub fn shutdown(p: *MeterProvider, deadline: Deadline) ExportError!void {
        if (p.is_shutdown.swap(true, .acq_rel)) {
            p.shutdown_done.waitTimeout(p.io, deadline_mod.timeout(deadline)) catch |err| switch (err) {
                error.Timeout => return error.Timeout,
                error.Canceled => return error.Canceled,
            };
            if (p.shutdown_result) |err| return err;
            return;
        }
        var first: ?ExportError = null;
        for (p.pipelines) |*pl| {
            pl.reader.shutdown(deadline) catch |err| {
                if (first == null) first = err;
            };
        }
        p.shutdown_result = first;
        p.shutdown_done.set(p.io);
        if (first) |err| return err;
    }
};

test {
    _ = @import("meter_test.zig");
}
