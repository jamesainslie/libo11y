//! The YAML parser of libo11y's strict registry parser. It turns the
//! scanner's tokens into events with the state machine of libyaml as
//! gopkg.in/yaml.v3 ports it (parserc.go), so a stream is accepted or
//! rejected exactly as Go reads it. Only YAML 1.1 is accepted, as in
//! yaml.v3. Comments are not kept. That code is covered by this notice:
//!
//!   Copyright (c) 2006-2010 Kirill Simonov
//!   Copyright (c) 2006-2011 Kirill Simonov
//!
//!   Permission is hereby granted, free of charge, to any person obtaining a
//!   copy of this software and associated documentation files (the
//!   "Software"), to deal in the Software without restriction, including
//!   without limitation the rights to use, copy, modify, merge, publish,
//!   distribute, sublicense, and/or sell copies of the Software, and to
//!   permit persons to whom the Software is furnished to do so, subject to
//!   the following conditions:
//!
//!   The above copyright notice and this permission notice shall be included
//!   in all copies or substantial portions of the Software.
//!
//!   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
//!   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
//!   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
//!   IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
//!   CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
//!   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
//!   SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

const std = @import("std");
const Allocator = std.mem.Allocator;
const scanner = @import("scanner.zig");

pub const Mark = scanner.Mark;
pub const ScalarStyle = scanner.ScalarStyle;
pub const Diagnostic = scanner.Diagnostic;
pub const Error = scanner.Error;
const Token = scanner.Token;

pub const EventType = enum {
    stream_start,
    stream_end,
    document_start,
    document_end,
    alias,
    scalar,
    sequence_start,
    sequence_end,
    mapping_start,
    mapping_end,
};

pub const Event = struct {
    type: EventType,
    start: Mark,
    /// An alias's anchor name, or the anchor a node declares.
    anchor: []const u8 = "",
    /// The resolved tag of a node, empty when it has none.
    tag: []const u8 = "",
    value: []const u8 = "",
    style: ScalarStyle = .plain,
};

const State = enum {
    stream_start,
    implicit_document_start,
    document_start,
    document_content,
    document_end,
    block_node,
    flow_node,
    block_sequence_first_entry,
    block_sequence_entry,
    indentless_sequence_entry,
    block_mapping_first_key,
    block_mapping_key,
    block_mapping_value,
    flow_sequence_first_entry,
    flow_sequence_entry,
    flow_sequence_entry_mapping_key,
    flow_sequence_entry_mapping_value,
    flow_sequence_entry_mapping_end,
    flow_mapping_first_key,
    flow_mapping_key,
    flow_mapping_value,
    flow_mapping_empty_value,
    end,
};

const TagDirective = struct { handle: []const u8, prefix: []const u8 };

const default_tag_directives = [_]TagDirective{
    .{ .handle = "!", .prefix = "!" },
    .{ .handle = "!!", .prefix = "tag:yaml.org,2002:" },
};

