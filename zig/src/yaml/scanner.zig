//! The YAML scanner of libo11y's strict registry parser. It turns UTF-8
//! text into tokens the way gopkg.in/yaml.v3 does, because the application
//! registry must decode exactly as the Go implementation decodes it.
//!
//! The scanner follows the structure of libyaml's scanner as gopkg.in/yaml.v3
//! ports it (scannerc.go), including yaml.v3's own changes: tabs are
//! skipped after a simple key's ':', a '#' straight after a token starts a
//! comment, comment lines that follow a comment are skipped together, and a
//! stale simple key is only checked when the parser needs the next token.
//! Comment text is not kept. That code is covered by this notice:
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

/// A position in the input. index counts characters, with a CR LF pair
/// counted as two. line and column start at zero, and column counts
/// characters.
pub const Mark = struct {
    index: usize = 0,
    line: usize = 0,
    column: usize = 0,
};

pub const TokenType = enum {
    stream_start,
    stream_end,
    version_directive,
    tag_directive,
    document_start,
    document_end,
    block_sequence_start,
    block_mapping_start,
    block_end,
    flow_sequence_start,
    flow_sequence_end,
    flow_mapping_start,
    flow_mapping_end,
    block_entry,
    flow_entry,
    key,
    value,
    alias,
    anchor,
    tag,
    scalar,
};

pub const ScalarStyle = enum { plain, single_quoted, double_quoted, literal, folded };

pub const Token = struct {
    type: TokenType,
    start: Mark,
    end: Mark,
    /// A scalar's value, an anchor or alias name, a tag's handle, or a %TAG
    /// directive's handle.
    value: []const u8 = "",
    /// A tag's suffix or a %TAG directive's prefix.
    suffix: []const u8 = "",
    style: ScalarStyle = .plain,
    major: u8 = 0,
    minor: u8 = 0,
};

pub const Error = error{ Syntax, OutOfMemory };

/// Where and why scanning or parsing failed.
pub const Diagnostic = struct {
    message: []const u8 = "",
    mark: Mark = .{},
};

const SimpleKey = struct {
    possible: bool = false,
    required: bool = false,
    token_number: usize = 0,
    mark: Mark = .{},
};

/// The deepest flow nesting and the most block indentation levels yaml.v3
/// accepts.
const max_flow_level = 10000;
const max_indents = 10000;

