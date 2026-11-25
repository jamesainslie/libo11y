//! Spans. A `Span` is the handle `Tracer.start` returns. It points to a
//! `SpanData`, the record that collects the span's name, attributes,
//! events, links and status, and that processors and exporters read once
//! the span has ended.
//!
//! A span copies every string and slice it is given into its own arena,
//! so callers may free or reuse their buffers as soon as a call returns.
//! The OpenTelemetry default span limits apply (128 attributes, events,
//! links and attributes per event or link; no value length limit), as the
//! OTel Go SDK applies them.

const std = @import("std");
const Io = std.Io;
const Allocator = std.mem.Allocator;
const attribute = @import("attribute.zig");
const KeyValue = attribute.KeyValue;
const ids = @import("ids.zig");
const SpanContext = ids.SpanContext;
const Tracer = @import("tracer.zig").Tracer;
const resource_mod = @import("resource.zig");

/// The span kind. The values are the OTLP enum values.
pub const SpanKind = enum(u3) {
    internal = 1,
    server = 2,
    client = 3,
    producer = 4,
    consumer = 5,
};

/// A span status code, ordered as in Go: a status is replaced only by a
/// code at least as high, so `ok` is final.
pub const StatusCode = enum(u2) {
    unset = 0,
    @"error" = 1,
    ok = 2,
};

/// A span status. Only an error status keeps a description.
pub const Status = struct {
    code: StatusCode = .unset,
    description: []const u8 = "",
};

/// A timestamped event on a span.
pub const Event = struct {
    name: []const u8,
    time_unix_nano: u64,
    attributes: []const KeyValue = &.{},
    dropped_attributes_count: u32 = 0,
};

/// A link from a span to another span context.
pub const Link = struct {
    span_context: SpanContext,
    attributes: []const KeyValue = &.{},
    dropped_attributes_count: u32 = 0,
};

/// Span limits. A null limit is unlimited. The defaults are the
/// OpenTelemetry defaults.
pub const Limits = struct {
    /// The longest string attribute value kept, in bytes. Longer values
    /// are cut on a UTF-8 boundary.
    attribute_value_length: ?usize = null,
    attribute_count: ?u32 = 128,
    event_count: ?u32 = 128,
    link_count: ?u32 = 128,
    attributes_per_event: ?u32 = 128,
    attributes_per_link: ?u32 = 128,
};

/// Options for `Span.addEvent`.
pub const EventOptions = struct {
    attributes: []const KeyValue = &.{},
    /// Unix nanoseconds; now when null.
    timestamp: ?u64 = null,
};

/// Options for `Span.recordError`.
pub const ErrorOptions = struct {
    /// `exception.message`; the error's name when null.
    message: ?[]const u8 = null,
    /// Extra event attributes, added after `exception.type` and
    /// `exception.message`.
    attributes: []const KeyValue = &.{},
    /// Unix nanoseconds; now when null.
    timestamp: ?u64 = null,
};

