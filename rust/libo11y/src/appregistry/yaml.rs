//! Decodes a registry file the way gopkg.in/yaml.v3 (`yaml.NewDecoder` with
//! `KnownFields(true)`) decodes it into Go's `appregistry.Registry`.
//!
//! yaml.v3 is a Go port of an older libyaml, so the reader, scanner and
//! parser come from libyaml-safer, a safe Rust port of a newer libyaml,
//! with the places the two part ways mended before the parse (see
//! [`prepare`]): escapes, tags that run on through `,`, `[` and `]`, plain
//! scalars in flow collections, yaml.v3's two-token scanner lookahead, and
//! the end-of-stream cases where libyaml-safer would panic. yaml.v3 reads
//! only YAML 1.1 documents. On top of the events, this module builds
//! yaml.v3's node tree (anchors register when their node starts, and an
//! unknown alias fails the parse) and then decodes it with yaml.v3's rules:
//!
//! - A scalar stored in a Go string reads as its source text, so `1.0`
//!   stays `1.0`. A null scalar leaves the field unset, `!!binary` decodes
//!   base64, and an explicit tag that does not fit its value fails the parse.
//! - Every mapping is checked for duplicate keys before it is decoded.
//! - Merge keys (`<<`) apply after the mapping's own keys, so those win, and
//!   the first merged mapping wins over later ones.
//! - Duplicate keys, unknown keys and values of the wrong type are collected
//!   and the decode goes on; anything else stops it. Collected problems rank
//!   duplicate key, then unknown key, then type, as the conformance cases
//!   name them.
//! - yaml.v3's alias budget stops a document that aliases its way into an
//!   exponential amount of work.

use std::collections::{HashMap, HashSet};

use libyaml_safer::{EventData, Parser, ScalarStyle, Scanner, TokenData};

use super::scalar::{self, MERGE, NULL, Resolved, STR};
use super::{Attribute, ParseError, ParseErrorKind, Registry};

/// yaml.v3's nesting bound (`max_flow_level` and `max_indents`).
const MAX_NESTING: usize = 10_000;

/// How deeply merge keys and aliases may nest while decoding. yaml.v3 has
/// no such bound below its nesting bound; this one keeps the recursive
/// decode within a thread's stack.
const MAX_DECODE_DEPTH: usize = 256;

/// The most rewrites [`prepare`] makes before it refuses the text. Each
/// rescans the text, and real registries need none.
const MAX_FIXES: usize = 256;

/// yaml.v3's `alias_ratio_range_low` and `alias_ratio_range_high`.
const ALIAS_RATIO_LOW: f64 = 400_000.0;
const ALIAS_RATIO_HIGH: f64 = 4_000_000.0;

type NodeId = usize;

fn syntax(detail: impl Into<String>) -> ParseError {
    ParseError::new(ParseErrorKind::Syntax, detail)
}

/// Decodes `bytes` as Go's `appregistry.Parse` does.
pub(super) fn parse(bytes: &[u8]) -> Result<Registry, ParseError> {
    let text = decode_input(bytes)?;
    check_characters(&text)?;
    let prepared = prepare(text).ok_or_else(|| {
        syntax(format!(
            "the text needs more than {MAX_FIXES} rewrites to read as yaml.v3 reads it"
        ))
    })?;
    let mut stream = Stream::new(&prepared);
    let Some(root) = stream.document()? else {
        return Err(ParseError::new(ParseErrorKind::Empty, "no YAML document"));
    };
    let mut registry = Registry::default();
    let mut decoder = Decoder::new(&stream.nodes);
    // yaml.v3 decodes the document node, then its content.
    decoder.count()?;
    Registry::decode(&mut decoder, root, &mut registry)?;
    if let Some(problem) = decoder.problem() {
        return Err(problem);
    }
    if stream.document()?.is_some() {
        return Err(ParseError::new(
            ParseErrorKind::SecondDocument,
            "a second document",
        ));
    }
    Ok(registry)
}

/// Decodes the bytes as UTF-8, or as UTF-16 after a UTF-16 byte order mark,
/// as yaml.v3's reader does. A UTF-8 byte order mark is skipped.
fn decode_input(bytes: &[u8]) -> Result<String, ParseError> {
    let utf16 = |rest: &[u8], unit: fn([u8; 2]) -> u16| {
        if !rest.len().is_multiple_of(2) {
            return Err(syntax("incomplete UTF-16 character"));
        }
        let units = rest.chunks_exact(2).map(|pair| unit([pair[0], pair[1]]));
        char::decode_utf16(units)
            .collect::<Result<String, _>>()
            .map_err(|_| syntax("invalid UTF-16 input"))
    };
    if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        return utf16(rest, u16::from_le_bytes);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        return utf16(rest, u16::from_be_bytes);
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8(bytes.to_vec()).map_err(|err| {
        syntax(format!(
            "invalid UTF-8 input at byte {}",
            err.utf8_error().valid_up_to()
        ))
    })
}

/// Fails on a character yaml.v3's reader refuses anywhere in the stream:
/// everything but tab, line feed, carriage return, printable ASCII, NEL,
/// and the BMP and astral ranges without U+FFFE and U+FFFF.
fn check_characters(text: &str) -> Result<(), ParseError> {
    let allowed = |c: char| {
        matches!(
            c,
            '\t' | '\n'
                | '\r'
                | '\u{20}'..='\u{7e}'
                | '\u{85}'
                | '\u{a0}'..='\u{d7ff}'
                | '\u{e000}'..='\u{fffd}'
                | '\u{10000}'..='\u{10ffff}'
        )
    };
    match text.chars().find(|&c| !allowed(c)) {
        Some(c) => Err(syntax(format!(
            "control characters are not allowed: U+{:04X}",
            u32::from(c)
        ))),
        None => Ok(()),
    }
}