pub const Scanner = struct {
    /// Every token value and the scanner's own state live in this
    /// allocator, which is expected to be an arena.
    arena: Allocator,
    src: []const u8,
    diag: *Diagnostic,
    pos: usize = 0,
    mark: Mark = .{},
    /// Line breaks consumed since the last non-blank character.
    newlines: usize = 0,
    tokens: std.ArrayList(Token) = .empty,
    tokens_head: usize = 0,
    tokens_parsed: usize = 0,
    token_available: bool = false,
    stream_start_produced: bool = false,
    indent: isize = -1,
    indents: std.ArrayList(isize) = .empty,
    simple_key_allowed: bool = false,
    simple_keys: std.ArrayList(SimpleKey) = .empty,
    simple_keys_by_tok: std.AutoHashMapUnmanaged(usize, usize) = .empty,
    flow_level: usize = 0,

    /// src must be valid UTF-8 without a byte order mark at the start, as
    /// reader.decode returns it.
    pub fn init(arena: Allocator, src: []const u8, diag: *Diagnostic) Scanner {
        return .{ .arena = arena, .src = src, .diag = diag };
    }

    /// Returns the next token without consuming it.
    pub fn peek(s: *Scanner) Error!*const Token {
        if (!s.token_available) try s.fetchMoreTokens();
        return &s.tokens.items[s.tokens_head];
    }

    /// Consumes the token peek returned.
    pub fn skipToken(s: *Scanner) void {
        s.token_available = false;
        s.tokens_parsed += 1;
        s.tokens_head += 1;
    }

    fn fail(s: *Scanner, mark: Mark, message: []const u8) Error {
        s.diag.* = .{ .message = message, .mark = mark };
        return error.Syntax;
    }

    // Character classes, read at an offset from the current position. Past
    // the end of the input every byte reads as 0, as libyaml's buffer does.

    fn at(s: *const Scanner, k: usize) u8 {
        const i = s.pos + k;
        return if (i < s.src.len) s.src[i] else 0;
    }

    fn isZ(s: *const Scanner, k: usize) bool {
        return s.pos + k >= s.src.len;
    }

    fn isBlank(s: *const Scanner, k: usize) bool {
        const c = s.at(k);
        return c == ' ' or c == '\t';
    }

    fn isBreak(s: *const Scanner, k: usize) bool {
        const c = s.at(k);
        return c == '\r' or c == '\n' or
            (c == 0xC2 and s.at(k + 1) == 0x85) or
            (c == 0xE2 and s.at(k + 1) == 0x80 and (s.at(k + 2) == 0xA8 or s.at(k + 2) == 0xA9));
    }

    fn isBreakz(s: *const Scanner, k: usize) bool {
        return s.isBreak(k) or s.isZ(k);
    }

    fn isBlankz(s: *const Scanner, k: usize) bool {
        return s.isBlank(k) or s.isBreakz(k);
    }

    fn isCrlf(s: *const Scanner, k: usize) bool {
        return s.at(k) == '\r' and s.at(k + 1) == '\n';
    }

    fn isAlpha(s: *const Scanner, k: usize) bool {
        const c = s.at(k);
        return std.ascii.isAlphanumeric(c) or c == '_' or c == '-';
    }

    fn isDigit(s: *const Scanner, k: usize) bool {
        return std.ascii.isDigit(s.at(k));
    }

    fn isHex(s: *const Scanner, k: usize) bool {
        return std.ascii.isHex(s.at(k));
    }

    fn asHex(s: *const Scanner, k: usize) u32 {
        const c = s.at(k);
        return switch (c) {
            '0'...'9' => c - '0',
            'a'...'f' => c - 'a' + 10,
            'A'...'F' => c - 'A' + 10,
            else => 0,
        };
    }

    fn width(c: u8) usize {
        if (c & 0x80 == 0) return 1;
        if (c & 0xE0 == 0xC0) return 2;
        if (c & 0xF0 == 0xE0) return 3;
        if (c & 0xF8 == 0xF0) return 4;
        return 1;
    }

    fn columnI(s: *const Scanner) isize {
        return @intCast(s.mark.column);
    }

    // Movement.

    fn skip(s: *Scanner) void {
        if (!s.isBlank(0)) s.newlines = 0;
        s.mark.index += 1;
        s.mark.column += 1;
        s.pos = @min(s.pos + width(s.at(0)), s.src.len);
    }

    fn skipLine(s: *Scanner) void {
        if (s.isCrlf(0)) {
            s.mark.index += 2;
            s.mark.column = 0;
            s.mark.line += 1;
            s.pos += 2;
            s.newlines += 1;
        } else if (s.isBreak(0)) {
            s.mark.index += 1;
            s.mark.column = 0;
            s.mark.line += 1;
            s.pos += width(s.at(0));
            s.newlines += 1;
        }
    }

    /// Appends the current character to out and moves past it.
    fn read(s: *Scanner, out: *std.ArrayList(u8)) Error!void {
        if (!s.isBlank(0)) s.newlines = 0;
        const w = @min(width(s.at(0)), s.src.len - s.pos);
        try out.appendSlice(s.arena, s.src[s.pos..][0..w]);
        s.pos += w;
        s.mark.index += 1;
        s.mark.column += 1;
    }

    /// Appends the current line break to out, normalized as yaml.v3 does:
    /// CR LF, CR, LF and NEL become LF, and LS and PS stay as they are.
    fn readLine(s: *Scanner, out: *std.ArrayList(u8)) Error!void {
        if (s.isCrlf(0)) {
            try out.append(s.arena, '\n');
            s.pos += 2;
            s.mark.index += 1;
        } else if (s.at(0) == '\r' or s.at(0) == '\n') {
            try out.append(s.arena, '\n');
            s.pos += 1;
        } else if (s.at(0) == 0xC2 and s.at(1) == 0x85) {
            try out.append(s.arena, '\n');
            s.pos += 2;
        } else if (s.at(0) == 0xE2 and s.at(1) == 0x80 and (s.at(2) == 0xA8 or s.at(2) == 0xA9)) {
            try out.appendSlice(s.arena, s.src[s.pos..][0..3]);
            s.pos += 3;
        } else return;
        s.mark.index += 1;
        s.mark.column = 0;
        s.mark.line += 1;
        s.newlines += 1;
    }

    // The token queue.

    /// Queues token. number, when given, is the token number to insert it
    /// at. yaml.v3 appends a token whose number the parser has already
    /// passed, which a simple key can have once its flow collection closed.
    fn insertToken(s: *Scanner, number: ?usize, token: Token) Error!void {
        // Drop the tokens the parser has consumed once they fill half the
        // queue, so a long document does not keep every token it has had.
        if (s.tokens_head > 0 and s.tokens_head * 2 >= s.tokens.items.len) {
            const rest = s.tokens.items[s.tokens_head..];
            std.mem.copyForwards(Token, s.tokens.items[0..rest.len], rest);
            s.tokens.shrinkRetainingCapacity(rest.len);
            s.tokens_head = 0;
        }
        if (number) |n| {
            if (n >= s.tokens_parsed) {
                return s.tokens.insert(s.arena, s.tokens_head + (n - s.tokens_parsed), token);
            }
        }
        try s.tokens.append(s.arena, token);
    }

    fn fetchMoreTokens(s: *Scanner) Error!void {
        while (true) {
            // yaml.v3 keeps two tokens of lookahead, and more while the head
            // token may still turn out to be a simple key.
            if (s.tokens_head + 2 < s.tokens.items.len) {
                const idx = s.simple_keys_by_tok.get(s.tokens_parsed) orelse break;
                if (idx >= s.simple_keys.items.len) break;
                if (!try s.simpleKeyIsValid(&s.simple_keys.items[idx])) break;
            }
            try s.fetchNextToken();
        }
        s.token_available = true;
    }

    fn fetchNextToken(s: *Scanner) Error!void {
        if (!s.stream_start_produced) return s.fetchStreamStart();

        const scan_mark = s.mark;
        try s.scanToNextToken();
        try s.unrollIndent(s.columnI(), scan_mark);

        if (s.isZ(0)) return s.fetchStreamEnd();

        if (s.mark.column == 0 and s.at(0) == '%') return s.fetchDirective();
        if (s.mark.column == 0 and s.at(0) == '-' and s.at(1) == '-' and s.at(2) == '-' and s.isBlankz(3)) {
            return s.fetchDocumentIndicator(.document_start);
        }
        if (s.mark.column == 0 and s.at(0) == '.' and s.at(1) == '.' and s.at(2) == '.' and s.isBlankz(3)) {
            return s.fetchDocumentIndicator(.document_end);
        }

        try s.fetchContentToken();
        // yaml.v3 reads a comment that follows a token on its line, even
        // with no blank before the '#', except after a block entry.
        const last = s.tokens.items[s.tokens.items.len - 1];
        if (last.type != .block_entry) s.scanLineComment();
    }

    fn fetchContentToken(s: *Scanner) Error!void {
        const c = s.at(0);
        switch (c) {
            '[' => return s.fetchFlowCollectionStart(.flow_sequence_start),
            '{' => return s.fetchFlowCollectionStart(.flow_mapping_start),
            ']' => return s.fetchFlowCollectionEnd(.flow_sequence_end),
            '}' => return s.fetchFlowCollectionEnd(.flow_mapping_end),
            ',' => return s.fetchFlowEntry(),
            else => {},
        }
        if (c == '-' and s.isBlankz(1)) return s.fetchBlockEntry();
        if (c == '?' and (s.flow_level > 0 or s.isBlankz(1))) return s.fetchKey();
        if (c == ':' and (s.flow_level > 0 or s.isBlankz(1))) return s.fetchValue();
        switch (c) {
            '*' => return s.fetchAnchor(.alias),
            '&' => return s.fetchAnchor(.anchor),
            '!' => return s.fetchTag(),
            '|' => if (s.flow_level == 0) return s.fetchBlockScalar(true),
            '>' => if (s.flow_level == 0) return s.fetchBlockScalar(false),
            '\'' => return s.fetchFlowScalar(true),
            '"' => return s.fetchFlowScalar(false),
            else => {},
        }
        const indicator = switch (c) {
            '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`' => true,
            else => false,
        };
        if (!(s.isBlankz(0) or indicator) or
            (c == '-' and !s.isBlank(1)) or
            (s.flow_level == 0 and (c == '?' or c == ':') and !s.isBlankz(1)))
        {
            return s.fetchPlainScalar();
        }
        return s.fail(s.mark, "found character that cannot start any token");
    }

    // Simple keys.

    fn simpleKeyIsValid(s: *Scanner, key: *SimpleKey) Error!bool {
        if (!key.possible) return false;
        if (key.mark.line < s.mark.line or key.mark.index + 1024 < s.mark.index) {
            if (key.required) return s.fail(key.mark, "could not find expected ':'");
            key.possible = false;
            return false;
        }
        return true;
    }

    fn saveSimpleKey(s: *Scanner) Error!void {
        const required = s.flow_level == 0 and s.indent == s.columnI();
        if (!s.simple_key_allowed) return;
        const key: SimpleKey = .{
            .possible = true,
            .required = required,
            .token_number = s.tokens_parsed + (s.tokens.items.len - s.tokens_head),
            .mark = s.mark,
        };
        try s.removeSimpleKey();
        const idx = s.simple_keys.items.len - 1;
        s.simple_keys.items[idx] = key;
        try s.simple_keys_by_tok.put(s.arena, key.token_number, idx);
    }

    fn removeSimpleKey(s: *Scanner) Error!void {
        const key = &s.simple_keys.items[s.simple_keys.items.len - 1];
        if (key.possible) {
            if (key.required) return s.fail(key.mark, "could not find expected ':'");
            key.possible = false;
            _ = s.simple_keys_by_tok.remove(key.token_number);
        }
    }

    fn increaseFlowLevel(s: *Scanner) Error!void {
        try s.simple_keys.append(s.arena, .{
            .token_number = s.tokens_parsed + (s.tokens.items.len - s.tokens_head),
            .mark = s.mark,
        });
        s.flow_level += 1;
        if (s.flow_level > max_flow_level) {
            return s.fail(s.simple_keys.items[s.simple_keys.items.len - 1].mark, "exceeded max depth of 10000");
        }
    }

    fn decreaseFlowLevel(s: *Scanner) void {
        if (s.flow_level > 0) {
            s.flow_level -= 1;
            const last = s.simple_keys.pop() orelse return;
            _ = s.simple_keys_by_tok.remove(last.token_number);
        }
    }

    // Indentation.

    fn rollIndent(s: *Scanner, column: isize, number: ?usize, typ: TokenType, mark: Mark) Error!void {
        if (s.flow_level > 0) return;
        if (s.indent < column) {
            try s.indents.append(s.arena, s.indent);
            s.indent = column;
            if (s.indents.items.len > max_indents) {
                return s.fail(s.simple_keys.items[s.simple_keys.items.len - 1].mark, "exceeded max depth of 10000");
            }
            const token: Token = .{ .type = typ, .start = mark, .end = mark };
            try s.insertToken(number, token);
        }
    }

    fn unrollIndent(s: *Scanner, column: isize, scan_mark: Mark) Error!void {
        if (s.flow_level > 0) return;
        var block_mark = scan_mark;
        block_mark.index -%= 1;
        while (s.indent > column) {
            try s.insertToken(null, .{ .type = .block_end, .start = block_mark, .end = block_mark });
            s.indent = s.indents.pop() orelse -1;
        }
    }

    // Fetchers.

    fn fetchStreamStart(s: *Scanner) Error!void {
        s.indent = -1;
        try s.simple_keys.append(s.arena, .{});
        s.simple_key_allowed = true;
        s.stream_start_produced = true;
        try s.insertToken(null, .{ .type = .stream_start, .start = s.mark, .end = s.mark });
    }

    fn fetchStreamEnd(s: *Scanner) Error!void {
        if (s.mark.column != 0) {
            s.mark.column = 0;
            s.mark.line += 1;
        }
        try s.unrollIndent(-1, s.mark);
        try s.removeSimpleKey();
        s.simple_key_allowed = false;
        try s.insertToken(null, .{ .type = .stream_end, .start = s.mark, .end = s.mark });
    }

    fn fetchDirective(s: *Scanner) Error!void {
        try s.unrollIndent(-1, s.mark);
        try s.removeSimpleKey();
        s.simple_key_allowed = false;
        const token = try s.scanDirective();
        try s.insertToken(null, token);
    }

    fn fetchDocumentIndicator(s: *Scanner, typ: TokenType) Error!void {
        try s.unrollIndent(-1, s.mark);
        try s.removeSimpleKey();
        s.simple_key_allowed = false;
        const start = s.mark;
        s.skip();
        s.skip();
        s.skip();
        try s.insertToken(null, .{ .type = typ, .start = start, .end = s.mark });
    }

    fn fetchFlowCollectionStart(s: *Scanner, typ: TokenType) Error!void {
        try s.saveSimpleKey();
        try s.increaseFlowLevel();
        s.simple_key_allowed = true;
        const start = s.mark;
        s.skip();
        try s.insertToken(null, .{ .type = typ, .start = start, .end = s.mark });
    }

    fn fetchFlowCollectionEnd(s: *Scanner, typ: TokenType) Error!void {
        try s.removeSimpleKey();
        s.decreaseFlowLevel();
        s.simple_key_allowed = false;
        const start = s.mark;
        s.skip();
        try s.insertToken(null, .{ .type = typ, .start = start, .end = s.mark });
    }

    fn fetchFlowEntry(s: *Scanner) Error!void {
        try s.removeSimpleKey();
        s.simple_key_allowed = true;
        const start = s.mark;
        s.skip();
        try s.insertToken(null, .{ .type = .flow_entry, .start = start, .end = s.mark });
    }

    fn fetchBlockEntry(s: *Scanner) Error!void {
        if (s.flow_level == 0) {
            if (!s.simple_key_allowed) {
                return s.fail(s.mark, "block sequence entries are not allowed in this context");
            }
            try s.rollIndent(s.columnI(), null, .block_sequence_start, s.mark);
        }
        try s.removeSimpleKey();
        s.simple_key_allowed = true;
        const start = s.mark;
        s.skip();
        try s.insertToken(null, .{ .type = .block_entry, .start = start, .end = s.mark });
    }

    fn fetchKey(s: *Scanner) Error!void {
        if (s.flow_level == 0) {
            if (!s.simple_key_allowed) {
                return s.fail(s.mark, "mapping keys are not allowed in this context");
            }
            try s.rollIndent(s.columnI(), null, .block_mapping_start, s.mark);
        }
        try s.removeSimpleKey();
        s.simple_key_allowed = s.flow_level == 0;
        const start = s.mark;
        s.skip();
        try s.insertToken(null, .{ .type = .key, .start = start, .end = s.mark });
    }

    fn fetchValue(s: *Scanner) Error!void {
        const key = &s.simple_keys.items[s.simple_keys.items.len - 1];
        if (try s.simpleKeyIsValid(key)) {
            const key_mark = key.mark;
            const key_number = key.token_number;
            try s.insertToken(key_number, .{ .type = .key, .start = key_mark, .end = key_mark });
            try s.rollIndent(@intCast(key_mark.column), key_number, .block_mapping_start, key_mark);
            // rollIndent may have grown simple_keys' backing memory, so the
            // key is looked up again.
            const k = &s.simple_keys.items[s.simple_keys.items.len - 1];
            k.possible = false;
            _ = s.simple_keys_by_tok.remove(key_number);
            s.simple_key_allowed = false;
        } else {
            if (s.flow_level == 0) {
                if (!s.simple_key_allowed) {
                    return s.fail(s.mark, "mapping values are not allowed in this context");
                }
                try s.rollIndent(s.columnI(), null, .block_mapping_start, s.mark);
            }
            s.simple_key_allowed = s.flow_level == 0;
        }
        const start = s.mark;
        s.skip();
        try s.insertToken(null, .{ .type = .value, .start = start, .end = s.mark });
    }

    fn fetchAnchor(s: *Scanner, typ: TokenType) Error!void {
        try s.saveSimpleKey();
        s.simple_key_allowed = false;
        const token = try s.scanAnchor(typ);
        try s.insertToken(null, token);
    }

    fn fetchTag(s: *Scanner) Error!void {
        try s.saveSimpleKey();
        s.simple_key_allowed = false;
        const token = try s.scanTag();
        try s.insertToken(null, token);
    }

    fn fetchBlockScalar(s: *Scanner, literal: bool) Error!void {
        try s.removeSimpleKey();
        s.simple_key_allowed = true;
        const token = try s.scanBlockScalar(literal);
        try s.insertToken(null, token);
    }

    fn fetchFlowScalar(s: *Scanner, single: bool) Error!void {
        try s.saveSimpleKey();
        s.simple_key_allowed = false;
        const token = try s.scanFlowScalar(single);
        try s.insertToken(null, token);
    }

    fn fetchPlainScalar(s: *Scanner) Error!void {
        try s.saveSimpleKey();
        s.simple_key_allowed = false;
        const token = try s.scanPlainScalar();
        try s.insertToken(null, token);
    }

    // Whitespace and comments.

    fn scanToNextToken(s: *Scanner) Error!void {
        while (true) {
            // yaml.v3 skips a byte order mark at the start of a line only
            // when its read buffer happens to begin with one, which depends
            // on how it reads the input in chunks. libo11y never skips one
            // here. The reader drops one at the start of the input.
            // Tabs are skipped in the flow context and after a simple key's
            // ':', but not at the start of a line or after '-', '?' or ':'.
            while (s.at(0) == ' ' or ((s.flow_level > 0 or !s.simple_key_allowed) and s.at(0) == '\t')) {
                s.skip();
            }
            if (s.at(0) == '#') s.scanComments();
            if (s.isBreak(0)) {
                s.skipLine();
                if (s.flow_level == 0) s.simple_key_allowed = true;
            } else break;
        }
    }

    /// Skips a comment that follows a token on the same line.
    fn scanLineComment(s: *Scanner) void {
        if (s.newlines > 0) return;
        var ahead: usize = 0;
        while (ahead < 512) : (ahead += 1) {
            if (s.isBlank(ahead)) continue;
            if (s.at(ahead) == '#') {
                while (ahead > 0) : (ahead -= 1) s.skip();
                while (!s.isBreakz(0)) s.skip();
            }
            break;
        }
    }

    /// Skips the comment at the current position, and every comment line
    /// that follows it with only blanks and line breaks in between, the way
    /// yaml.v3 reads a block of comments. The blanks it skips may be tabs.
    fn scanComments(s: *Scanner) void {
        var ahead: usize = 0;
        while (ahead < 512) : (ahead += 1) {
            if (s.isBlank(ahead)) continue;
            const c = s.at(ahead);
            const close_flow = s.flow_level > 0 and (c == ']' or c == '}');
            if (close_flow or s.isBreakz(ahead)) {
                if (!s.isBreak(ahead)) break;
                continue;
            }
            if (c != '#') break;
            const target = s.pos + ahead;
            while (s.pos < target) {
                if (s.isBreak(0)) s.skipLine() else s.skip();
            }
            while (!s.isBreakz(0)) s.skip();
            // yaml.v3 resets its lookahead to 0 here, and the loop's
            // increment then moves it to 1, past the line break.
            ahead = 0;
        }
    }

    // Scanners.

    fn scanDirective(s: *Scanner) Error!Token {
        const start = s.mark;
        s.skip();
        var name: std.ArrayList(u8) = .empty;
        while (s.isAlpha(0)) try s.read(&name);
        if (name.items.len == 0) return s.fail(start, "could not find expected directive name");
        if (!s.isBlankz(0)) return s.fail(start, "found unexpected non-alphabetical character");

        var token: Token = undefined;
        if (std.mem.eql(u8, name.items, "YAML")) {
            while (s.isBlank(0)) s.skip();
            const major = try s.scanVersionNumber(start);
            if (s.at(0) != '.') return s.fail(start, "did not find expected digit or '.' character");
            s.skip();
            const minor = try s.scanVersionNumber(start);
            token = .{ .type = .version_directive, .start = start, .end = s.mark, .major = major, .minor = minor };
        } else if (std.mem.eql(u8, name.items, "TAG")) {
            while (s.isBlank(0)) s.skip();
            const handle = try s.scanTagHandle(true, start);
            if (!s.isBlank(0)) return s.fail(start, "did not find expected whitespace");
            while (s.isBlank(0)) s.skip();
            const prefix = try s.scanTagUri(true, "", start);
            if (!s.isBlankz(0)) return s.fail(start, "did not find expected whitespace or line break");
            token = .{ .type = .tag_directive, .start = start, .end = s.mark, .value = handle, .suffix = prefix };
        } else {
            return s.fail(start, "found unknown directive name");
        }

        while (s.isBlank(0)) s.skip();
        if (s.at(0) == '#') {
            while (!s.isBreakz(0)) s.skip();
        }
        if (!s.isBreakz(0)) return s.fail(start, "did not find expected comment or line break");
        if (s.isBreak(0)) s.skipLine();
        return token;
    }

    fn scanVersionNumber(s: *Scanner, start: Mark) Error!u8 {
        var value: u8 = 0;
        var length: usize = 0;
        while (s.isDigit(0)) {
            length += 1;
            if (length > 2) return s.fail(start, "found extremely long version number");
            value = value * 10 + (s.at(0) - '0');
            s.skip();
        }
        if (length == 0) return s.fail(start, "did not find expected version number");
        return value;
    }

    fn scanAnchor(s: *Scanner, typ: TokenType) Error!Token {
        const start = s.mark;
        s.skip();
        var name: std.ArrayList(u8) = .empty;
        while (s.isAlpha(0)) try s.read(&name);
        const end = s.mark;
        const c = s.at(0);
        if (name.items.len == 0 or !(s.isBlankz(0) or c == '?' or c == ':' or c == ',' or c == ']' or
            c == '}' or c == '%' or c == '@' or c == '`'))
        {
            return s.fail(start, "did not find expected alphabetic or numeric character");
        }
        return .{ .type = typ, .start = start, .end = end, .value = name.items };
    }

    fn scanTag(s: *Scanner) Error!Token {
        const start = s.mark;
        var handle: []const u8 = "";
        var suffix: []const u8 = "";
        if (s.at(1) == '<') {
            // A verbatim tag: !<uri>.
            s.skip();
            s.skip();
            suffix = try s.scanTagUri(false, "", start);
            if (s.at(0) != '>') return s.fail(start, "did not find the expected '>'");
            s.skip();
        } else {
            handle = try s.scanTagHandle(false, start);
            if (handle[0] == '!' and handle.len > 1 and handle[handle.len - 1] == '!') {
                suffix = try s.scanTagUri(false, "", start);
            } else {
                // Either '!suffix' or a bare '!'.
                suffix = try s.scanTagUri(false, handle, start);
                handle = "!";
                if (suffix.len == 0) {
                    handle = "";
                    suffix = "!";
                }
            }
        }
        if (!s.isBlankz(0)) return s.fail(start, "did not find expected whitespace or line break");
        return .{ .type = .tag, .start = start, .end = s.mark, .value = handle, .suffix = suffix };
    }

    fn scanTagHandle(s: *Scanner, directive: bool, start: Mark) Error![]const u8 {
        if (s.at(0) != '!') return s.fail(start, "did not find expected '!'");
        var out: std.ArrayList(u8) = .empty;
        try s.read(&out);
        while (s.isAlpha(0)) try s.read(&out);
        if (s.at(0) == '!') {
            try s.read(&out);
        } else if (directive and !std.mem.eql(u8, out.items, "!")) {
            return s.fail(start, "did not find expected '!'");
        }
        return out.items;
    }

    fn scanTagUri(s: *Scanner, directive: bool, head: []const u8, start: Mark) Error![]const u8 {
        _ = directive;
        var out: std.ArrayList(u8) = .empty;
        var has_tag = head.len > 0;
        if (head.len > 1) try out.appendSlice(s.arena, head[1..]);
        while (true) {
            const c = s.at(0);
            const ok = s.isAlpha(0) or switch (c) {
                ';', '/', '?', ':', '@', '&', '=', '+', '$', ',', '.', '!', '~', '*', '\'', '(', ')', '[', ']', '%' => true,
                else => false,
            };
            if (!ok) break;
            if (c == '%') {
                try s.scanUriEscapes(start, &out);
            } else {
                try s.read(&out);
            }
            has_tag = true;
        }
        if (!has_tag) return s.fail(start, "did not find expected tag URI");
        return out.items;
    }

    fn scanUriEscapes(s: *Scanner, start: Mark, out: *std.ArrayList(u8)) Error!void {
        var w: usize = 1024;
        while (w > 0) {
            if (!(s.at(0) == '%' and s.isHex(1) and s.isHex(2))) {
                return s.fail(start, "did not find URI escaped octet");
            }
            const octet: u8 = @intCast((s.asHex(1) << 4) + s.asHex(2));
            if (w == 1024) {
                w = switch (octet) {
                    0x00...0x7F => 1,
                    0xC0...0xDF => 2,
                    0xE0...0xEF => 3,
                    0xF0...0xF7 => 4,
                    else => return s.fail(start, "found an incorrect leading UTF-8 octet"),
                };
            } else if (octet & 0xC0 != 0x80) {
                return s.fail(start, "found an incorrect trailing UTF-8 octet");
            }
            try out.append(s.arena, octet);
            s.skip();
            s.skip();
            s.skip();
            w -= 1;
        }
    }

    fn scanBlockScalar(s: *Scanner, literal: bool) Error!Token {
        const start = s.mark;
        s.skip();
        var chomping: i8 = 0;
        var increment: usize = 0;
        if (s.at(0) == '+' or s.at(0) == '-') {
            chomping = if (s.at(0) == '+') 1 else -1;
            s.skip();
            if (s.isDigit(0)) {
                if (s.at(0) == '0') return s.fail(start, "found an indentation indicator equal to 0");
                increment = s.at(0) - '0';
                s.skip();
            }
        } else if (s.isDigit(0)) {
            if (s.at(0) == '0') return s.fail(start, "found an indentation indicator equal to 0");
            increment = s.at(0) - '0';
            s.skip();
            if (s.at(0) == '+' or s.at(0) == '-') {
                chomping = if (s.at(0) == '+') 1 else -1;
                s.skip();
            }
        }
        while (s.isBlank(0)) s.skip();
        if (s.at(0) == '#') {
            while (!s.isBreakz(0)) s.skip();
        }
        if (!s.isBreakz(0)) return s.fail(start, "did not find expected comment or line break");
        if (s.isBreak(0)) s.skipLine();

        var end = s.mark;
        var indent: usize = 0;
        if (increment > 0) {
            indent = if (s.indent >= 0) @as(usize, @intCast(s.indent)) + increment else increment;
        }
        var out: std.ArrayList(u8) = .empty;
        var leading_break: std.ArrayList(u8) = .empty;
        var trailing_breaks: std.ArrayList(u8) = .empty;
        try s.scanBlockScalarBreaks(&indent, &trailing_breaks, start, &end);

        var leading_blank = false;
        while (s.mark.column == indent and !s.isZ(0)) {
            const trailing_blank = s.isBlank(0);
            if (!literal and !leading_blank and !trailing_blank and leading_break.items.len > 0 and leading_break.items[0] == '\n') {
                if (trailing_breaks.items.len == 0) try out.append(s.arena, ' ');
            } else {
                try out.appendSlice(s.arena, leading_break.items);
            }
            leading_break.clearRetainingCapacity();
            try out.appendSlice(s.arena, trailing_breaks.items);
            trailing_breaks.clearRetainingCapacity();
            leading_blank = s.isBlank(0);
            while (!s.isBreakz(0)) try s.read(&out);
            try s.readLine(&leading_break);
            try s.scanBlockScalarBreaks(&indent, &trailing_breaks, start, &end);
        }
        if (chomping != -1) try out.appendSlice(s.arena, leading_break.items);
        if (chomping == 1) try out.appendSlice(s.arena, trailing_breaks.items);
        return .{
            .type = .scalar,
            .start = start,
            .end = end,
            .value = out.items,
            .style = if (literal) .literal else .folded,
        };
    }

    fn scanBlockScalarBreaks(s: *Scanner, indent: *usize, breaks: *std.ArrayList(u8), start: Mark, end: *Mark) Error!void {
        end.* = s.mark;
        var max_indent: usize = 0;
        while (true) {
            while ((indent.* == 0 or s.mark.column < indent.*) and s.at(0) == ' ') s.skip();
            if (s.mark.column > max_indent) max_indent = s.mark.column;
            if ((indent.* == 0 or s.mark.column < indent.*) and s.at(0) == '\t') {
                return s.fail(start, "found a tab character where an indentation space is expected");
            }
            if (!s.isBreak(0)) break;
            try s.readLine(breaks);
            end.* = s.mark;
        }
        if (indent.* == 0) {
            indent.* = max_indent;
            const floor: usize = @intCast(s.indent + 1);
            if (indent.* < floor) indent.* = floor;
            if (indent.* < 1) indent.* = 1;
        }
    }

    fn isDocumentIndicator(s: *const Scanner) bool {
        return s.mark.column == 0 and
            ((s.at(0) == '-' and s.at(1) == '-' and s.at(2) == '-') or
                (s.at(0) == '.' and s.at(1) == '.' and s.at(2) == '.')) and
            s.isBlankz(3);
    }

    fn scanFlowScalar(s: *Scanner, single: bool) Error!Token {
        const start = s.mark;
        s.skip();
        var out: std.ArrayList(u8) = .empty;
        var leading_break: std.ArrayList(u8) = .empty;
        var trailing_breaks: std.ArrayList(u8) = .empty;
        var whitespaces: std.ArrayList(u8) = .empty;
        while (true) {
            if (s.isDocumentIndicator()) return s.fail(start, "found unexpected document indicator");
            if (s.isZ(0)) return s.fail(start, "found unexpected end of stream");

            var leading_blanks = false;
            while (!s.isBlankz(0)) {
                const c = s.at(0);
                if (single and c == '\'' and s.at(1) == '\'') {
                    try out.append(s.arena, '\'');
                    s.skip();
                    s.skip();
                } else if (single and c == '\'') {
                    break;
                } else if (!single and c == '"') {
                    break;
                } else if (!single and c == '\\' and s.isBreak(1)) {
                    s.skip();
                    s.skipLine();
                    leading_blanks = true;
                    break;
                } else if (!single and c == '\\') {
                    try s.scanEscape(start, &out);
                } else {
                    try s.read(&out);
                }
            }
            if (s.at(0) == (if (single) @as(u8, '\'') else '"')) break;

            while (s.isBlank(0) or s.isBreak(0)) {
                if (s.isBlank(0)) {
                    if (!leading_blanks) try s.read(&whitespaces) else s.skip();
                } else if (!leading_blanks) {
                    whitespaces.clearRetainingCapacity();
                    try s.readLine(&leading_break);
                    leading_blanks = true;
                } else {
                    try s.readLine(&trailing_breaks);
                }
            }
            if (leading_blanks) {
                if (leading_break.items.len > 0 and leading_break.items[0] == '\n') {
                    if (trailing_breaks.items.len == 0) {
                        try out.append(s.arena, ' ');
                    } else {
                        try out.appendSlice(s.arena, trailing_breaks.items);
                    }
                } else {
                    try out.appendSlice(s.arena, leading_break.items);
                    try out.appendSlice(s.arena, trailing_breaks.items);
                }
                trailing_breaks.clearRetainingCapacity();
                leading_break.clearRetainingCapacity();
            } else {
                try out.appendSlice(s.arena, whitespaces.items);
                whitespaces.clearRetainingCapacity();
            }
        }
        s.skip();
        return .{
            .type = .scalar,
            .start = start,
            .end = s.mark,
            .value = out.items,
            .style = if (single) .single_quoted else .double_quoted,
        };
    }

    /// Reads one escape sequence of a double-quoted scalar. The escapes are
    /// yaml.v3's, which include \' and leave out YAML 1.2's \/.
    fn scanEscape(s: *Scanner, start: Mark, out: *std.ArrayList(u8)) Error!void {
        const simple: ?[]const u8 = switch (s.at(1)) {
            '0' => "\x00",
            'a' => "\x07",
            'b' => "\x08",
            't', '\t' => "\t",
            'n' => "\n",
            'v' => "\x0B",
            'f' => "\x0C",
            'r' => "\r",
            'e' => "\x1B",
            ' ' => " ",
            '"' => "\"",
            '\'' => "'",
            '\\' => "\\",
            'N' => "\u{85}",
            '_' => "\u{A0}",
            'L' => "\u{2028}",
            'P' => "\u{2029}",
            else => null,
        };
        const code_length: usize = switch (s.at(1)) {
            'x' => 2,
            'u' => 4,
            'U' => 8,
            else => 0,
        };
        if (simple == null and code_length == 0) return s.fail(start, "found unknown escape character");
        s.skip();
        s.skip();
        if (simple) |text| {
            try out.appendSlice(s.arena, text);
            return;
        }
        var value: u32 = 0;
        for (0..code_length) |k| {
            if (!s.isHex(k)) return s.fail(start, "did not find expected hexdecimal number");
            value = (value << 4) + s.asHex(k);
        }
        if ((value >= 0xD800 and value <= 0xDFFF) or value > 0x10FFFF) {
            return s.fail(start, "found invalid Unicode character escape code");
        }
        var buf: [4]u8 = undefined;
        const n = std.unicode.utf8Encode(@intCast(value), &buf) catch
            return s.fail(start, "found invalid Unicode character escape code");
        try out.appendSlice(s.arena, buf[0..n]);
        for (0..code_length) |_| s.skip();
    }

    fn scanPlainScalar(s: *Scanner) Error!Token {
        var out: std.ArrayList(u8) = .empty;
        var leading_break: std.ArrayList(u8) = .empty;
        var trailing_breaks: std.ArrayList(u8) = .empty;
        var whitespaces: std.ArrayList(u8) = .empty;
        var leading_blanks = false;
        const indent: isize = s.indent + 1;
        const start = s.mark;
        var end = s.mark;
        while (true) {
            if (s.isDocumentIndicator()) break;
            if (s.at(0) == '#') break;

            while (!s.isBlankz(0)) {
                const c = s.at(0);
                if ((c == ':' and s.isBlankz(1)) or
                    (s.flow_level > 0 and (c == ',' or c == '?' or c == '[' or c == ']' or c == '{' or c == '}')))
                {
                    break;
                }
                if (leading_blanks or whitespaces.items.len > 0) {
                    if (leading_blanks) {
                        if (leading_break.items[0] == '\n') {
                            if (trailing_breaks.items.len == 0) {
                                try out.append(s.arena, ' ');
                            } else {
                                try out.appendSlice(s.arena, trailing_breaks.items);
                            }
                        } else {
                            try out.appendSlice(s.arena, leading_break.items);
                            try out.appendSlice(s.arena, trailing_breaks.items);
                        }
                        trailing_breaks.clearRetainingCapacity();
                        leading_break.clearRetainingCapacity();
                        leading_blanks = false;
                    } else {
                        try out.appendSlice(s.arena, whitespaces.items);
                        whitespaces.clearRetainingCapacity();
                    }
                }
                try s.read(&out);
                end = s.mark;
            }
            if (!(s.isBlank(0) or s.isBreak(0))) break;

            while (s.isBlank(0) or s.isBreak(0)) {
                if (s.isBlank(0)) {
                    if (leading_blanks and s.columnI() < indent and s.at(0) == '\t') {
                        return s.fail(start, "found a tab character that violates indentation");
                    }
                    if (!leading_blanks) try s.read(&whitespaces) else s.skip();
                } else if (!leading_blanks) {
                    whitespaces.clearRetainingCapacity();
                    try s.readLine(&leading_break);
                    leading_blanks = true;
                } else {
                    try s.readLine(&trailing_breaks);
                }
            }
            if (s.flow_level == 0 and s.columnI() < indent) break;
        }
        if (leading_blanks) s.simple_key_allowed = true;
        return .{ .type = .scalar, .start = start, .end = end, .value = out.items, .style = .plain };
    }
};