pub const Parser = struct {
    arena: Allocator,
    scanner: scanner.Scanner,
    diag: *Diagnostic,
    state: State = .stream_start,
    states: std.ArrayList(State) = .empty,
    tag_directives: std.ArrayList(TagDirective) = .empty,
    stream_end_produced: bool = false,

    /// src must be what reader.decode returned. Events and their text live
    /// in arena.
    pub fn init(arena: Allocator, src: []const u8, diag: *Diagnostic) Parser {
        return .{ .arena = arena, .scanner = .init(arena, src, diag), .diag = diag };
    }

    /// Returns the next event. After the stream end it keeps returning
    /// stream_end.
    pub fn next(p: *Parser) Error!Event {
        if (p.stream_end_produced or p.state == .end) return .{ .type = .stream_end, .start = p.scanner.mark };
        return switch (p.state) {
            .stream_start => p.parseStreamStart(),
            .implicit_document_start => p.parseDocumentStart(true),
            .document_start => p.parseDocumentStart(false),
            .document_content => p.parseDocumentContent(),
            .document_end => p.parseDocumentEnd(),
            .block_node => p.parseNode(true, false),
            .flow_node => p.parseNode(false, false),
            .block_sequence_first_entry => p.parseBlockSequenceEntry(true),
            .block_sequence_entry => p.parseBlockSequenceEntry(false),
            .indentless_sequence_entry => p.parseIndentlessSequenceEntry(),
            .block_mapping_first_key => p.parseBlockMappingKey(true),
            .block_mapping_key => p.parseBlockMappingKey(false),
            .block_mapping_value => p.parseBlockMappingValue(),
            .flow_sequence_first_entry => p.parseFlowSequenceEntry(true),
            .flow_sequence_entry => p.parseFlowSequenceEntry(false),
            .flow_sequence_entry_mapping_key => p.parseFlowSequenceEntryMappingKey(),
            .flow_sequence_entry_mapping_value => p.parseFlowSequenceEntryMappingValue(),
            .flow_sequence_entry_mapping_end => p.parseFlowSequenceEntryMappingEnd(),
            .flow_mapping_first_key => p.parseFlowMappingKey(true),
            .flow_mapping_key => p.parseFlowMappingKey(false),
            .flow_mapping_value => p.parseFlowMappingValue(false),
            .flow_mapping_empty_value => p.parseFlowMappingValue(true),
            .end => .{ .type = .stream_end, .start = p.scanner.mark },
        };
    }

    fn fail(p: *Parser, mark: Mark, message: []const u8) Error {
        p.diag.* = .{ .message = message, .mark = mark };
        return error.Syntax;
    }

    fn peek(p: *Parser) Error!*const Token {
        return p.scanner.peek();
    }

    fn skip(p: *Parser) void {
        const head = p.scanner.tokens.items[p.scanner.tokens_head];
        p.stream_end_produced = head.type == .stream_end;
        p.scanner.skipToken();
    }

    fn push(p: *Parser, state: State) Error!void {
        try p.states.append(p.arena, state);
    }

    fn pop(p: *Parser) void {
        p.state = p.states.pop() orelse .end;
    }

    fn parseStreamStart(p: *Parser) Error!Event {
        const token = try p.peek();
        if (token.type != .stream_start) return p.fail(token.start, "did not find expected <stream-start>");
        const event: Event = .{ .type = .stream_start, .start = token.start };
        p.state = .implicit_document_start;
        p.skip();
        return event;
    }

    fn parseDocumentStart(p: *Parser, implicit: bool) Error!Event {
        var token = try p.peek();
        if (!implicit) {
            // Extra document end markers are skipped.
            while (token.type == .document_end) {
                p.skip();
                token = try p.peek();
            }
        }
        if (implicit and token.type != .version_directive and token.type != .tag_directive and
            token.type != .document_start and token.type != .stream_end)
        {
            try p.processDirectives();
            try p.push(.document_end);
            p.state = .block_node;
            return .{ .type = .document_start, .start = token.start };
        }
        if (token.type != .stream_end) {
            const start = token.start;
            try p.processDirectives();
            token = try p.peek();
            if (token.type != .document_start) return p.fail(token.start, "did not find expected <document start>");
            try p.push(.document_end);
            p.state = .document_content;
            p.skip();
            return .{ .type = .document_start, .start = start };
        }
        const event: Event = .{ .type = .stream_end, .start = token.start };
        p.state = .end;
        p.skip();
        return event;
    }

    fn parseDocumentContent(p: *Parser) Error!Event {
        const token = try p.peek();
        switch (token.type) {
            .version_directive, .tag_directive, .document_start, .document_end, .stream_end => {
                p.pop();
                return emptyScalar(token.start);
            },
            else => return p.parseNode(true, false),
        }
    }

    fn parseDocumentEnd(p: *Parser) Error!Event {
        const token = try p.peek();
        const start = token.start;
        if (token.type == .document_end) p.skip();
        p.tag_directives.clearRetainingCapacity();
        p.state = .document_start;
        return .{ .type = .document_end, .start = start };
    }

    fn processDirectives(p: *Parser) Error!void {
        var have_version = false;
        var token = try p.peek();
        while (token.type == .version_directive or token.type == .tag_directive) {
            if (token.type == .version_directive) {
                if (have_version) return p.fail(token.start, "found duplicate %YAML directive");
                if (token.major != 1 or token.minor != 1) return p.fail(token.start, "found incompatible YAML document");
                have_version = true;
            } else {
                try p.appendTagDirective(.{ .handle = token.value, .prefix = token.suffix }, false, token.start);
            }
            p.skip();
            token = try p.peek();
        }
        for (default_tag_directives) |d| try p.appendTagDirective(d, true, token.start);
    }

    fn appendTagDirective(p: *Parser, value: TagDirective, allow_duplicates: bool, mark: Mark) Error!void {
        for (p.tag_directives.items) |d| {
            if (std.mem.eql(u8, d.handle, value.handle)) {
                if (allow_duplicates) return;
                return p.fail(mark, "found duplicate %TAG directive");
            }
        }
        try p.tag_directives.append(p.arena, value);
    }

    fn parseNode(p: *Parser, block: bool, indentless_sequence: bool) Error!Event {
        var token = try p.peek();
        if (token.type == .alias) {
            const event: Event = .{ .type = .alias, .start = token.start, .anchor = token.value };
            p.pop();
            p.skip();
            return event;
        }

        const start = token.start;
        var anchor: []const u8 = "";
        var have_tag = false;
        var tag_handle: []const u8 = "";
        var tag_suffix: []const u8 = "";
        var tag_mark = start;
        if (token.type == .anchor) {
            anchor = token.value;
            p.skip();
            token = try p.peek();
            if (token.type == .tag) {
                have_tag = true;
                tag_handle = token.value;
                tag_suffix = token.suffix;
                tag_mark = token.start;
                p.skip();
                token = try p.peek();
            }
        } else if (token.type == .tag) {
            have_tag = true;
            tag_handle = token.value;
            tag_suffix = token.suffix;
            tag_mark = token.start;
            p.skip();
            token = try p.peek();
            if (token.type == .anchor) {
                anchor = token.value;
                p.skip();
                token = try p.peek();
            }
        }

        var tag: []const u8 = "";
        if (have_tag) {
            if (tag_handle.len == 0) {
                tag = tag_suffix;
            } else {
                for (p.tag_directives.items) |d| {
                    if (std.mem.eql(u8, d.handle, tag_handle)) {
                        tag = try std.mem.concat(p.arena, u8, &.{ d.prefix, tag_suffix });
                        break;
                    }
                }
                if (tag.len == 0) return p.fail(tag_mark, "found undefined tag handle");
            }
        }

        if (indentless_sequence and token.type == .block_entry) {
            p.state = .indentless_sequence_entry;
            return .{ .type = .sequence_start, .start = start, .anchor = anchor, .tag = tag };
        }
        switch (token.type) {
            .scalar => {
                const event: Event = .{
                    .type = .scalar,
                    .start = start,
                    .anchor = anchor,
                    .tag = tag,
                    .value = token.value,
                    .style = token.style,
                };
                p.pop();
                p.skip();
                return event;
            },
            .flow_sequence_start => {
                p.state = .flow_sequence_first_entry;
                return .{ .type = .sequence_start, .start = start, .anchor = anchor, .tag = tag };
            },
            .flow_mapping_start => {
                p.state = .flow_mapping_first_key;
                return .{ .type = .mapping_start, .start = start, .anchor = anchor, .tag = tag };
            },
            .block_sequence_start => if (block) {
                p.state = .block_sequence_first_entry;
                return .{ .type = .sequence_start, .start = start, .anchor = anchor, .tag = tag };
            },
            .block_mapping_start => if (block) {
                p.state = .block_mapping_first_key;
                return .{ .type = .mapping_start, .start = start, .anchor = anchor, .tag = tag };
            },
            else => {},
        }
        if (anchor.len > 0 or tag.len > 0) {
            p.pop();
            return .{ .type = .scalar, .start = start, .anchor = anchor, .tag = tag };
        }
        return p.fail(token.start, "did not find expected node content");
    }

    fn parseBlockSequenceEntry(p: *Parser, first: bool) Error!Event {
        if (first) p.skip();
        var token = try p.peek();
        if (token.type == .block_entry) {
            const mark = token.end;
            p.skip();
            token = try p.peek();
            if (token.type != .block_entry and token.type != .block_end) {
                try p.push(.block_sequence_entry);
                return p.parseNode(true, false);
            }
            p.state = .block_sequence_entry;
            return emptyScalar(mark);
        }
        if (token.type == .block_end) {
            const event: Event = .{ .type = .sequence_end, .start = token.start };
            p.pop();
            p.skip();
            return event;
        }
        return p.fail(token.start, "did not find expected '-' indicator");
    }

    fn parseIndentlessSequenceEntry(p: *Parser) Error!Event {
        var token = try p.peek();
        if (token.type == .block_entry) {
            const mark = token.end;
            p.skip();
            token = try p.peek();
            if (token.type != .block_entry and token.type != .key and token.type != .value and token.type != .block_end) {
                try p.push(.indentless_sequence_entry);
                return p.parseNode(true, false);
            }
            p.state = .indentless_sequence_entry;
            return emptyScalar(mark);
        }
        p.pop();
        return .{ .type = .sequence_end, .start = token.start };
    }

    fn parseBlockMappingKey(p: *Parser, first: bool) Error!Event {
        if (first) p.skip();
        var token = try p.peek();
        if (token.type == .key) {
            const mark = token.end;
            p.skip();
            token = try p.peek();
            if (token.type != .key and token.type != .value and token.type != .block_end) {
                try p.push(.block_mapping_value);
                return p.parseNode(true, true);
            }
            p.state = .block_mapping_value;
            return emptyScalar(mark);
        }
        if (token.type == .block_end) {
            const event: Event = .{ .type = .mapping_end, .start = token.start };
            p.pop();
            p.skip();
            return event;
        }
        return p.fail(token.start, "did not find expected key");
    }

    fn parseBlockMappingValue(p: *Parser) Error!Event {
        var token = try p.peek();
        if (token.type == .value) {
            const mark = token.end;
            p.skip();
            token = try p.peek();
            if (token.type != .key and token.type != .value and token.type != .block_end) {
                try p.push(.block_mapping_key);
                return p.parseNode(true, true);
            }
            p.state = .block_mapping_key;
            return emptyScalar(mark);
        }
        p.state = .block_mapping_key;
        return emptyScalar(token.start);
    }

    fn parseFlowSequenceEntry(p: *Parser, first: bool) Error!Event {
        if (first) p.skip();
        var token = try p.peek();
        if (token.type != .flow_sequence_end) {
            if (!first) {
                if (token.type != .flow_entry) return p.fail(token.start, "did not find expected ',' or ']'");
                p.skip();
                token = try p.peek();
            }
            if (token.type == .key) {
                // A single pair, as in [a: b], is a one-entry flow mapping.
                const event: Event = .{ .type = .mapping_start, .start = token.start };
                p.state = .flow_sequence_entry_mapping_key;
                p.skip();
                return event;
            }
            if (token.type != .flow_sequence_end) {
                try p.push(.flow_sequence_entry);
                return p.parseNode(false, false);
            }
        }
        const event: Event = .{ .type = .sequence_end, .start = token.start };
        p.pop();
        p.skip();
        return event;
    }

    fn parseFlowSequenceEntryMappingKey(p: *Parser) Error!Event {
        const token = try p.peek();
        if (token.type != .value and token.type != .flow_entry and token.type != .flow_sequence_end) {
            try p.push(.flow_sequence_entry_mapping_value);
            return p.parseNode(false, false);
        }
        const mark = token.end;
        p.skip();
        p.state = .flow_sequence_entry_mapping_value;
        return emptyScalar(mark);
    }

    fn parseFlowSequenceEntryMappingValue(p: *Parser) Error!Event {
        var token = try p.peek();
        if (token.type == .value) {
            p.skip();
            token = try p.peek();
            if (token.type != .flow_entry and token.type != .flow_sequence_end) {
                try p.push(.flow_sequence_entry_mapping_end);
                return p.parseNode(false, false);
            }
        }
        p.state = .flow_sequence_entry_mapping_end;
        return emptyScalar(token.start);
    }

    fn parseFlowSequenceEntryMappingEnd(p: *Parser) Error!Event {
        const token = try p.peek();
        p.state = .flow_sequence_entry;
        return .{ .type = .mapping_end, .start = token.start };
    }

    fn parseFlowMappingKey(p: *Parser, first: bool) Error!Event {
        if (first) p.skip();
        var token = try p.peek();
        if (token.type != .flow_mapping_end) {
            if (!first) {
                if (token.type != .flow_entry) return p.fail(token.start, "did not find expected ',' or '}'");
                p.skip();
                token = try p.peek();
            }
            if (token.type == .key) {
                p.skip();
                token = try p.peek();
                if (token.type != .value and token.type != .flow_entry and token.type != .flow_mapping_end) {
                    try p.push(.flow_mapping_value);
                    return p.parseNode(false, false);
                }
                p.state = .flow_mapping_value;
                return emptyScalar(token.start);
            }
            if (token.type != .flow_mapping_end) {
                try p.push(.flow_mapping_empty_value);
                return p.parseNode(false, false);
            }
        }
        const event: Event = .{ .type = .mapping_end, .start = token.start };
        p.pop();
        p.skip();
        return event;
    }

    fn parseFlowMappingValue(p: *Parser, empty: bool) Error!Event {
        var token = try p.peek();
        if (empty) {
            p.state = .flow_mapping_key;
            return emptyScalar(token.start);
        }
        if (token.type == .value) {
            p.skip();
            token = try p.peek();
            if (token.type != .flow_entry and token.type != .flow_mapping_end) {
                try p.push(.flow_mapping_key);
                return p.parseNode(false, false);
            }
        }
        p.state = .flow_mapping_key;
        return emptyScalar(token.start);
    }

    fn emptyScalar(mark: Mark) Event {
        return .{ .type = .scalar, .start = mark };
    }
};