/// The text libyaml-safer parses, rewritten so it reads as yaml.v3 does,
/// and what a scan of it found.
struct Prepared {
    text: String,
    /// The parse fails once it reaches this offset.
    fail_at: Option<u64>,
    /// The index of the first token yaml.v3's scanner fails on.
    scanner_failure: Option<usize>,
    /// The index of the first token other than a block end that starts at
    /// each offset.
    tokens: HashMap<u64, usize>,
    /// Whether a line break was added after a last line with content, which
    /// libyaml-safer needs to end a block scalar there.
    added_break: bool,
}

/// A rewrite that makes libyaml-safer read part of the text as yaml.v3
/// reads it: `len` bytes at `at` become `with`.
struct Fix {
    at: usize,
    len: usize,
    with: String,
}

/// Rewrites the text so libyaml-safer, a port of a newer libyaml, reads it
/// as yaml.v3's older scanner does, and finds the first place the two part
/// ways that a rewrite cannot mend.
///
/// - yaml.v3 reads `\'` in a double-quoted scalar as a quote and libyaml
///   refuses it: the backslash goes, which leaves a quote that means the
///   same inside double quotes.
/// - yaml.v3 lets a shorthand tag run on through `,`, `[` and `]`, and
///   libyaml ends the tag there: the character becomes its `%` escape, which
///   both decode back into the tag. libyaml-safer panics on a tag that a
///   comma ends inside a flow collection, so the scan runs over a copy with
///   a space before every comma that ends a run of tag characters, which
///   keeps every token boundary in place but turns the panic into a tag the
///   copy can report.
/// - Inside a flow collection, yaml.v3 reads a `:` that a flow indicator
///   follows as part of the plain scalar before it, and libyaml refuses it:
///   the scalar and its colon become one single-quoted scalar, which
///   resolves to the same string.
/// - libyaml reads `\/` and yaml.v3 refuses it; yaml.v3 ends a flow plain
///   scalar at `?` and libyaml reads on; yaml.v3 skips a byte order mark
///   only at the start of the stream and libyaml at the start of any line.
///   The parse fails at the first of these.
///
/// The scan restarts after each rewrite, and [`MAX_FIXES`] bounds the
/// rewrites; real registries need none.
fn prepare(mut text: String) -> Option<Prepared> {
    // libyaml-safer panics on a block scalar whose last line ends the
    // stream without a line break, where libyaml ends the scalar, so the
    // text gets one; the decoder takes it back out of the scalar.
    let added_break = !text.is_empty() && !text.ends_with(LINE_BREAKS);
    if added_break {
        text.push('\n');
    }
    let mut cut_at: Option<u64> = None;
    for _ in 0..=MAX_FIXES {
        let scan = Scan::of(&text);
        if let Some(cut) = scan.cut {
            text.truncate(cut);
            // The parse fails at the cut, so a line break after it, which a
            // block scalar there needs, changes nothing else.
            text.push('\n');
            // The parse fails once it reaches the cut.
            let at = u64::try_from(cut.saturating_sub(1)).unwrap_or(u64::MAX);
            cut_at = Some(cut_at.map_or(at, |c| c.min(at)));
            continue;
        }
        if let Some(fix) = scan.fix {
            text.replace_range(fix.at..fix.at + fix.len, &fix.with);
            continue;
        }
        let fail_at = match (scan.fail_at, cut_at) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        return Some(Prepared {
            text,
            fail_at,
            scanner_failure: scan.scanner_failure,
            tokens: scan.tokens,
            added_break,
        });
    }
    None
}

/// What one scan of the text found.
#[derive(Default)]
struct Scan {
    /// The first rewrite the text needs.
    fix: Option<Fix>,
    /// Where the text must end because the scanner failed past a tag
    /// it could not check.
    cut: Option<usize>,
    fail_at: Option<u64>,
    scanner_failure: Option<usize>,
    tokens: HashMap<u64, usize>,
}

impl Scan {
    fn fail(&mut self, at: usize, token: Option<usize>) {
        self.fail_at
            .get_or_insert(u64::try_from(at).unwrap_or(u64::MAX));
        if let Some(token) = token {
            self.scanner_failure.get_or_insert(token);
        }
    }