// Tests. They render the token stream compactly: one letter or name per
// token, scalars with their value.

fn render(gpa: Allocator, src: []const u8) ![]u8 {
    var arena: std.heap.ArenaAllocator = .init(gpa);
    defer arena.deinit();
    var diag: Diagnostic = .{};
    var s: Scanner = .init(arena.allocator(), src, &diag);
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    const w = &out.writer;
    while (true) {
        const t = s.peek() catch |err| switch (err) {
            error.Syntax => {
                try w.print("ERR({s})", .{diag.message});
                break;
            },
            else => |e| return e,
        };
        switch (t.type) {
            .scalar => try w.print("S({s})", .{t.value}),
            .anchor => try w.print("&{s}", .{t.value}),
            .alias => try w.print("*{s}", .{t.value}),
            .tag => try w.print("!({s},{s})", .{ t.value, t.suffix }),
            .version_directive => try w.print("%YAML{d}.{d}", .{ t.major, t.minor }),
            .tag_directive => try w.print("%TAG({s},{s})", .{ t.value, t.suffix }),
            else => try w.print("{s}", .{@tagName(t.type)}),
        }
        if (t.type == .stream_end) break;
        try w.writeByte(' ');
        s.skipToken();
    }
    return out.toOwnedSlice();
}

fn expectTokens(src: []const u8, want: []const u8) !void {
    const got = try render(std.testing.allocator, src);
    defer std.testing.allocator.free(got);
    try std.testing.expectEqualStrings(want, got);
}