/// The record of one span. It is created by `Tracer.start`, collects
/// data while the span is live, and is immutable once it has ended.
///
/// Processors see it twice: `onStart` gets the live record, which they
/// may still change, and `onEnd` gets the ended record, which they must
/// only read. A processor that keeps an ended record past `onEnd` calls
/// `retain` and later `release`. The record is freed when the last
/// reference is released.
pub const SpanData = struct {
    tracer: *const Tracer,
    gpa: Allocator,
    io: Io,
    arena: std.heap.ArenaAllocator,
    mutex: Io.Mutex = .init,
    refs: std.atomic.Value(u32) = .init(1),
    recording: bool,
    ended: bool = false,

    /// The span's own span context. Its trace state text lives in the
    /// record's arena.
    span_context: SpanContext,
    /// The parent's span context, invalid for a root span. Its trace
    /// state is not kept.
    parent: SpanContext,
    kind: SpanKind,
    start_time_unix_nano: u64,

    // The fields below change under the mutex while the span is live and
    // are immutable once it has ended.
    name: []const u8,
    end_time_unix_nano: u64 = 0,
    attributes: std.ArrayList(KeyValue) = .empty,
    dropped_attributes_count: u32 = 0,
    events: std.ArrayList(Event) = .empty,
    dropped_events_count: u32 = 0,
    links: std.ArrayList(Link) = .empty,
    dropped_links_count: u32 = 0,
    status: Status = .{},

    /// The resource of the tracer provider that created the span.
    pub fn resource(data: *const SpanData) *const resource_mod.Resource {
        return &data.tracer.provider.?.resource;
    }

    /// The instrumentation scope of the tracer that created the span.
    pub fn scope(data: *const SpanData) *const resource_mod.InstrumentationScope {
        return &data.tracer.scope;
    }

    fn limits(data: *const SpanData) Limits {
        return data.tracer.provider.?.limits;
    }

    /// Takes a reference to an ended record.
    pub fn retain(data: *const SpanData) void {
        _ = @constCast(data).refs.fetchAdd(1, .monotonic);
    }

    /// Drops a reference, freeing the record when it was the last one.
    pub fn release(data: *const SpanData) void {
        const self = @constCast(data);
        if (self.refs.fetchSub(1, .acq_rel) != 1) return;
        const gpa = self.gpa;
        self.arena.deinit();
        gpa.destroy(self);
    }

    /// Reports whether the record still accepts changes.
    pub fn isRecording(data: *SpanData) bool {
        if (!data.recording) return false;
        data.mutex.lockUncancelable(data.io);
        defer data.mutex.unlock(data.io);
        return !data.ended;
    }

    /// Sets attributes, replacing the value of a key that is already
    /// set. Once the attribute count limit is reached, new keys are
    /// dropped and counted. An attribute with an empty key is dropped and
    /// counted.
    pub fn setAttributes(data: *SpanData, attrs: []const KeyValue) void {
        if (!data.recording) return;
        data.mutex.lockUncancelable(data.io);
        defer data.mutex.unlock(data.io);
        if (data.ended) return;
        data.setAttributesLocked(attrs);
    }

    fn setAttributesLocked(data: *SpanData, attrs: []const KeyValue) void {
        const lim = data.limits();
        const arena = data.arena.allocator();
        for (attrs) |a| {
            if (a.key.len == 0) {
                data.dropped_attributes_count +|= 1;
                continue;
            }
            const value = a.value.dupe(arena, lim.attribute_value_length) catch {
                data.dropped_attributes_count +|= 1;
                continue;
            };
            if (indexOfKey(data.attributes.items, a.key)) |i| {
                data.attributes.items[i].value = value;
                continue;
            }
            if (lim.attribute_count) |max| if (data.attributes.items.len >= max) {
                data.dropped_attributes_count +|= 1;
                continue;
            };
            const key = arena.dupe(u8, a.key) catch {
                data.dropped_attributes_count +|= 1;
                continue;
            };
            data.attributes.append(arena, .{ .key = key, .value = value }) catch {
                data.dropped_attributes_count +|= 1;
            };
        }
    }

    /// Renames the span.
    pub fn setName(data: *SpanData, name: []const u8) void {
        if (!data.recording) return;
        data.mutex.lockUncancelable(data.io);
        defer data.mutex.unlock(data.io);
        if (data.ended) return;
        data.name = data.arena.allocator().dupe(u8, name) catch return;
    }

    /// Sets the status, unless the current code is higher: `ok` is final,
    /// and `unset` never replaces `error`. Only `error` keeps the
    /// description.
    pub fn setStatus(data: *SpanData, code: StatusCode, description: []const u8) void {
        if (!data.recording) return;
        data.mutex.lockUncancelable(data.io);
        defer data.mutex.unlock(data.io);
        if (data.ended) return;
        if (@backingInt(data.status.code) > @backingInt(code)) return;
        var status: Status = .{ .code = code };
        if (code == .@"error") status.description = data.arena.allocator().dupe(u8, description) catch "";
        data.status = status;
    }

    /// Adds an event. Its attributes are deduplicated with the last
    /// value winning, then cut to the per-event limit. Past the event
    /// count limit the oldest event is dropped and counted.
    pub fn addEvent(data: *SpanData, name: []const u8, options: EventOptions) void {
        if (!data.recording) return;
        const time = options.timestamp orelse nowUnixNano(data.io);
        data.mutex.lockUncancelable(data.io);
        defer data.mutex.unlock(data.io);
        if (data.ended) return;
        data.addEventLocked(name, time, &.{options.attributes});
    }

    fn addEventLocked(data: *SpanData, name: []const u8, time: u64, attr_lists: []const []const KeyValue) void {
        const lim = data.limits();
        const arena = data.arena.allocator();
        const copied = copyAttributes(arena, attr_lists, lim.attribute_value_length, lim.attributes_per_event) catch {
            data.dropped_events_count +|= 1;
            return;
        };
        const event: Event = .{
            .name = arena.dupe(u8, name) catch {
                data.dropped_events_count +|= 1;
                return;
            },
            .time_unix_nano = time,
            .attributes = copied.attributes,
            .dropped_attributes_count = copied.dropped,
        };
        addEvicting(Event, &data.events, arena, event, lim.event_count, &data.dropped_events_count);
    }

    /// Records an error as an `exception` event with `exception.type` and
    /// `exception.message`, as Go's `RecordError` does. It does not set
    /// the status. `exception.type` is the error as Zig prints it, such
    /// as `error.Timeout`.
    pub fn recordError(data: *SpanData, err: anyerror, options: ErrorOptions) void {
        if (!data.recording) return;
        const time = options.timestamp orelse nowUnixNano(data.io);
        var type_buf: [128]u8 = undefined;
        const type_name = std.fmt.bufPrint(&type_buf, "error.{s}", .{@errorName(err)}) catch @errorName(err);
        const exception = [_]KeyValue{
            attribute.kv("exception.type", type_name),
            attribute.kv("exception.message", options.message orelse type_name),
        };
        data.mutex.lockUncancelable(data.io);
        defer data.mutex.unlock(data.io);
        if (data.ended) return;
        data.addEventLocked("exception", time, &.{ &exception, options.attributes });
    }

    /// Adds a link. A link with an invalid span context, no attributes
    /// and no trace state is ignored, as in Go. Past the link count limit
    /// the oldest link is dropped and counted.
    pub fn addLink(data: *SpanData, link: Link) void {
        if (!data.recording) return;
        data.mutex.lockUncancelable(data.io);
        defer data.mutex.unlock(data.io);
        if (data.ended) return;
        data.addLinkLocked(link);
    }

    fn addLinkLocked(data: *SpanData, link: Link) void {
        if (!link.span_context.isValid() and link.attributes.len == 0 and link.span_context.trace_state.header.len == 0) return;
        const lim = data.limits();
        const arena = data.arena.allocator();
        const copied = copyAttributes(arena, &.{link.attributes}, lim.attribute_value_length, lim.attributes_per_link) catch {
            data.dropped_links_count +|= 1;
            return;
        };
        var sc = link.span_context;
        sc.trace_state = .{ .header = arena.dupe(u8, sc.trace_state.header) catch {
            data.dropped_links_count +|= 1;
            return;
        } };
        const copy: Link = .{ .span_context = sc, .attributes = copied.attributes, .dropped_attributes_count = copied.dropped + link.dropped_attributes_count };
        addEvicting(Link, &data.links, arena, copy, lim.link_count, &data.dropped_links_count);
    }

    /// Ends the record: it stamps the end time, runs the policy over the
    /// span, event and link attributes, and hands the ended record to
    /// every processor's `onEnd`. A second call does nothing.
    fn finish(data: *SpanData, end_time: ?u64) void {
        const ts = end_time orelse nowUnixNano(data.io);
        data.mutex.lockUncancelable(data.io);
        if (data.ended) {
            data.mutex.unlock(data.io);
            return;
        }
        data.ended = true;
        if (!data.recording) {
            data.mutex.unlock(data.io);
            data.release();
            return;
        }
        data.end_time_unix_nano = ts;
        const provider = data.tracer.provider.?;
        const arena = data.arena.allocator();
        const kept = provider.policy.apply(.span, data.attributes.items, arena);
        data.attributes.items = kept;
        data.attributes.capacity = kept.len;
        for (data.events.items) |*event| {
            event.attributes = provider.policy.apply(.event, @constCast(event.attributes), arena);
        }
        for (data.links.items) |*link| {
            link.attributes = provider.policy.apply(.link, @constCast(link.attributes), arena);
        }
        data.mutex.unlock(data.io);
        for (provider.processors) |p| p.onEnd(data);
        data.release();
    }

    /// Creates a record for a span `Tracer.start` has decided on. It
    /// copies `trace_state` into the record's arena. Null when out of
    /// memory.
    pub fn create(
        tracer: *const Tracer,
        gpa: Allocator,
        io: Io,
        recording: bool,
        span_context: SpanContext,
        parent: SpanContext,
        kind: SpanKind,
        name: []const u8,
        start_time: u64,
    ) ?*SpanData {
        const data = gpa.create(SpanData) catch return null;
        data.* = .{
            .tracer = tracer,
            .gpa = gpa,
            .io = io,
            .arena = .init(gpa),
            .recording = recording,
            .span_context = span_context,
            .parent = parent,
            .kind = kind,
            .name = "",
            .start_time_unix_nano = start_time,
        };
        data.parent.trace_state = .empty;
        const arena = data.arena.allocator();
        data.span_context.trace_state = .{ .header = arena.dupe(u8, span_context.trace_state.header) catch {
            data.arena.deinit();
            gpa.destroy(data);
            return null;
        } };
        if (recording) data.name = arena.dupe(u8, name) catch "";
        return data;
    }

    /// Adds the start attributes and links. Called by the tracer before
    /// `onStart`.
    pub fn initRecording(data: *SpanData, attrs: []const []const KeyValue, links: []const Link) void {
        data.mutex.lockUncancelable(data.io);
        defer data.mutex.unlock(data.io);
        for (attrs) |list| data.setAttributesLocked(list);
        for (links) |link| data.addLinkLocked(link);
    }
};