    /// Scans `text`, stopping at the first rewrite it needs.
    fn of(text: &str) -> Self {
        let commas = tag_commas(text);
        let mut copy = with_spaces_before(text, &commas);
        // libyaml-safer panics on a backslash that ends the stream inside a
        // double-quoted scalar; a space after it, which the copy only needs
        // for the scan, turns that into the scanner error it should be.
        if copy.ends_with('\\') {
            copy.push(' ');
        }
        // The copy's offset `at`, as an offset in the text.
        let original = |at: u64| -> usize {
            let at = usize::try_from(at).unwrap_or(usize::MAX);
            let before = commas
                .iter()
                .enumerate()
                .take_while(|(k, comma)| **comma + *k < at)
                .count();
            at - before
        };
        let inserted = |at: u64| {
            commas
                .iter()
                .enumerate()
                .any(|(k, comma)| u64::try_from(comma + k).is_ok_and(|space| space == at))
        };
        let escape_at = |at: usize| {
            let c = text.as_bytes()[at];
            Fix {
                at,
                len: 1,
                with: format!("%{c:02X}"),
            }
        };

        let mut scan = Self::default();
        let boms = line_start_boms(&copy);
        let mut next_bom = 0;
        let mut previous_end = 0;
        let mut flow = 0usize;
        let mut scanner = Scanner::<&[u8]>::new();
        scanner.set_input(copy.as_bytes());
        for (index, token) in scanner.enumerate() {
            let token = match token {
                Ok(token) => token,
                Err(err) => {
                    scan.fix = fix_for_error(text, &err, &original, &escape_at);
                    // The scanner reads ahead, so it can fail past a tag that
                    // a comma ends before handing the tag over. The text is cut
                    // there, as yaml.v3 would fail nearby too, and libyaml-safer
                    // would panic on the tag.
                    if scan.fix.is_none() {
                        let unverified = commas.iter().enumerate().find(|(k, comma)| {
                            u64::try_from(**comma + *k).is_ok_and(|space| space >= previous_end)
                        });
                        if let Some((_, &comma)) = unverified {
                            scan.cut = Some(comma);
                        }
                    }
                    if let Some(mark) = err.problem_mark() {
                        scan.fail(original(mark.index), Some(index));
                    }
                    break;
                }
            };
            let (start, end) = (token.start_mark.index, token.end_mark.index);
            while let Some(&bom) = boms.get(next_bom) {
                if bom >= start {
                    break;
                }
                if bom >= previous_end {
                    scan.fail(original(bom), None);
                }
                next_bom += 1;
            }
            previous_end = end;
            // A block end sits where the next token starts, and the parser has
            // taken it by the time it ends a document there.
            if !matches!(token.data, TokenData::BlockEnd) {
                scan.tokens
                    .entry(u64::try_from(original(start)).unwrap_or(u64::MAX))
                    .or_insert(index);
            }
            match token.data {
                TokenData::FlowSequenceStart | TokenData::FlowMappingStart => flow += 1,
                TokenData::FlowSequenceEnd | TokenData::FlowMappingEnd => {
                    flow = flow.saturating_sub(1);
                }
                TokenData::Tag { .. } if inserted(end) => {
                    scan.fix = Some(escape_at(original(end)));
                    break;
                }
                TokenData::Scalar {
                    style: ScalarStyle::DoubleQuoted,
                    ..
                } => {
                    if let Some(at) = slash_escape(&copy, start, end) {
                        scan.fail(original(at), Some(index));
                    }
                }
                TokenData::Scalar {
                    style: ScalarStyle::Plain,
                    ..
                } if flow > 0 => {
                    if let Some(at) = flow_plain_question(&copy, start, end) {
                        scan.fail(original(at), None);
                    }
                }
                _ => {}
            }
        }
        scan
    }
}

/// The rewrite that mends a scanner error, when there is one.
fn fix_for_error(
    text: &str,
    err: &libyaml_safer::Error,
    original: &dyn Fn(u64) -> usize,
    escape_at: &dyn Fn(usize) -> Fix,
) -> Option<Fix> {
    let at = original(err.problem_mark()?.index);
    if text.ends_with('\\') && err.context() == Some("while scanning a quoted scalar") {
        // The scan's copy had a space after the final backslash; the text
        // needs it too, or libyaml-safer panics. The scalar is unterminated,
        // so the parse fails there either way.
        return Some(Fix {
            at: text.len(),
            len: 0,
            with: " ".to_owned(),
        });
    }
    let next = text.as_bytes().get(at)?;
    match (err.problem(), err.context()) {
        ("found unknown escape character", _)
            if text.as_bytes().get(at..=at + 1) == Some(b"\\'") =>
        {
            Some(Fix {
                at,
                len: 1,
                with: String::new(),
            })
        }
        (
            "did not find expected whitespace or line break" | "did not find expected tag URI",
            Some("while scanning a tag" | "while parsing a tag"),
        ) if b",[]".contains(next) => Some(escape_at(at)),
        ("found unexpected ':'", Some("while scanning a plain scalar")) => {
            let from = original(err.context_mark()?.index);
            let scalar = text.get(from..at)?;
            // Only a one-line scalar without quotes, which single quotes
            // hold as they are; any other stays a syntax error.
            if scalar.contains(['\'', '"']) || scalar.contains(LINE_BREAKS) {
                return None;
            }
            let quoted = format!("'{scalar}:'");
            Some(Fix {
                at: from,
                len: at + 1 - from,
                with: quoted,
            })
        }
        _ => None,
    }
}

/// The offsets of every byte order mark at the start of a line after the
/// first.
fn line_start_boms(text: &str) -> Vec<u64> {
    text.match_indices('\u{feff}')
        .filter(|(at, _)| {
            at.checked_sub(1)
                .is_some_and(|before| matches!(text.as_bytes()[before], b'\n' | b'\r'))
        })
        .filter_map(|(at, _)| u64::try_from(at).ok())
        .collect()
}

/// Returns the offset of a `?` inside the flow plain scalar at `start..end`
/// of `text`: yaml.v3 ends a flow plain scalar there and libyaml reads on.
fn flow_plain_question(text: &str, start: u64, end: u64) -> Option<u64> {
    let (start, end) = (usize::try_from(start).ok()?, usize::try_from(end).ok()?);
    let q = text
        .as_bytes()
        .get(start..end)?
        .iter()
        .position(|&c| c == b'?')?;
    u64::try_from(start + q).ok()
}

/// The characters libyaml lets a shorthand tag hold.
fn is_tag_char(c: u8) -> bool {
    c.is_ascii_alphanumeric() || b"-_;/?:@&=+$.%!~*'()".contains(&c)
}

/// The offsets of every comma that ends a run of tag characters starting
/// at `!`, or ends a verbatim tag. A run inside a scalar or a comment counts
/// too; the scan tells the real tags apart. A `%TAG` directive whose prefix
/// starts with `!` and holds a comma fails the parse, which yaml.v3 reads.
fn tag_commas(text: &str) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'!' {
            i += 1;
            continue;
        }
        let rest = &bytes[i + 1..];
        let end = if rest.first() == Some(&b'<') {
            // A verbatim tag runs to its '>'.
            i + 1
                + rest
                    .iter()
                    .position(|&c| c == b'>')
                    .map_or(rest.len(), |at| at + 1)
        } else {
            i + 1 + rest.iter().take_while(|&&c| is_tag_char(c)).count()
        };
        if bytes.get(end) == Some(&b',') {
            out.push(end);
        }
        i = end.max(i + 1);
    }
    out
}

