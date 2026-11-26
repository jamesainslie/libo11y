//! Builds node trees from parser events, as gopkg.in/yaml.v3's parser type
//! does (decode.go), so the registry decoder sees the nodes yaml.v3 would:
//! every scalar carries its resolved tag, anchors persist across documents,
//! and an alias to an unknown anchor is an error. Composition keeps its own
//! stack, so deep nesting cannot overflow the call stack.

const std = @import("std");
const Allocator = std.mem.Allocator;
const parser = @import("parser.zig");
const resolve = @import("resolve.zig");

pub const Mark = parser.Mark;
pub const ScalarStyle = parser.ScalarStyle;
pub const Diagnostic = parser.Diagnostic;
pub const Error = parser.Error;

pub const Kind = enum { scalar, sequence, mapping, alias };

pub const Node = struct {
    kind: Kind,
    /// The node's tag in short form. A scalar without an explicit tag has
    /// its resolved tag, a collection its default one. An alias has none.
    tag: []const u8,
    /// Whether the tag was written in the document.
    tagged: bool = false,
    style: ScalarStyle = .plain,
    /// A scalar's text, or an alias's anchor name.
    value: []const u8 = "",
    /// What an alias refers to.
    target: ?*Node = null,
    /// A sequence's items, or a mapping's keys and values in turn.
    children: std.ArrayList(*Node) = .empty,
    mark: Mark,

    /// yaml.v3's Node.indicatedString: a scalar that is a string because of
    /// its tag or style.
    pub fn indicatedString(n: *const Node) bool {
        if (n.kind != .scalar) return false;
        if (std.mem.eql(u8, resolve.shortTag(n.tag), resolve.str)) return true;
        const untagged = n.tag.len == 0 or std.mem.eql(u8, n.tag, "!");
        return untagged and n.style != .plain;
    }

    /// yaml.v3's Node.ShortTag.
    pub fn shortTag(n: *const Node, scratch: Allocator) Allocator.Error![]const u8 {
        if (n.indicatedString()) return resolve.str;
        if (n.tag.len == 0 or std.mem.eql(u8, n.tag, "!")) {
            return switch (n.kind) {
                .mapping => resolve.map_tag,
                .sequence => resolve.seq_tag,
                .alias => if (n.target) |t| t.shortTag(scratch) else "",
                .scalar => (resolve.resolve(scratch, "", n.value) catch |err| switch (err) {
                    // An empty tag never mismatches.
                    error.Mismatch => return resolve.str,
                    error.OutOfMemory => |e| return e,
                }).tag,
            };
        }
        return resolve.shortTag(n.tag);
    }
};

