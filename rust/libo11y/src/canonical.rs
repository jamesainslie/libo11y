//! The canonical rendering of an attribute value: the text a PII token
//! hashes, identical on every signal and in every libo11y implementation
//! (`conformance/vectors/pii-hash.json`).
//!
//! Scalars render as their text: booleans as `true` or `false`, integers in
//! base 10, floats as Go's `strconv.FormatFloat(f, 'g', -1, 64)`, strings as
//! themselves. Byte strings render as standard base64. Arrays and maps
//! render as JSON of their members' canonical forms, with map keys in UTF-8
//! byte order and strings escaped as Go's `encoding/json` escapes them. The
//! type is not encoded, so the string `"1"`, the integer 1 and the float
//! 1.0 share a rendering.
//!
//! The walk is bounded as Go bounds it. The root is depth 0, and a node
//! deeper than [`MAX_DEPTH`] renders as [`TRUNCATED`]. Every node spends one
//! unit of a [`WALK_BUDGET`]-node budget, depth first in sorted key order:
//! the value itself, each array element, each map member. Once the budget
//! is spent every remaining node renders as [`TRUNCATED`].

use std::borrow::Cow;

use opentelemetry::logs::AnyValue;
use opentelemetry::{Array, Value};

/// The deepest node the walk renders; the root is depth 0.
pub(crate) const MAX_DEPTH: usize = 16;

/// The nodes one walk may visit.
pub(crate) const WALK_BUDGET: usize = 2048;

/// What stands in for the part of a value the walk does not render.
pub(crate) const TRUNCATED: &str = "truncated";

/// Renders an attribute value canonically.
pub(crate) fn canonical_value(value: &Value) -> String {
    render(value_node(value, 0, &mut Walk::new()))
}

/// Renders a log attribute value canonically.
pub(crate) fn canonical_any(value: &AnyValue) -> String {
    render(any_node(value, 0, &mut Walk::new()))
}

/// A rendered node: a scalar's canonical text, an array of nodes, or an
/// object of nodes keyed in UTF-8 byte order. A composite is built as one
/// tree and JSON-encoded once, so nesting never re-escapes encoded text.
/// Strings borrow from the value being rendered.
enum Node<'a> {
    Text(Cow<'a, str>),
    Array(Vec<Node<'a>>),
    Object(Vec<(&'a str, Node<'a>)>),
}

impl Node<'_> {
    const TRUNCATED: Self = Self::Text(Cow::Borrowed(TRUNCATED));

    fn owned(text: String) -> Self {
        Self::Text(Cow::Owned(text))
    }
}

/// The node budget of one walk.
struct Walk {
    budget: usize,
}

impl Walk {
    fn new() -> Self {
        Self {
            budget: WALK_BUDGET,
        }
    }

    /// Takes one node from the budget and reports whether any remained.
    fn spend(&mut self) -> bool {
        match self.budget.checked_sub(1) {
            Some(left) => {
                self.budget = left;
                true
            }
            None => false,
        }
    }

    /// Reports whether a node at `depth` renders, spending one node when it
    /// does. Past the depth bound nothing is spent, as in Go.
    fn admit(&mut self, depth: usize) -> bool {
        depth <= MAX_DEPTH && self.spend()
    }
}

fn value_node<'a>(value: &'a Value, depth: usize, walk: &mut Walk) -> Node<'a> {
    if !walk.admit(depth) {
        return Node::TRUNCATED;
    }
    match value {
        Value::Bool(b) => Node::Text(Cow::Borrowed(bool_text(*b))),
        Value::I64(i) => Node::owned(i.to_string()),
        Value::F64(f) => Node::owned(go_float(*f)),
        Value::String(s) => Node::Text(Cow::Borrowed(s.as_str())),
        Value::Array(Array::Bool(items)) => {
            scalar_array(items, depth, walk, |b| Cow::Borrowed(bool_text(*b)))
        }
        Value::Array(Array::I64(items)) => {
            scalar_array(items, depth, walk, |i| Cow::Owned(i.to_string()))
        }
        Value::Array(Array::F64(items)) => {
            scalar_array(items, depth, walk, |f| Cow::Owned(go_float(*f)))
        }
        Value::Array(Array::String(items)) => {
            scalar_array(items, depth, walk, |s| Cow::Borrowed(s.as_str()))
        }
        // A kind a later opentelemetry release adds renders as its own text,
        // as Go renders an attribute kind it does not know.
        other => Node::owned(other.to_string()),
    }
}