/// `text` with a space inserted before each offset in `at`, which is sorted.
fn with_spaces_before(text: &str, at: &[usize]) -> String {
    let mut out = String::with_capacity(text.len() + at.len());
    let mut from = 0;
    for &offset in at {
        out.push_str(&text[from..offset]);
        out.push(' ');
        from = offset;
    }
    out.push_str(&text[from..]);
    out
}
/// Returns the offset of the first `\/` escape in the double-quoted scalar
/// at `start..end` of `text`, which the scanner has accepted.
fn slash_escape(text: &str, start: u64, end: u64) -> Option<u64> {
    let start_at = usize::try_from(start).ok()?;
    let raw = text.as_bytes().get(start_at..usize::try_from(end).ok()?)?;
    let mut i = 1;
    while i + 1 < raw.len() {
        if raw[i] != b'\\' {
            i += 1;
            continue;
        }
        i += match raw[i + 1] {
            b'/' => return u64::try_from(start_at + i).ok(),
            b'x' => 4,
            b'u' => 6,
            b'U' => 10,
            _ => 2,
        };
    }
    None
}

/// A node of yaml.v3's tree. Tags are yaml.v3's: short, and resolved for an
/// untagged plain scalar.
#[derive(Debug)]
enum Node {
    Scalar {
        value: String,
        tag: String,
        line: u64,
    },
    Mapping {
        tag: String,
        content: Vec<NodeId>,
        line: u64,
    },
    Sequence {
        tag: String,
        content: Vec<NodeId>,
        line: u64,
    },
    Alias {
        name: String,
        target: NodeId,
    },
}

/// The events of one stream, built into yaml.v3's node tree a document at
/// a time. Anchors stay registered across documents, as in yaml.v3.
struct Stream<'a> {
    parser: Parser<&'a [u8]>,
    text: &'a str,
    nodes: Vec<Node>,
    anchors: HashMap<String, NodeId>,
    fail_at: Option<u64>,
    scanner_failure: Option<usize>,
    tokens: HashMap<u64, usize>,
    /// The text's length when [`Prepared::added_break`] added a line break.
    added_break_at: Option<u64>,
}

/// How many tokens yaml.v3's scanner reads past the one the parser asks
/// for, to place comments.
const SCANNER_LOOKAHEAD: usize = 2;

impl<'a> Stream<'a> {
    fn new(prepared: &'a Prepared) -> Self {
        let mut parser = Parser::new();
        parser.set_input(prepared.text.as_bytes());
        Self {
            parser,
            text: &prepared.text,
            nodes: Vec::new(),
            anchors: HashMap::new(),
            fail_at: prepared.fail_at,
            scanner_failure: prepared.scanner_failure,
            tokens: prepared.tokens.clone(),
            added_break_at: prepared
                .added_break
                .then(|| u64::try_from(prepared.text.len()).ok())
                .flatten(),
        }
    }

    fn event(&mut self) -> Result<libyaml_safer::Event, ParseError> {
        let event = self.parser.parse().map_err(|err| syntax(err.to_string()))?;
        if self.fail_at.is_some_and(|at| event.end_mark.index > at) {
            return Err(syntax(
                "found text gopkg.in/yaml.v3 reads differently, such as a `\\/` escape",
            ));
        }
        Ok(event)
    }

    /// Reads the next document's tree, or `None` at the end of the stream.
    fn document(&mut self) -> Result<Option<NodeId>, ParseError> {
        loop {
            match self.event()?.data {
                EventData::StreamStart { .. } => {}
                EventData::StreamEnd => return Ok(None),
                EventData::DocumentStart {
                    version_directive, ..
                } => {
                    if version_directive.is_some_and(|v| (v.major, v.minor) != (1, 1)) {
                        return Err(syntax("found incompatible YAML document"));
                    }
                    break;
                }
                _ => return Err(syntax("did not find expected <document start>")),
            }
        }
        let root = self.tree()?;
        let end = self.event()?;
        if !matches!(end.data, EventData::DocumentEnd { .. }) {
            return Err(syntax("did not find expected <document end>"));
        }
        // The document ends at the token after it. yaml.v3's scanner has read
        // further by then, so a scanner error just past the document fails
        // the document.
        let next = self.tokens.get(&end.start_mark.index).copied();
        if let (Some(next), Some(failure)) = (next, self.scanner_failure)
            && failure <= next + SCANNER_LOOKAHEAD
        {
            return Err(syntax(
                "found a scanner error within the lookahead of gopkg.in/yaml.v3",
            ));
        }
        Ok(Some(root))
    }