// Tests render the event stream compactly.

fn render(gpa: Allocator, src: []const u8) ![]u8 {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    var diag: Diagnostic = .{};
    var p: Parser = .init(arena.allocator(), src, &diag);
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    const w = &out.writer;
    while (true) {
        const e = p.next() catch |err| switch (err) {
            error.Syntax => {
                try w.print("ERR({s})", .{diag.message});
                break;
            },
            else => |x| return x,
        };
        switch (e.type) {
            .stream_start => try w.writeAll("+STR"),
            .stream_end => try w.writeAll("-STR"),
            .document_start => try w.writeAll("+DOC"),
            .document_end => try w.writeAll("-DOC"),
            .sequence_start => try w.print("+SEQ{s}{s}", .{ e.anchor, e.tag }),
            .sequence_end => try w.writeAll("-SEQ"),
            .mapping_start => try w.print("+MAP{s}{s}", .{ e.anchor, e.tag }),
            .mapping_end => try w.writeAll("-MAP"),
            .alias => try w.print("*{s}", .{e.anchor}),
            .scalar => try w.print("={s}{s}({s})", .{ e.anchor, e.tag, e.value }),
        }
        if (e.type == .stream_end) break;
        try w.writeByte(' ');
    }
    return out.toOwnedSlice();
}

