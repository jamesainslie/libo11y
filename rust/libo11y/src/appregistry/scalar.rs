//! How gopkg.in/yaml.v3 resolves a scalar before storing it in a Go
//! string: its `resolve` function, its `!!binary` decoding and its
//! timestamp check. The registry decoder only needs to know whether a
//! scalar is null, whether it is text, and whether an explicit tag fits
//! the value, because yaml.v3 fails the whole parse when it does not.

/// yaml.v3's long tag prefix, which a `!!` handle expands to.
const LONG_TAG_PREFIX: &str = "tag:yaml.org,2002:";

pub(super) const STR: &str = "!!str";
pub(super) const NULL: &str = "!!null";
pub(super) const MERGE: &str = "!!merge";
const BOOL: &str = "!!bool";
const INT: &str = "!!int";
const FLOAT: &str = "!!float";
const TIMESTAMP: &str = "!!timestamp";
const BINARY: &str = "!!binary";

/// yaml.v3's `shortTag`: `tag:yaml.org,2002:int` becomes `!!int`.
pub(super) fn short_tag(tag: &str) -> String {
    match tag.strip_prefix(LONG_TAG_PREFIX) {
        Some(suffix) => format!("!!{suffix}"),
        None => tag.to_owned(),
    }
}

/// What a scalar resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Resolved {
    /// The scalar is null. It leaves a Go string, struct or slice unset.
    Null,
    /// The scalar is text: a Go interface holds it as a string.
    Text,
    /// The scalar is a typed value (a bool, number or timestamp): a Go
    /// string still takes its source text, a Go interface holds no string.
    Typed,
    /// An explicit `!!binary` scalar, decoded.
    Binary(String),
}

/// Why yaml.v3 fails to resolve a scalar.
pub(super) type Failure = String;

/// The tag yaml.v3's parser gives a plain scalar without an explicit tag.
pub(super) fn implicit_tag(value: &str) -> &'static str {
    classify("", value).0
}

/// Resolves a scalar the way yaml.v3's decoder does: `tag` is the node's tag
/// as yaml.v3's parser sets it (already short, never empty) and `value` its
/// text. Fails, as yaml.v3 does, when an explicit tag does not fit the value
/// or a `!!binary` value is not base64.
pub(super) fn resolve(tag: &str, value: &str) -> Result<Resolved, Failure> {
    if tag == STR {
        return Ok(Resolved::Text);
    }
    if tag == BINARY {
        return decode_base64(value)
            .map(|bytes| Resolved::Binary(String::from_utf8_lossy(&bytes).into_owned()))
            .ok_or_else(|| "!!binary value contains invalid base64 data".to_owned());
    }
    if !matches!(tag, "" | BOOL | INT | FLOAT | NULL | TIMESTAMP) {
        // yaml.v3 hands any other tag's value through as text.
        return Ok(Resolved::Text);
    }
    let (rtag, unsigned) = classify(tag, value);
    let fits = tag.is_empty() || tag == rtag || (tag == FLOAT && rtag == INT && !unsigned);
    if !fits {
        return Err(format!("cannot decode {rtag} `{value}` as a {tag}"));
    }
    Ok(match rtag {
        NULL => Resolved::Null,
        STR => Resolved::Text,
        _ => Resolved::Typed,
    })
}

/// The body of yaml.v3's `resolve` for a resolvable tag: the tag the value
/// resolves to, and whether it is an integer that only fits a uint64.
fn classify(tag: &str, s: &str) -> (&'static str, bool) {
    let Some(hint) = hint(s) else {
        return (STR, false);
    };
    if tag == STR {
        return (STR, false);
    }
    match s {
        "true" | "True" | "TRUE" | "false" | "False" | "FALSE" => return (BOOL, false),
        "" | "~" | "null" | "Null" | "NULL" => return (NULL, false),
        ".nan" | ".NaN" | ".NAN" | ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF"
        | "-.inf" | "-.Inf" | "-.INF" => return (FLOAT, false),
        _ => {}
    }
    match hint {
        Hint::Dot => {
            if dot_float(s) && finite(s) {
                return (FLOAT, false);
            }
        }
        Hint::Digit | Hint::Sign => {
            if (tag.is_empty() || tag == TIMESTAMP) && is_timestamp(s) {
                return (TIMESTAMP, false);
            }
            let plain: String = s.chars().filter(|&c| c != '_').collect();
            if parse_int(&plain, 0).is_some() {
                return (INT, false);
            }
            if parse_uint(&plain, 0).is_some() {
                return (INT, true);
            }
            if yaml_style_float(&plain) && finite(&plain) {
                return (FLOAT, false);
            }
            if let Some(digits) = plain.strip_prefix("0b") {
                if parse_int(digits, 2).is_some() {
                    return (INT, false);
                }
                if parse_uint(digits, 2).is_some() {
                    return (INT, true);
                }
            } else if let Some(digits) = plain.strip_prefix("-0b")
                && parse_int(&format!("-{digits}"), 2).is_some()
            {
                return (INT, false);
            }
            if let Some(digits) = plain.strip_prefix("0o") {
                if parse_int(digits, 8).is_some() {
                    return (INT, false);
                }
                if parse_uint(digits, 8).is_some() {
                    return (INT, true);
                }
            } else if let Some(digits) = plain.strip_prefix("-0o")
                && parse_int(&format!("-{digits}"), 8).is_some()
            {
                return (INT, false);
            }
        }
        Hint::Map => {}
    }
    (STR, false)
}