    /// Reads one node and everything under it.
    fn tree(&mut self) -> Result<NodeId, ParseError> {
        let mut open: Vec<NodeId> = Vec::new();
        loop {
            let event = self.event()?;
            let line = event.start_mark.line + 1;
            let done = match event.data {
                EventData::Scalar {
                    anchor,
                    tag,
                    mut value,
                    style,
                    ..
                } => {
                    if matches!(style, ScalarStyle::Literal | ScalarStyle::Folded)
                        && self.added_break_at == Some(event.end_mark.index)
                        && value.ends_with('\n')
                        && keeps_added_break(self.text, event.start_mark.index)
                    {
                        value.pop();
                    }
                    let tag = scalar_tag(tag.as_deref(), style, &value);
                    Some(self.add(Node::Scalar { value, tag, line }, anchor))
                }
                EventData::Alias { anchor } => {
                    let Some(&target) = self.anchors.get(&anchor) else {
                        return Err(syntax(format!("unknown anchor '{anchor}' referenced")));
                    };
                    Some(self.add(
                        Node::Alias {
                            name: anchor,
                            target,
                        },
                        None,
                    ))
                }
                EventData::SequenceStart { anchor, tag, .. } => {
                    let tag = container_tag(tag.as_deref(), "!!seq");
                    let id = self.add(
                        Node::Sequence {
                            tag,
                            content: Vec::new(),
                            line,
                        },
                        anchor,
                    );
                    open.push(id);
                    None
                }
                EventData::MappingStart { anchor, tag, .. } => {
                    let tag = container_tag(tag.as_deref(), "!!map");
                    let id = self.add(
                        Node::Mapping {
                            tag,
                            content: Vec::new(),
                            line,
                        },
                        anchor,
                    );
                    open.push(id);
                    None
                }
                EventData::SequenceEnd | EventData::MappingEnd => open.pop(),
                _ => return Err(syntax("did not find expected node content")),
            };
            if open.len() > MAX_NESTING {
                return Err(syntax(format!("exceeded max depth of {MAX_NESTING}")));
            }
            let Some(id) = done else { continue };
            let Some(&parent) = open.last() else {
                return Ok(id);
            };
            if let Node::Mapping { content, .. } | Node::Sequence { content, .. } =
                &mut self.nodes[parent]
            {
                content.push(id);
            }
        }
    }

    /// Adds a node, registering its anchor as the node starts, as yaml.v3
    /// does, so an alias inside the node refers to the node itself.
    fn add(&mut self, node: Node, anchor: Option<String>) -> NodeId {
        let id = self.nodes.len();
        self.nodes.push(node);
        if let Some(anchor) = anchor {
            self.anchors.insert(anchor, id);
        }
        id
    }
}

/// The line breaks libyaml reads.
const LINE_BREAKS: [char; 5] = ['\n', '\r', '\u{85}', '\u{2028}', '\u{2029}'];

/// Reports whether the block scalar that starts at `start` in `text` and
/// runs to its end took the line break [`prepare`] added into its value,
/// where libyaml, ending the scalar at the end of the stream, would not.
///
/// A last line with content gives its break to every chomping but strip.
/// A last line of spaces no deeper than the scalar's indentation is an
/// empty line, whose break only keep chomping takes. The indentation is
/// estimated from the scalar's last line with content.
fn keeps_added_break(text: &str, start: u64) -> bool {
    let Some(source) = usize::try_from(start).ok().and_then(|at| text.get(at..)) else {
        return false;
    };
    let Some(header) = source.find(['|', '>']) else {
        return false;
    };
    let chomping = source[header + 1..]
        .chars()
        .take(2)
        .find(|c| matches!(c, '+' | '-'));
    let body = source.strip_suffix('\n').unwrap_or(source);
    let mut lines = body[header..].split(LINE_BREAKS);
    // The header line holds no content.
    lines.next();
    let lines: Vec<&str> = lines.collect();
    let Some((last, before)) = lines.split_last() else {
        return false;
    };
    let indent = before
        .iter()
        .rev()
        .find(|line| !line.trim_start_matches(' ').is_empty())
        .map_or(0, |line| line.len() - line.trim_start_matches(' ').len());
    let last_has_content = !last.trim_start_matches(' ').is_empty() || last.len() > indent;
    match chomping {
        Some('-') => false,
        Some('+') => true,
        _ => last_has_content,
    }
}

/// The tag yaml.v3's parser gives a scalar.
fn scalar_tag(tag: Option<&str>, style: ScalarStyle, value: &str) -> String {
    match tag {
        Some(tag) if !tag.is_empty() && tag != "!" => scalar::short_tag(tag),
        _ if style != ScalarStyle::Plain => STR.to_owned(),
        _ if value == "<<" => MERGE.to_owned(),
        _ => scalar::implicit_tag(value).to_owned(),
    }
}

/// The tag yaml.v3's parser gives a mapping or a sequence.
fn container_tag(tag: Option<&str>, default: &str) -> String {
    match tag {
        Some(tag) if !tag.is_empty() && tag != "!" => scalar::short_tag(tag),
        _ => default.to_owned(),
    }
}

/// How a scalar decodes into a Go value that is not a string.
enum ScalarInto {
    /// The scalar is null: a struct stays as it is, a slice or map is set
    /// to nil.
    Null,
    /// The scalar is not null: a type error, already recorded.
    TypeError,
}

/// yaml.v3's decoder state for one document.
struct Decoder<'a> {
    nodes: &'a [Node],
    decodes: u64,
    alias_decodes: u64,
    alias_depth: usize,
    /// The alias nodes being expanded, to stop an alias inside its own
    /// anchor's value.
    expanding: HashSet<NodeId>,
    /// yaml.v3's `mergedFields`: the string keys a merge may no longer set.
    merged: Option<HashSet<String>>,
    depth: usize,
    duplicate: Option<String>,
    unknown: Option<String>,
    wrong_type: Option<String>,
}

impl<'a> Decoder<'a> {
    fn new(nodes: &'a [Node]) -> Self {
        Self {
            nodes,
            decodes: 0,
            alias_decodes: 0,
            alias_depth: 0,
            expanding: HashSet::new(),
            merged: None,
            depth: 0,
            duplicate: None,
            unknown: None,
            wrong_type: None,
        }
    }