/// The handle to a span. It is a small value: keep it in a variable, end
/// it once, and do not copy it. `end` is idempotent, so a `defer
/// span.end()` next to an explicit `end` is safe.
///
/// A span may be changed from several threads at once, but `end` must
/// happen after every other call on the same span has returned. A
/// context that points to the span (`Context.withSpan`) is valid until
/// the span ends.
pub const Span = struct {
    span_context: SpanContext = .invalid,
    data: ?*SpanData = null,

    /// A span that records nothing and has an invalid span context.
    pub const noop: Span = .{};

    /// Returns the span's span context.
    pub fn spanContext(span: *const Span) SpanContext {
        return span.span_context;
    }

    /// Reports whether the span records changes. A span the sampler
    /// dropped, and an ended span, do not.
    pub fn isRecording(span: *const Span) bool {
        const data = span.data orelse return false;
        return data.isRecording();
    }

    /// Sets one attribute, converting `value` with `attribute.Value.from`.
    pub fn setAttribute(span: *Span, key: []const u8, value: anytype) void {
        const data = span.data orelse return;
        data.setAttributes(&.{attribute.kv(key, value)});
    }

    /// Sets attributes. See `SpanData.setAttributes`.
    pub fn setAttributes(span: *Span, attrs: []const KeyValue) void {
        const data = span.data orelse return;
        data.setAttributes(attrs);
    }

    /// Renames the span.
    pub fn setName(span: *Span, name: []const u8) void {
        const data = span.data orelse return;
        data.setName(name);
    }

    /// Sets the status. See `SpanData.setStatus`.
    pub fn setStatus(span: *Span, code: StatusCode, description: []const u8) void {
        const data = span.data orelse return;
        data.setStatus(code, description);
    }

    /// Adds an event. See `SpanData.addEvent`.
    pub fn addEvent(span: *Span, name: []const u8, options: EventOptions) void {
        const data = span.data orelse return;
        data.addEvent(name, options);
    }

    /// Records an error as an exception event. See `SpanData.recordError`.
    pub fn recordError(span: *Span, err: anyerror, options: ErrorOptions) void {
        const data = span.data orelse return;
        data.recordError(err, options);
    }

    /// Adds a link. See `SpanData.addLink`.
    pub fn addLink(span: *Span, link: Link) void {
        const data = span.data orelse return;
        data.addLink(link);
    }

    /// Ends the span now.
    pub fn end(span: *Span) void {
        span.endAt(null);
    }

    /// Ends the span at `timestamp` (Unix nanoseconds), or now when null.
    /// Later calls do nothing.
    pub fn endAt(span: *Span, timestamp: ?u64) void {
        const data = span.data orelse return;
        span.data = null;
        data.finish(timestamp);
    }
};