/// What yaml.v3's `resolveTable` says the first byte makes a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Hint {
    Sign,
    Digit,
    Map,
    Dot,
}

/// Returns the hint for `s`, or `None` when its first byte rules out every
/// type but a string. The empty string may be null.
fn hint(s: &str) -> Option<Hint> {
    match s.as_bytes().first() {
        None => Some(Hint::Map),
        Some(b'+' | b'-') => Some(Hint::Sign),
        Some(b'0'..=b'9') => Some(Hint::Digit),
        Some(b'y' | b'Y' | b'n' | b'N' | b't' | b'T' | b'f' | b'F' | b'o' | b'O' | b'~') => {
            Some(Hint::Map)
        }
        Some(b'.') => Some(Hint::Dot),
        Some(_) => None,
    }
}

/// Reports whether Go's `strconv.ParseFloat` accepts `s` without a range
/// error. The caller has already checked the syntax.
fn finite(s: &str) -> bool {
    s.parse::<f64>().is_ok_and(f64::is_finite)
}

fn digits(s: &[u8]) -> usize {
    s.iter().take_while(|c| c.is_ascii_digit()).count()
}

/// Matches an optional exponent, `[eE][-+]?[0-9]+`, and reports whether it
/// takes the rest of `s`.
fn exponent_ends(s: &[u8]) -> bool {
    match s.split_first() {
        None => true,
        Some((b'e' | b'E', rest)) => {
            let rest = match rest.first() {
                Some(b'-' | b'+') => &rest[1..],
                _ => rest,
            };
            let n = digits(rest);
            n > 0 && n == rest.len()
        }
        Some(_) => false,
    }
}

/// `^\.[0-9]+([eE][-+]?[0-9]+)?$`, the floats a `.` may start.
fn dot_float(s: &str) -> bool {
    let Some(rest) = s.as_bytes().strip_prefix(b".") else {
        return false;
    };
    let n = digits(rest);
    n > 0 && exponent_ends(&rest[n..])
}

/// yaml.v3's `yamlStyleFloat`:
/// `^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$`.
fn yaml_style_float(s: &str) -> bool {
    let mut rest = s.as_bytes();
    if let Some(b'-' | b'+') = rest.first() {
        rest = &rest[1..];
    }
    if rest.first() == Some(&b'.') {
        let n = digits(&rest[1..]);
        return n > 0 && exponent_ends(&rest[1 + n..]);
    }
    let n = digits(rest);
    if n == 0 {
        return false;
    }
    rest = &rest[n..];
    if rest.first() == Some(&b'.') {
        rest = &rest[1 + digits(&rest[1..])..];
    }
    exponent_ends(rest)
}

/// Go's `strconv.ParseUint(s, base, 64)`, where base 0 reads a `0b`, `0o`,
/// `0x` or leading-`0` prefix. The caller has removed underscores.
fn parse_uint(s: &str, base: u32) -> Option<u64> {
    if s.is_empty() {
        return None;
    }
    let (radix, digits) = if base == 0 && s.starts_with('0') {
        let lower = s.as_bytes().get(1).map(u8::to_ascii_lowercase);
        match lower {
            Some(b'b') if s.len() >= 3 => (2, &s[2..]),
            Some(b'o') if s.len() >= 3 => (8, &s[2..]),
            Some(b'x') if s.len() >= 3 => (16, &s[2..]),
            _ => (8, &s[1..]),
        }
    } else if base == 0 {
        (10, s)
    } else {
        (base, s)
    };
    // Go accepts the bare "0", whose digits after the octal prefix are empty.
    if digits.is_empty() {
        return (s == "0").then_some(0);
    }
    if digits.starts_with('+') || digits.starts_with('-') {
        return None;
    }
    u64::from_str_radix(digits, radix).ok()
}