    /// The bookkeeping at the top of yaml.v3's `decoder.unmarshal`, once per
    /// node decoded: past 1000 decodes and 100 alias-driven ones, the share
    /// of decodes driven by alias expansion may not exceed a ratio that falls
    /// from 0.99 to 0.10 as the document grows.
    #[expect(
        clippy::cast_precision_loss,
        reason = "yaml.v3 compares the counts as float64"
    )]
    fn count(&mut self) -> Result<(), ParseError> {
        self.decodes += 1;
        if self.alias_depth > 0 {
            self.alias_decodes += 1;
        }
        let decodes = self.decodes as f64;
        let allowed = if decodes <= ALIAS_RATIO_LOW {
            0.99
        } else if decodes >= ALIAS_RATIO_HIGH {
            0.10
        } else {
            0.99 - 0.89 * ((decodes - ALIAS_RATIO_LOW) / (ALIAS_RATIO_HIGH - ALIAS_RATIO_LOW))
        };
        if self.alias_decodes > 100
            && self.decodes > 1000
            && self.alias_decodes as f64 / decodes > allowed
        {
            return Err(syntax("document contains excessive aliasing"));
        }
        Ok(())
    }

    /// The collected problem with the highest rank, if any.
    fn problem(&mut self) -> Option<ParseError> {
        if let Some(detail) = self.duplicate.take() {
            return Some(ParseError::new(ParseErrorKind::DuplicateKey, detail));
        }
        if let Some(detail) = self.unknown.take() {
            return Some(ParseError::new(ParseErrorKind::UnknownKey, detail));
        }
        self.wrong_type
            .take()
            .map(|detail| ParseError::new(ParseErrorKind::Type, detail))
    }

    fn type_error(&mut self, id: NodeId, into: &str) {
        let (tag, line) = match &self.nodes[id] {
            Node::Scalar { tag, line, .. }
            | Node::Mapping { tag, line, .. }
            | Node::Sequence { tag, line, .. } => (tag.as_str(), *line),
            Node::Alias { .. } => ("", 0),
        };
        self.wrong_type
            .get_or_insert_with(|| format!("line {line}: cannot unmarshal {tag} into {into}"));
    }

    /// Runs `decode` one level deeper, failing past [`MAX_DECODE_DEPTH`].
    fn deeper<T>(
        &mut self,
        decode: impl FnOnce(&mut Self) -> Result<T, ParseError>,
    ) -> Result<T, ParseError> {
        self.depth += 1;
        if self.depth > MAX_DECODE_DEPTH {
            return Err(syntax(format!(
                "merge keys and aliases nest deeper than {MAX_DECODE_DEPTH}"
            )));
        }
        let result = decode(self);
        self.depth -= 1;
        result
    }

    /// yaml.v3's `decoder.alias`: decodes the alias's target, refusing an
    /// alias inside its own anchor's value.
    fn alias<T>(
        &mut self,
        id: NodeId,
        decode: impl FnOnce(&mut Self, NodeId) -> Result<T, ParseError>,
    ) -> Result<T, ParseError> {
        let Node::Alias { name, target } = &self.nodes[id] else {
            return Err(syntax("not an alias"));
        };
        let target = *target;
        if !self.expanding.insert(id) {
            return Err(syntax(format!("anchor '{name}' value contains itself")));
        }
        self.alias_depth += 1;
        let result = self.deeper(|d| decode(d, target));
        self.alias_depth -= 1;
        self.expanding.remove(&id);
        result
    }

    /// The node an alias chain ends at.
    fn resolved(&self, mut id: NodeId) -> &'a Node {
        while let Node::Alias { target, .. } = &self.nodes[id] {
            id = *target;
        }
        &self.nodes[id]
    }

    /// yaml.v3's `ShortTag() == nullTag`.
    fn is_null(&self, id: NodeId) -> bool {
        match self.resolved(id) {
            Node::Scalar { tag, .. } | Node::Mapping { tag, .. } | Node::Sequence { tag, .. } => {
                tag == NULL
            }
            Node::Alias { .. } => false,
        }
    }

    /// yaml.v3's duplicate key check, run on every mapping it decodes: two
    /// keys of one kind with one value.
    fn has_duplicates(&mut self, content: &[NodeId]) -> bool {
        let mut seen = HashMap::new();
        for &key in content.iter().step_by(2) {
            let (kind, value, line) = match &self.nodes[key] {
                Node::Scalar { value, line, .. } => (0, value.as_str(), *line),
                Node::Alias { name, .. } => (1, name.as_str(), 0),
                Node::Mapping { line, .. } => (2, "", *line),
                Node::Sequence { line, .. } => (3, "", *line),
            };
            if let Some(first) = seen.insert((kind, value), line) {
                self.duplicate.get_or_insert_with(|| {
                    format!(
                        "line {line}: mapping key {} already defined at line {first}",
                        libo11y_spec::go_quote(value)
                    )
                });
                return true;
            }
        }
        false
    }

    /// yaml.v3's `isMerge`.
    fn is_merge(&self, id: NodeId) -> bool {
        matches!(&self.nodes[id], Node::Scalar { value, tag, .. } if value == "<<" && tag == MERGE)
    }

    /// Resolves a scalar that is not decoded into a string.
    fn scalar_into(
        &mut self,
        id: NodeId,
        value: &str,
        tag: &str,
        into: &str,
    ) -> Result<ScalarInto, ParseError> {
        let resolved = scalar::resolve(tag, value).map_err(syntax)?;
        if resolved == Resolved::Null {
            return Ok(ScalarInto::Null);
        }
        self.type_error(id, into);
        Ok(ScalarInto::TypeError)
    }

    /// Decodes a node into a Go string: `None` leaves the string unset.
    fn string(&mut self, id: NodeId) -> Result<Option<String>, ParseError> {
        self.count()?;
        match &self.nodes[id] {
            Node::Alias { .. } => self.alias(id, Self::string),
            Node::Scalar { value, tag, .. } => {
                Ok(match scalar::resolve(tag, value).map_err(syntax)? {
                    Resolved::Null => None,
                    Resolved::Binary(decoded) => Some(decoded),
                    Resolved::Text | Resolved::Typed => Some(value.clone()),
                })
            }
            Node::Mapping { content, .. } => {
                if !self.has_duplicates(content) {
                    self.type_error(id, "string");
                }
                Ok(None)
            }
            Node::Sequence { .. } => {
                self.type_error(id, "string");
                Ok(None)
            }
        }
    }

    /// Decodes a merging mapping's key the way a Go `interface{}` holds it:
    /// `Some` for a string, `None` for anything else.
    fn interface_key(&mut self, id: NodeId) -> Result<Option<String>, ParseError> {
        self.count()?;
        match &self.nodes[id] {
            Node::Alias { .. } => self.alias(id, Self::interface_key),
            Node::Scalar { value, tag, .. } => {
                Ok(match scalar::resolve(tag, value).map_err(syntax)? {
                    Resolved::Text => Some(value.clone()),
                    Resolved::Binary(decoded) => Some(decoded),
                    Resolved::Null | Resolved::Typed => None,
                })
            }
            Node::Mapping { content, .. } if self.has_duplicates(content) => Ok(None),
            // yaml.v3 panics with an unhashable map key here, which ends the
            // Go process; a failed parse is the closest safe outcome.
            Node::Mapping { .. } | Node::Sequence { .. } => Err(syntax(
                "a mapping or sequence key next to a merge key is unhashable",
            )),
        }
    }

    /// Decodes a node into a Go `[]string`: `None` leaves the slice unset.
    fn strings(&mut self, id: NodeId) -> Result<Option<Vec<String>>, ParseError> {
        self.count()?;
        match &self.nodes[id] {
            Node::Alias { .. } => self.alias(id, Self::strings),
            Node::Scalar { value, tag, .. } => {
                Ok(match self.scalar_into(id, value, tag, "[]string")? {
                    ScalarInto::Null => Some(Vec::new()),
                    ScalarInto::TypeError => None,
                })
            }
            Node::Mapping { content, .. } => {
                if !self.has_duplicates(content) {
                    self.type_error(id, "[]string");
                }
                Ok(None)
            }
            Node::Sequence { content, .. } => {
                let mut out = Vec::with_capacity(content.len());
                for &item in content {
                    if let Some(s) = self.string(item)? {
                        out.push(s);
                    }
                }
                Ok(Some(out))
            }
        }
    }

    /// yaml.v3's `mappingStruct`: the mapping's own keys, then its merge.
    fn mapping_struct<T: Struct>(
        &mut self,
        id: NodeId,
        content: &[NodeId],
        out: &mut T,
    ) -> Result<(), ParseError> {
        let mut merged = self.merged.take();
        let mut done = vec![false; T::FIELDS.len()];
        let mut merge = None;
        for pair in content.chunks_exact(2) {
            let (key, value) = (pair[0], pair[1]);
            if self.is_merge(key) {
                merge = Some(value);
                continue;
            }
            let Some(name) = self.string(key)? else {
                continue;
            };
            if let Some(merged) = merged.as_mut()
                && !merged.insert(name.clone())
            {
                continue;
            }
            let line = self.line(key);
            match T::FIELDS.iter().position(|field| *field == name) {
                Some(field) if done[field] => {
                    self.wrong_type.get_or_insert_with(|| {
                        format!(
                            "line {line}: field {name} already set in type {}",
                            T::GO_TYPE
                        )
                    });
                }
                Some(field) => {
                    done[field] = true;
                    out.field(self, field, value)?;
                }
                None => {
                    self.unknown.get_or_insert_with(|| {
                        format!("line {line}: field {name} not found in type {}", T::GO_TYPE)
                    });
                }
            }
        }
        self.merged = merged;
        if let Some(merge) = merge {
            self.merge(id, merge, out)?;
        }
        Ok(())
    }

    fn line(&self, id: NodeId) -> u64 {
        match self.resolved(id) {
            Node::Scalar { line, .. }
            | Node::Mapping { line, .. }
            | Node::Sequence { line, .. } => *line,
            Node::Alias { .. } => 0,
        }
    }

    /// yaml.v3's `merge`: the first merge at a level records the merging
    /// mapping's keys, as a Go `interface{}` holds them, so that only those
    /// keys shadow merged ones. The merged value must be a mapping or a
    /// sequence of mappings.
    fn merge<T: Target>(
        &mut self,
        parent: NodeId,
        merge: NodeId,
        out: &mut T,
    ) -> Result<(), ParseError> {
        let want_map = || syntax("map merge requires map or sequence of maps as the value");
        let is_map = |node: &Node| matches!(node, Node::Mapping { .. });
        self.deeper(|d| {
            let outermost = d.merged.is_none();
            if outermost {
                let mut keys = HashSet::new();
                if let Node::Mapping { content, .. } = &d.nodes[parent] {
                    for &key in content.iter().step_by(2) {
                        if let Some(key) = d.interface_key(key)? {
                            keys.insert(key);
                        }
                    }
                }
                d.merged = Some(keys);
            }
            match &d.nodes[merge] {
                Node::Mapping { .. } => {
                    T::decode(d, merge, out)?;
                }
                Node::Alias { target, .. } => {
                    if !is_map(&d.nodes[*target]) {
                        return Err(want_map());
                    }
                    T::decode(d, merge, out)?;
                }
                Node::Sequence { content, .. } => {
                    for &item in content {
                        let item_is_map = match &d.nodes[item] {
                            Node::Alias { target, .. } => is_map(&d.nodes[*target]),
                            node => is_map(node),
                        };
                        if !item_is_map {
                            return Err(want_map());
                        }
                        T::decode(d, item, out)?;
                    }
                }
                Node::Scalar { .. } => return Err(want_map()),
            }
            if outermost {
                d.merged = None;
            }
            Ok(())
        })
    }
}