/// Renders the elements of a scalar array held at `depth`, each one node.
fn scalar_array<'a, T>(
    items: &'a [T],
    depth: usize,
    walk: &mut Walk,
    text: impl Fn(&'a T) -> Cow<'a, str>,
) -> Node<'a> {
    Node::Array(
        items
            .iter()
            .map(|item| {
                if walk.admit(depth + 1) {
                    Node::Text(text(item))
                } else {
                    Node::TRUNCATED
                }
            })
            .collect(),
    )
}

fn any_node<'a>(value: &'a AnyValue, depth: usize, walk: &mut Walk) -> Node<'a> {
    if !walk.admit(depth) {
        return Node::TRUNCATED;
    }
    match value {
        AnyValue::Int(i) => Node::owned(i.to_string()),
        AnyValue::Double(f) => Node::owned(go_float(*f)),
        AnyValue::String(s) => Node::Text(Cow::Borrowed(s.as_str())),
        AnyValue::Boolean(b) => Node::Text(Cow::Borrowed(bool_text(*b))),
        AnyValue::Bytes(bytes) => Node::owned(base64(bytes)),
        AnyValue::ListAny(items) => Node::Array(
            items
                .iter()
                .map(|item| any_node(item, depth + 1, walk))
                .collect(),
        ),
        AnyValue::Map(map) => {
            let mut members: Vec<_> = map.iter().collect();
            members.sort_unstable_by(|(a, _), (b, _)| a.as_str().cmp(b.as_str()));
            Node::Object(
                members
                    .into_iter()
                    .map(|(key, member)| (key.as_str(), any_node(member, depth + 1, walk)))
                    .collect(),
            )
        }
        // A kind a later opentelemetry release adds renders as its debug
        // text, as Go renders a value kind it does not know.
        other => Node::owned(format!("{other:?}")),
    }
}

/// Go's `strconv.FormatBool`.
fn bool_text(b: bool) -> &'static str {
    if b { "true" } else { "false" }
}

/// Renders a node: a scalar as its text, a composite as JSON.
fn render(node: Node<'_>) -> String {
    match node {
        Node::Text(text) => text.into_owned(),
        composite => {
            let mut out = String::new();
            encode(&composite, &mut out);
            out
        }
    }
}

fn encode(node: &Node<'_>, out: &mut String) {
    match node {
        Node::Text(text) => quote(text, out),
        Node::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                encode(item, out);
            }
            out.push(']');
        }
        Node::Object(members) => {
            out.push('{');
            for (i, (key, member)) in members.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                quote(key, out);
                out.push(':');
                encode(member, out);
            }
            out.push('}');
        }
    }
}