/// Go's `strconv.ParseInt(s, base, 64)`.
fn parse_int(s: &str, base: u32) -> Option<i64> {
    let (negative, body) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let magnitude = i128::from(parse_uint(body, base)?);
    let value = if negative { -magnitude } else { magnitude };
    i64::try_from(value).ok()
}

/// yaml.v3's `parseTimestamp`: a value that starts with four digits and a
/// dash and parses as one of its four Go layouts.
fn is_timestamp(s: &str) -> bool {
    let b = s.as_bytes();
    if digits(b) != 4 || b.get(4) != Some(&b'-') {
        return false;
    }
    [
        Layout::DateTime(b'T'),
        Layout::DateTime(b't'),
        Layout::SpaceSeparated,
        Layout::Date,
    ]
    .into_iter()
    .any(|layout| layout.parses(b))
}

/// yaml.v3's timestamp layouts.
#[derive(Debug, Clone, Copy)]
enum Layout {
    /// `2006-1-2T15:4:5.999999999Z07:00`, with the given separator.
    DateTime(u8),
    /// `2006-1-2 15:4:5.999999999`.
    SpaceSeparated,
    /// `2006-1-2`.
    Date,
}

/// A cursor over a value that reads it as Go's `time.Parse` reads a layout.
struct Cursor<'a> {
    s: &'a [u8],
}

impl Cursor<'_> {
    /// Go's `getnum(s, false)`: one digit, or two when a second follows.
    fn number(&mut self) -> Option<u32> {
        let first = *self.s.first().filter(|c| c.is_ascii_digit())?;
        let mut n = u32::from(first - b'0');
        self.s = &self.s[1..];
        if let Some(&c) = self.s.first().filter(|c| c.is_ascii_digit()) {
            n = n * 10 + u32::from(c - b'0');
            self.s = &self.s[1..];
        }
        Some(n)
    }

    /// Exactly two digits, as Go reads a zone offset.
    fn two_digits(&mut self) -> Option<u32> {
        let [a, b] = [*self.s.first()?, *self.s.get(1)?];
        if !a.is_ascii_digit() || !b.is_ascii_digit() {
            return None;
        }
        self.s = &self.s[2..];
        Some(u32::from(a - b'0') * 10 + u32::from(b - b'0'))
    }

    fn literal(&mut self, c: u8) -> Option<()> {
        let (&first, rest) = self.s.split_first()?;
        (first == c).then(|| self.s = rest)
    }

    /// Go's optional `.999999999`: a period or comma and at least one digit.
    fn fraction(&mut self) {
        if let [b'.' | b',', d, ..] = self.s
            && d.is_ascii_digit()
        {
            self.s = &self.s[1 + digits(&self.s[1..])..];
        }
    }

    /// Go's `Z07:00`: `Z`, or a sign, two digits, a colon and two digits.
    fn zone(&mut self) -> Option<()> {
        if self.literal(b'Z').is_some() {
            return Some(());
        }
        match self.s.first()? {
            b'+' | b'-' => self.s = &self.s[1..],
            _ => return None,
        }
        let hours = self.two_digits()?;
        self.literal(b':')?;
        let minutes = self.two_digits()?;
        (hours <= 24 && minutes <= 60).then_some(())
    }
}

impl Layout {
    fn parses(self, s: &[u8]) -> bool {
        self.read(s).is_some()
    }

    fn read(self, s: &[u8]) -> Option<()> {
        let year: u32 = std::str::from_utf8(s.get(..4)?).ok()?.parse().ok()?;
        let mut c = Cursor { s: &s[4..] };
        c.literal(b'-')?;
        let month = c.number()?;
        c.literal(b'-')?;
        let day = c.number()?;
        if !(1..=12).contains(&month) || day < 1 || day > days_in(month, year) {
            return None;
        }
        let separator = match self {
            Self::Date => return c.s.is_empty().then_some(()),
            Self::DateTime(separator) => separator,
            Self::SpaceSeparated => b' ',
        };
        c.literal(separator)?;
        let hour = c.number()?;
        c.literal(b':')?;
        let minute = c.number()?;
        c.literal(b':')?;
        let second = c.number()?;
        if hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        c.fraction();
        if matches!(self, Self::DateTime(_)) {
            c.zone()?;
        }
        c.s.is_empty().then_some(())
    }
}