/// A Go value yaml.v3 decodes a node into: a struct or the attribute map.
trait Target {
    /// Decodes node `id` into `out`, returning yaml.v3's `good`.
    fn decode(d: &mut Decoder<'_>, id: NodeId, out: &mut Self) -> Result<bool, ParseError>;
}

/// A Go struct with yaml-tagged fields.
trait Struct: Target {
    /// The Go type name yaml.v3's messages use.
    const GO_TYPE: &'static str;
    /// The field names, in declaration order.
    const FIELDS: &'static [&'static str];

    /// Decodes `value` into field number `field`.
    fn field(&mut self, d: &mut Decoder<'_>, field: usize, value: NodeId)
    -> Result<(), ParseError>;
}

/// Decodes a node into a Go struct.
fn decode_struct<T: Struct>(
    d: &mut Decoder<'_>,
    id: NodeId,
    out: &mut T,
) -> Result<bool, ParseError> {
    d.count()?;
    match &d.nodes[id] {
        Node::Alias { .. } => d.alias(id, |d, target| decode_struct(d, target, out)),
        Node::Scalar { value, tag, .. } => {
            // A null scalar leaves the struct as it is; anything else is a
            // type error. Neither is good.
            d.scalar_into(id, value, tag, T::GO_TYPE)?;
            Ok(false)
        }
        Node::Sequence { .. } => {
            d.type_error(id, T::GO_TYPE);
            Ok(false)
        }
        Node::Mapping { content, .. } => {
            if d.has_duplicates(content) {
                return Ok(false);
            }
            d.mapping_struct(id, content, out)?;
            Ok(true)
        }
    }
}

impl Target for Registry {
    fn decode(d: &mut Decoder<'_>, id: NodeId, out: &mut Self) -> Result<bool, ParseError> {
        decode_struct(d, id, out)
    }
}

impl Struct for Registry {
    const GO_TYPE: &'static str = "appregistry.Registry";
    const FIELDS: &'static [&'static str] = &["schema", "namespace", "attributes"];