test "block mapping with a flow mapping value" {
    try expectTokens("a: {b: c, d: [e]}\n", "stream_start block_mapping_start key S(a) value flow_mapping_start key S(b) value S(c) flow_entry " ++
        "key S(d) value flow_sequence_start S(e) flow_sequence_end flow_mapping_end block_end stream_end");
}

test "indentless and nested block sequences" {
    try expectTokens("a:\n- x\n- y: 1\n", "stream_start block_mapping_start key S(a) value block_entry S(x) block_entry " ++
        "block_mapping_start key S(y) value S(1) block_end block_end stream_end");
}

test "plain scalars fold lines and stop at comments" {
    try expectTokens("a: one\n  two\n\n  three # note\n", "stream_start block_mapping_start key S(a) value S(one two\nthree) block_end stream_end");
    try expectTokens("a: b#c\n", "stream_start block_mapping_start key S(a) value S(b#c) block_end stream_end");
}

test "quoted scalars and escapes" {
    try expectTokens("- 'it''s'\n- \"a\\tb\\u00e9\\'\"\n", "stream_start block_sequence_start block_entry S(it's) block_entry S(a\tb\u{e9}') block_end stream_end");
    // The scanner reads two tokens ahead, so an error shows before the
    // tokens that precede it.
    try expectTokens("- \"a\\/b\"\n", "stream_start ERR(found unknown escape character)");
    try expectTokens("- \"\\ud800\"\n", "stream_start ERR(found invalid Unicode character escape code)");
    try expectTokens("- \"a\n  b\"\n", "stream_start block_sequence_start block_entry S(a b) block_end stream_end");
}