fn expectEvents(src: []const u8, want: []const u8) !void {
    const got = try render(std.testing.allocator, src);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings(want, got);
}

test "a block mapping holding flow collections" {
    try expectEvents("a: {b: [c, d]}\n", "+STR +DOC +MAP =(a) +MAP =(b) +SEQ =(c) =(d) -SEQ -MAP -MAP -DOC -STR");
}

test "empty values and indentless sequences" {
    try expectEvents("a:\nb:\n- x\n-\n", "+STR +DOC +MAP =(a) =() =(b) +SEQ =(x) =() -SEQ -MAP -DOC -STR");
}

test "anchors, aliases and tags resolve through the directives" {
    try expectEvents("%TAG !e! tag:e.org,2000:\n--- !e!x &a {k: !!str v, l: *a}\n", "+STR +DOC +MAPatag:e.org,2000:x =(k) =tag:yaml.org,2002:str(v) =(l) *a -MAP -DOC -STR");
    try expectEvents("a: !x!y b\n", "+STR +DOC +MAP =(a) ERR(found undefined tag handle)");
}

test "documents" {
    try expectEvents("", "+STR -STR");
    try expectEvents("# only a comment\n", "+STR -STR");
    try expectEvents("---\n", "+STR +DOC =() -DOC -STR");
    try expectEvents("a\n...\n...\n", "+STR +DOC =(a) -DOC -STR");
    try expectEvents("a\n---\nb\n", "+STR +DOC =(a) -DOC +DOC =(b) -DOC -STR");
    try expectEvents("a\n...\nb\n", "+STR +DOC =(a) -DOC ERR(did not find expected <document start>)");
    try expectEvents("...\n", "+STR +DOC ERR(did not find expected node content)");
}

test "only YAML 1.1 is accepted" {
    try expectEvents("%YAML 1.1\n--- a\n", "+STR +DOC =(a) -DOC -STR");
    try expectEvents("%YAML 1.2\n--- a\n", "+STR ERR(found incompatible YAML document)");
    try expectEvents("%YAML 1.1\n%YAML 1.1\n--- a\n", "+STR ERR(found duplicate %YAML directive)");
}

test "a single pair in a flow sequence is a mapping" {
    try expectEvents("[a: b, c]\n", "+STR +DOC +SEQ +MAP =(a) =(b) -MAP =(c) -SEQ -DOC -STR");
}

test "flow collection errors" {
    try expectEvents("[a b]\n", "+STR +DOC +SEQ =(a b) -SEQ -DOC -STR");
    try expectEvents("{a: b c: d}\n", "+STR +DOC +MAP =(a) =(b c) ERR(did not find expected ',' or '}')");
}