    fn field(
        &mut self,
        d: &mut Decoder<'_>,
        field: usize,
        value: NodeId,
    ) -> Result<(), ParseError> {
        match field {
            0 => {
                if let Some(s) = d.string(value)? {
                    self.schema = s;
                }
            }
            1 => {
                if let Some(s) = d.string(value)? {
                    self.namespace = s;
                }
            }
            _ => {
                let mut attributes = AttributeMap::default();
                AttributeMap::decode(d, value, &mut attributes)?;
                self.attributes = attributes.map.unwrap_or_default().into_iter().collect();
            }
        }
        Ok(())
    }
}

impl Target for Attribute {
    fn decode(d: &mut Decoder<'_>, id: NodeId, out: &mut Self) -> Result<bool, ParseError> {
        decode_struct(d, id, out)
    }
}

impl Struct for Attribute {
    const GO_TYPE: &'static str = "appregistry.Attribute";
    const FIELDS: &'static [&'static str] =
        &["type", "sensitivity", "cardinality", "values", "brief"];

    fn field(
        &mut self,
        d: &mut Decoder<'_>,
        field: usize,
        value: NodeId,
    ) -> Result<(), ParseError> {
        if field == 3 {
            if let Some(values) = d.strings(value)? {
                self.values = values;
            }
            return Ok(());
        }
        if let Some(s) = d.string(value)? {
            match field {
                0 => self.r#type = s,
                1 => self.sensitivity = s,
                2 => self.cardinality = s,
                _ => self.brief = s,
            }
        }
        Ok(())
    }
}

/// Go's `map[string]Attribute`, which may be nil.
#[derive(Default)]
struct AttributeMap {
    map: Option<HashMap<String, Attribute>>,
}

impl Target for AttributeMap {
    fn decode(d: &mut Decoder<'_>, id: NodeId, out: &mut Self) -> Result<bool, ParseError> {
        const GO_TYPE: &str = "map[string]appregistry.Attribute";
        d.count()?;
        match &d.nodes[id] {
            Node::Alias { .. } => d.alias(id, |d, target| Self::decode(d, target, out)),
            Node::Scalar { value, tag, .. } => {
                Ok(match d.scalar_into(id, value, tag, GO_TYPE)? {
                    ScalarInto::Null => {
                        out.map = None;
                        true
                    }
                    ScalarInto::TypeError => false,
                })
            }
            Node::Sequence { .. } => {
                d.type_error(id, GO_TYPE);
                Ok(false)
            }
            Node::Mapping { content, .. } => {
                if d.has_duplicates(content) {
                    return Ok(false);
                }
                let mut merged = d.merged.take();
                let is_new = out.map.is_none();
                let mut merge = None;
                for pair in content.chunks_exact(2) {
                    let (key, value) = (pair[0], pair[1]);
                    if d.is_merge(key) {
                        merge = Some(value);
                        continue;
                    }
                    let Some(name) = d.string(key)? else {
                        continue;
                    };
                    if let Some(merged) = merged.as_mut()
                        && !merged.insert(name.clone())
                    {
                        continue;
                    }
                    let mut attribute = Attribute::default();
                    let good = Attribute::decode(d, value, &mut attribute)?;
                    let map = out.map.get_or_insert_with(HashMap::new);
                    if good || (d.is_null(value) && (is_new || !map.contains_key(&name))) {
                        map.insert(name, attribute);
                    }
                }
                out.map.get_or_insert_with(HashMap::new);
                d.merged = merged;
                if let Some(merge) = merge {
                    d.merge(id, merge, out)?;
                }
                Ok(true)
            }
        }
    }
}