test "block scalars with chomping" {
    try expectTokens("a: |\n  x\n  y\n\nb: >-\n  p\n  q\n\n", "stream_start block_mapping_start key S(a) value S(x\ny\n) key S(b) value S(p q) block_end stream_end");
    try expectTokens("a: |+\n  x\n\n", "stream_start block_mapping_start key S(a) value S(x\n\n) block_end stream_end");
}

test "anchors, aliases and tags" {
    try expectTokens("a: &x !!str b\nc: *x\nd: !<tag:x> e\nf: ! g\n", "stream_start block_mapping_start key S(a) value &x !(!!,str) S(b) key S(c) value *x " ++
        "key S(d) value !(,tag:x) S(e) key S(f) value !(,!) S(g) block_end stream_end");
    try expectTokens("a: !foo%41 b\n", "stream_start block_mapping_start key S(a) value !(!,fooA) S(b) block_end stream_end");
}

test "directives and document markers" {
    try expectTokens("%YAML 1.1\n%TAG !e! tag:e,2000:\n--- a\n...\n", "stream_start %YAML1.1 %TAG(!e!,tag:e,2000:) document_start S(a) document_end stream_end");
    try expectTokens("%FOO\n", "ERR(found unknown directive name)");
}

test "tabs follow yaml.v3" {
    // A tab is fine after a key's ':' but not as indentation.
    try expectTokens("a:\tb\n", "stream_start block_mapping_start key S(a) value S(b) block_end stream_end");
    try expectTokens("a: b\n\tc: d\n", "stream_start block_mapping_start key ERR(found a tab character that violates indentation)");
    // A comment line after a comment may be indented with a tab.
    try expectTokens("a: 1\n# x\n\t# y\nb: 2\n", "stream_start block_mapping_start key S(a) value S(1) key S(b) value S(2) block_end stream_end");
    try expectTokens("- \tx\n", "stream_start ERR(found character that cannot start any token)");
}

test "a comment may follow a token with no blank" {
    try expectTokens("a: \"b\"#c\n", "stream_start block_mapping_start key S(a) value S(b) block_end stream_end");
}

test "a simple key whose token was parsed is appended, as yaml.v3 does" {
    try expectTokens("a: \u{2028}{}b: c\n", "stream_start block_mapping_start key S(a) value flow_mapping_start flow_mapping_end S(b) key value S(c) block_end stream_end");
}

test "simple keys" {
    try expectTokens("a\nb: c\n", "ERR(mapping values are not allowed in this context)");
    try expectTokens("a: 1\nb\nc: 2\n", "stream_start block_mapping_start key S(a) value ERR(could not find expected ':')");
    try expectTokens("[a\n: b]\n", "stream_start flow_sequence_start S(a) value S(b) flow_sequence_end stream_end");
}

test "a byte order mark inside the input is content" {
    try expectTokens("a: 1\n\u{FEFF}b: 2\n", "stream_start block_mapping_start key S(a) value S(1) key S(\u{FEFF}b) value S(2) block_end stream_end");
}