/// Quotes `s` as Go's `encoding/json` does with HTML escaping on: `<`, `>`
/// and `&`, the line and paragraph separators, and control characters as
/// `\u` escapes, except the short forms for backspace, form feed, newline,
/// carriage return and tab.
fn quote(s: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if c < ' ' || matches!(c, '<' | '>' | '&') => {
                let b = u32::from(c);
                out.push_str("\\u00");
                out.push(char::from(HEX[(b >> 4) as usize]));
                out.push(char::from(HEX[(b & 0xf) as usize]));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Standard base64 with padding, as Go's `base64.StdEncoding`.
pub(crate) fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, &b)| acc | u32::from(b) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[(n >> (18 - 6 * i) & 0x3f) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Formats a float as Go's `strconv.FormatFloat(f, 'g', -1, 64)`: the
/// shortest digits that round-trip, in `%e` form when the decimal exponent
/// is below -4 or at least 6 (with at least two exponent digits), and in
/// `%f` form otherwise.
pub(crate) fn go_float(f: f64) -> String {
    if f.is_nan() {
        return "NaN".to_owned();
    }
    if f.is_infinite() {
        return if f > 0.0 { "+Inf" } else { "-Inf" }.to_owned();
    }
    let sign = if f.is_sign_negative() { "-" } else { "" };
    if f == 0.0 {
        return format!("{sign}0");
    }
    // Rust's LowerExp without a precision prints the shortest digits that
    // round-trip, as strconv's shortest mode does: "d.ddde[-]x".
    let shortest = format!("{:e}", f.abs());
    let (mantissa, exponent) = shortest.split_once('e').unwrap_or((&shortest, "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exp: i32 = exponent.parse().unwrap_or(0);
    if !(-4..6).contains(&exp) {
        let (first, rest) = digits.split_at(1);
        let frac = if rest.is_empty() {
            String::new()
        } else {
            format!(".{rest}")
        };
        let exp_sign = if exp < 0 { '-' } else { '+' };
        return format!("{sign}{first}{frac}e{exp_sign}{:02}", exp.unsigned_abs());
    }
    let point = usize::try_from(exp + 1).unwrap_or(0);
    if exp < 0 {
        let zeros = "0".repeat(exp.unsigned_abs() as usize - 1);
        return format!("{sign}0.{zeros}{digits}");
    }
    if digits.len() <= point {
        return format!("{sign}{digits}{}", "0".repeat(point - digits.len()));
    }
    let (int, frac) = digits.split_at(point);
    format!("{sign}{int}.{frac}")
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    use opentelemetry::{Key, StringValue};

    fn strings(items: &[&str]) -> Value {
        Value::Array(Array::String(
            items
                .iter()
                .map(|s| StringValue::from((*s).to_owned()))
                .collect(),
        ))
    }

    fn any_map(pairs: Vec<(&'static str, AnyValue)>) -> AnyValue {
        AnyValue::Map(Box::new(
            pairs
                .into_iter()
                .map(|(k, v)| (Key::from(k), v))
                .collect::<HashMap<_, _>>(),
        ))
    }

    #[test]
    fn floats_render_as_go_g_shortest() {
        for (f, want) in [
            (0.1, "0.1"),
            (-2.5e-7, "-2.5e-07"),
            (0.000_01, "1e-05"),
            (0.000_1, "0.0001"),
            (123_456.789, "123456.789"),
            (1_234_567.5, "1.2345675e+06"),
            (1_234_567.0, "1.234567e+06"),
            (100_000.0, "100000"),
            (1e6, "1e+06"),
            (1e21, "1e+21"),
            (1.797_693_134_862_315_7e308, "1.7976931348623157e+308"),
            (5e-324, "5e-324"),
            (1.0, "1"),
            (0.0, "0"),
            (-0.0, "-0"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "+Inf"),
            (f64::NEG_INFINITY, "-Inf"),
        ] {
            assert_eq!(go_float(f), want, "{f:e}");
        }
    }

    // go/policy_test.go TestCanonicalRenderingMatchesAcrossValueKinds, for the
    // value kinds an OpenTelemetry attribute and a log value can hold.
    #[test]
    fn renders_every_kind_alike_on_both_paths() {
        let cases: Vec<(Option<Value>, AnyValue, &str)> = vec![
            (
                Some(Value::from("10.0.0.1")),
                AnyValue::from("10.0.0.1"),
                "10.0.0.1",
            ),
            (Some(Value::I64(-7)), AnyValue::Int(-7), "-7"),
            (Some(Value::F64(1e21)), AnyValue::Double(1e21), "1e+21"),
            (Some(Value::Bool(true)), AnyValue::Boolean(true), "true"),
            (None, AnyValue::Bytes(Box::new(b"ab".to_vec())), "YWI="),
            (
                Some(strings(&["a", "b\""])),
                AnyValue::ListAny(Box::new(vec!["a".into(), "b\"".into()])),
                r#"["a","b\""]"#,
            ),
            (
                Some(Value::Array(Array::I64(vec![1, 2]))),
                AnyValue::ListAny(Box::new(vec![AnyValue::Int(1), AnyValue::Int(2)])),
                r#"["1","2"]"#,
            ),
            (
                Some(Value::Array(Array::F64(vec![0.5]))),
                AnyValue::ListAny(Box::new(vec![AnyValue::Double(0.5)])),
                r#"["0.5"]"#,
            ),
            (
                Some(Value::Array(Array::Bool(vec![false]))),
                AnyValue::ListAny(Box::new(vec![AnyValue::Boolean(false)])),
                r#"["false"]"#,
            ),
            (Some(strings(&[])), AnyValue::ListAny(Box::default()), "[]"),
            (
                None,
                any_map(vec![("b", AnyValue::Int(2)), ("a", "x".into())]),
                r#"{"a":"x","b":"2"}"#,
            ),
            (None, any_map(vec![]), "{}"),
            (
                None,
                any_map(vec![("n", any_map(vec![("ip", "1".into())]))]),
                r#"{"n":{"ip":"1"}}"#,
            ),
            (
                None,
                AnyValue::ListAny(Box::new(vec![any_map(vec![("ip", "1".into())])])),
                r#"[{"ip":"1"}]"#,
            ),
            (
                None,
                AnyValue::ListAny(Box::new(vec![
                    AnyValue::ListAny(Box::new(vec!["a".into()])),
                    AnyValue::ListAny(Box::new(vec!["b".into(), "c".into()])),
                ])),
                r#"[["a"],["b","c"]]"#,
            ),
        ];
        for (value, any, want) in cases {
            if let Some(value) = value {
                assert_eq!(canonical_value(&value), want, "{value:?}");
            }
            assert_eq!(canonical_any(&any), want, "{any:?}");
        }
    }

    // go/policy_test.go TestCanonicalRenderingIgnoresType.
    #[test]
    fn rendering_ignores_the_type() {
        for got in [
            canonical_value(&Value::from("1")),
            canonical_value(&Value::I64(1)),
            canonical_value(&Value::F64(1.0)),
            canonical_any(&AnyValue::Int(1)),
        ] {
            assert_eq!(got, "1");
        }
        assert_eq!(
            canonical_value(&Value::from(r#"["1","2"]"#)),
            canonical_value(&Value::Array(Array::I64(vec![1, 2])))
        );
    }

    #[test]
    fn json_escapes_as_go() {
        assert_eq!(
            canonical_value(&strings(&[
                "<a&b>",
                "\u{2028}\u{2029}",
                "\u{8}\u{c}\u{1}\t\n\r\"\\\u{7f}"
            ])),
            concat!(
                r#"["\u003ca\u0026b\u003e","\u2028\u2029","\b\f\u0001\t\n\r\"\\"#,
                "\u{7f}",
                r#""]"#
            )
        );
        // A scalar renders raw, without JSON escaping.
        assert_eq!(canonical_value(&Value::from("<&>")), "<&>");
    }

    #[test]
    fn map_keys_sort_in_utf8_byte_order() {
        let map = any_map(vec![
            ("2", "b".into()),
            ("10", "a".into()),
            ("\u{1f600}", "e".into()),
            ("\u{ff61}", "d".into()),
            ("a", "c".into()),
        ]);
        assert_eq!(
            canonical_any(&map),
            "{\"10\":\"a\",\"2\":\"b\",\"a\":\"c\",\"\u{ff61}\":\"d\",\"\u{1f600}\":\"e\"}"
        );
    }

    #[test]
    fn the_walk_is_bounded_by_depth() {
        let mut value = AnyValue::from("leaf");
        for _ in 0..20 {
            value = AnyValue::ListAny(Box::new(vec![value]));
        }
        let rendered = canonical_any(&value);
        assert_eq!(rendered.matches('[').count(), MAX_DEPTH + 1);
        assert!(rendered.contains(&format!("\"{TRUNCATED}\"")));
    }

    #[test]
    fn the_walk_is_bounded_by_its_budget() {
        let at_budget: Vec<&str> = vec!["a"; WALK_BUDGET - 1];
        assert!(!canonical_value(&strings(&at_budget)).contains(TRUNCATED));
        let past_budget: Vec<&str> = vec!["a"; WALK_BUDGET];
        let rendered = canonical_value(&strings(&past_budget));
        assert!(rendered.ends_with(&format!(",\"{TRUNCATED}\"]")));
        assert_eq!(rendered.matches(TRUNCATED).count(), 1);
    }

    // go/policy_test.go TestCanonicalAnyBoundsSharedReferences: a value that
    // expands exponentially renders in bounded time and size.
    #[test]
    fn shared_subtrees_stay_bounded() {
        let mut value = any_map(vec![("ip", "1".into())]);
        for _ in 0..12 {
            value = any_map(vec![
                ("a", value.clone()),
                ("b", value.clone()),
                ("c", value),
            ]);
        }
        let rendered = canonical_any(&value);
        assert!(rendered.contains(TRUNCATED));
        assert!(rendered.len() < 256 << 10);
        assert_eq!(canonical_any(&value), rendered);
    }
}