pub const Composer = struct {
    arena: Allocator,
    parser: parser.Parser,
    anchors: std.StringHashMapUnmanaged(*Node) = .empty,
    started: bool = false,

    pub fn init(arena: Allocator, src: []const u8, diag: *Diagnostic) Composer {
        return .{ .arena = arena, .parser = .init(arena, src, diag) };
    }

    /// Returns the root node of the next document, or null at the end of the
    /// stream.
    pub fn next(c: *Composer) Error!?*Node {
        if (!c.started) {
            const first = try c.parser.next();
            if (first.type != .stream_start) return c.fail(first.start, "expected the stream start");
            c.started = true;
        }
        const start = try c.parser.next();
        switch (start.type) {
            .stream_end => return null,
            .document_start => {},
            else => return c.fail(start.start, "expected a document"),
        }
        const root = try c.compose();
        const end = try c.parser.next();
        if (end.type != .document_end) return c.fail(end.start, "expected the document end");
        return root;
    }

    fn fail(c: *Composer, mark: Mark, message: []const u8) Error {
        c.parser.diag.* = .{ .message = message, .mark = mark };
        return error.Syntax;
    }

    fn compose(c: *Composer) Error!*Node {
        var open: std.ArrayList(*Node) = .empty;
        while (true) {
            const ev = try c.parser.next();
            const node: *Node = switch (ev.type) {
                .scalar => try c.scalar(ev),
                .alias => n: {
                    const target = c.anchors.get(ev.anchor) orelse return c.fail(ev.start, "unknown anchor referenced");
                    break :n try c.newNode(.{ .kind = .alias, .tag = "", .value = ev.anchor, .target = target, .mark = ev.start });
                },
                .sequence_start, .mapping_start => n: {
                    const kind: Kind = if (ev.type == .sequence_start) .sequence else .mapping;
                    const default = if (kind == .sequence) resolve.seq_tag else resolve.map_tag;
                    const n = try c.newNode(.{ .kind = kind, .tag = default, .mark = ev.start });
                    c.applyTag(n, ev.tag);
                    try c.anchor(n, ev.anchor);
                    break :n n;
                },
                .sequence_end, .mapping_end => {
                    const done = open.pop() orelse return c.fail(ev.start, "unexpected collection end");
                    if (open.items.len == 0) return done;
                    continue;
                },
                else => return c.fail(ev.start, "unexpected event"),
            };
            if (open.items.len == 0) {
                if (node.kind == .sequence or node.kind == .mapping) {
                    try open.append(c.arena, node);
                    continue;
                }
                return node;
            }
            try open.items[open.items.len - 1].children.append(c.arena, node);
            if (node.kind == .sequence or node.kind == .mapping) try open.append(c.arena, node);
        }
    }

    fn newNode(c: *Composer, n: Node) Error!*Node {
        const node = try c.arena.create(Node);
        node.* = n;
        return node;
    }

    fn applyTag(c: *Composer, n: *Node, tag: []const u8) void {
        _ = c;
        if (tag.len > 0 and !std.mem.eql(u8, tag, "!")) {
            n.tag = resolve.shortTag(tag);
            n.tagged = true;
        }
    }

    fn anchor(c: *Composer, n: *Node, name: []const u8) Error!void {
        if (name.len > 0) try c.anchors.put(c.arena, name, n);
    }

    fn scalar(c: *Composer, ev: parser.Event) Error!*Node {
        const n = try c.newNode(.{ .kind = .scalar, .tag = "", .style = ev.style, .value = ev.value, .mark = ev.start });
        if (ev.tag.len > 0 and !std.mem.eql(u8, ev.tag, "!")) {
            c.applyTag(n, ev.tag);
        } else if (ev.style != .plain) {
            n.tag = resolve.str;
        } else if (std.mem.eql(u8, ev.value, "<<")) {
            n.tag = resolve.merge_tag;
        } else {
            n.tag = (resolve.resolve(c.arena, "", ev.value) catch |err| switch (err) {
                error.Mismatch => return c.fail(ev.start, "unexpected tag mismatch"),
                error.OutOfMemory => |e| return e,
            }).tag;
        }
        try c.anchor(n, ev.anchor);
        return n;
    }
};

fn renderNode(w: *std.Io.Writer, n: *const Node) !void {
    switch (n.kind) {
        .scalar => try w.print("{s}({s})", .{ n.tag, n.value }),
        .alias => try w.print("*{s}", .{n.value}),
        .sequence, .mapping => {
            try w.writeAll(if (n.kind == .sequence) "[" else "{");
            for (n.children.items, 0..) |child, i| {
                if (i > 0) try w.writeByte(' ');
                try renderNode(w, child);
            }
            try w.writeAll(if (n.kind == .sequence) "]" else "}");
        },
    }
}

fn expectDocuments(src: []const u8, want: []const u8) !void {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    var diag: Diagnostic = .{};
    var c: Composer = .init(arena.allocator(), src, &diag);
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    while (true) {
        const root = c.next() catch |err| switch (err) {
            error.Syntax => {
                try out.writer.print("ERR({s})", .{diag.message});
                break;
            },
            else => |e| return e,
        } orelse break;
        try renderNode(&out.writer, root);
        try out.writer.writeByte(';');
    }
    try std.testing.expectEqualStrings(want, out.written());
}

test "scalars carry their resolved tags" {
    try expectDocuments("{a: 1, b: '1', c: ~, <<: x, '<<': y, d: !!str 2, e: ! 3}", "{!!str(a) !!int(1) !!str(b) !!str(1) !!str(c) !!null(~) !!merge(<<) !!str(x) !!str(<<) !!str(y) !!str(d) !!str(2) !!str(e) !!int(3)};");
}

test "aliases refer back to anchors, across documents too" {
    try expectDocuments("a: &x [1]\nb: *x\n--- *x\n", "{!!str(a) [!!int(1)] !!str(b) *x};*x;");
    try expectDocuments("a: *nope\n", "ERR(unknown anchor referenced)");
}

test "collection tags" {
    try expectDocuments("!!map [a]\n", "[!!str(a)];");
}

test "deep nesting does not use the call stack" {
    const depth = 5000;
    const src = try std.testing.allocator.alloc(u8, depth * 2);
    defer std.testing.allocator.free(src);
    @memset(src[0..depth], '[');
    @memset(src[depth..], ']');
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    var diag: Diagnostic = .{};
    var c: Composer = .init(arena.allocator(), src, &diag);
    const root = (try c.next()) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(Kind.sequence, root.kind);
}