fn days_in(month: u32, year: u32) -> u32 {
    match month {
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Go's `base64.StdEncoding.DecodeString`, which skips line breaks and
/// needs the padding but ignores bits past the last byte.
fn decode_base64(s: &str) -> Option<Vec<u8>> {
    let compact: Vec<u8> = s.bytes().filter(|&c| c != b'\r' && c != b'\n').collect();
    if !compact.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(compact.len() / 4 * 3);
    let chunks = compact.chunks(4);
    let last = chunks.len().saturating_sub(1);
    for (i, chunk) in chunks.enumerate() {
        let pad = chunk.iter().rev().take_while(|&&c| c == b'=').count();
        if pad > 2 || (pad > 0 && i != last) {
            return None;
        }
        let mut n = 0u32;
        for &c in &chunk[..4 - pad] {
            n = n << 6 | sextet(c)?;
        }
        n <<= 6 * u32::try_from(pad).ok()?;
        let bytes = n.to_be_bytes();
        out.extend_from_slice(&bytes[1..4 - pad]);
    }
    Some(out)
}

fn sextet(c: u8) -> Option<u32> {
    let v = match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    };
    Some(u32::from(v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_tags() {
        assert_eq!(short_tag("tag:yaml.org,2002:int"), "!!int");
        assert_eq!(short_tag("!foo"), "!foo");
    }

    #[test]
    fn plain_scalars_resolve_as_yaml_v3_resolves_them() {
        for (value, tag) in [
            ("", NULL),
            ("~", NULL),
            ("Null", NULL),
            ("true", BOOL),
            ("yes", STR),
            ("1", INT),
            ("-0x1F", INT),
            ("0o17", INT),
            ("1_000", INT),
            ("08", FLOAT),
            ("1.0", FLOAT),
            ("1e3", FLOAT),
            (".5", FLOAT),
            (".inf", FLOAT),
            ("1e400", STR),
            ("2001-12-14", TIMESTAMP),
            ("2001-13-01", STR),
            ("<<", STR),
            ("studio", STR),
            ("-", STR),
        ] {
            assert_eq!(implicit_tag(value), tag, "{value:?}");
        }
        assert_eq!(classify("", "18446744073709551615"), (INT, true));
    }

    #[test]
    fn explicit_tags_must_fit() {
        assert_eq!(resolve(STR, "~"), Ok(Resolved::Text));
        assert_eq!(resolve(NULL, ""), Ok(Resolved::Null));
        assert_eq!(resolve(INT, "0x1F"), Ok(Resolved::Typed));
        assert_eq!(resolve(FLOAT, "12"), Ok(Resolved::Typed));
        assert!(resolve(FLOAT, "18446744073709551615").is_err());
        assert!(resolve(INT, "client").is_err());
        assert!(resolve(FLOAT, "client").is_err());
        assert!(resolve(NULL, "client").is_err());
        assert!(resolve(BOOL, "yes").is_err());
        assert!(resolve(INT, "99999999999999999999999").is_err());
        assert!(resolve(FLOAT, "1e400").is_err());
        assert_eq!(resolve("!foo", "bar"), Ok(Resolved::Text));
        assert_eq!(resolve(MERGE, "<<"), Ok(Resolved::Text));
    }

    #[test]
    fn timestamps_follow_go_layouts() {
        for ok in [
            "2001-12-14",
            "2001-2-3",
            "2001-12-14t21:59:43.10-05:00",
            "2001-12-14T21:59:43Z",
            "2001-2-3 4:05:06",
            "2001-2-3 4:05:06,5",
            "2000-02-29",
        ] {
            assert_eq!(resolve(TIMESTAMP, ok), Ok(Resolved::Typed), "{ok}");
        }
        for bad in [
            "2001-13-01",
            "2001-02-30",
            "1900-02-29",
            "2001-012-01",
            "2001-1-1T24:00:00Z",
            "2001-1-1T1:00:00+25:00",
            "2001-1-1 1:00:00Z",
            "201-1-1",
        ] {
            assert!(resolve(TIMESTAMP, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn binary_decodes_go_base64() {
        assert_eq!(
            resolve(BINARY, "aGVsbG8="),
            Ok(Resolved::Binary("hello".to_owned()))
        );
        assert_eq!(
            resolve(BINARY, "aGVs\nbG8="),
            Ok(Resolved::Binary("hello".to_owned()))
        );
        assert!(resolve(BINARY, "aGVsbG8").is_err());
        assert!(resolve(BINARY, "aG=sbG8=").is_err());
        assert_eq!(decode_base64(""), Some(Vec::new()));
    }
}