/// The current time in Unix nanoseconds.
pub fn nowUnixNano(io: Io) u64 {
    const ns = Io.Clock.real.now(io).nanoseconds;
    return std.math.cast(u64, ns) orelse 0;
}

fn indexOfKey(attrs: []const KeyValue, key: []const u8) ?usize {
    for (attrs, 0..) |a, i| {
        if (std.mem.eql(u8, a.key, key)) return i;
    }
    return null;
}

const Copied = struct { attributes: []const KeyValue, dropped: u32 };

/// Copies the attribute lists into `arena` as one list, deduplicated with
/// the last value winning at the first key's position, then cut to
/// `count_limit`.
fn copyAttributes(arena: Allocator, lists: []const []const KeyValue, max_len: ?usize, count_limit: ?u32) Allocator.Error!Copied {
    var total: usize = 0;
    for (lists) |list| total += list.len;
    if (total == 0) return .{ .attributes = &.{}, .dropped = 0 };
    var out: std.ArrayList(KeyValue) = try .initCapacity(arena, total);
    for (lists) |list| {
        for (list) |a| {
            if (indexOfKey(out.items, a.key)) |i| {
                out.items[i].value = a.value;
            } else {
                out.appendAssumeCapacity(a);
            }
        }
    }
    var dropped: u32 = 0;
    if (count_limit) |max| if (out.items.len > max) {
        dropped = @intCast(out.items.len - max);
        out.shrinkRetainingCapacity(max);
    };
    for (out.items) |*a| a.* = try a.dupe(arena, max_len);
    return .{ .attributes = out.items, .dropped = dropped };
}

fn addEvicting(comptime T: type, list: *std.ArrayList(T), arena: Allocator, item: T, limit: ?u32, dropped: *u32) void {
    if (limit) |max| {
        if (max == 0) {
            dropped.* +|= 1;
            return;
        }
        if (list.items.len >= max) {
            _ = list.orderedRemove(0);
            dropped.* +|= 1;
        }
    }
    list.append(arena, item) catch {
        dropped.* +|= 1;
    };
}

test {
    _ = @import("span_test.zig");
}
