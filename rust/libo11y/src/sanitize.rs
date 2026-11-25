//! How the startup summary shows an exporter endpoint: without userinfo,
//! query or fragment, and `unparseable` when anything is ambiguous, so a
//! credential is never echoed.
//!
//! This reproduces Go's `sanitizeEndpoint`, which formats with `net/url`'s
//! `URL.String`: only the scheme is lowercased and the host and path are
//! escaped. A WHATWG URL parser normalizes far more, so this is a port of
//! Go 1.26's `url.Parse` over bytes, the same port the TypeScript library
//! carries (`conformance/vectors/endpoint-sanitize.json`).

/// What a value that cannot be shown safely renders as.
const WITHHELD: &str = "unparseable";

/// Renders an exporter endpoint for display without credentials, as Go's
/// `sanitizeEndpoint` does.
///
/// A value without `://` is read as a scheme-less `host:port`, the form
/// gRPC endpoints take. Userinfo, the query and the fragment are removed,
/// and the path is kept. A credential holding an unencoded `/`, `?` or `#`
/// ends the authority early, so any `@` other than one userinfo separator,
/// and any `@` that survives into the output, withholds the whole value
/// rather than echoing part of a secret.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the startup summary reads it once it exists")
)]
pub(crate) fn sanitize_endpoint(raw: &str) -> String {
    let schemeless = !raw.contains("://");
    let input = if schemeless {
        format!("//{raw}")
    } else {
        raw.to_owned()
    };
    let Some(url) = parse(input.as_bytes()) else {
        return WITHHELD.to_owned();
    };
    if url.host.is_empty() {
        return WITHHELD.to_owned();
    }
    let ats = input.bytes().filter(|&b| b == b'@').count();
    if ats > 1 || (ats == 1 && !url.has_user) {
        return WITHHELD.to_owned();
    }
    let out = url.format();
    if out.contains(&b'@') {
        return WITHHELD.to_owned();
    }
    let out = if schemeless {
        out.strip_prefix(b"//").unwrap_or(&out)
    } else {
        &out
    };
    // Every byte above 0x7f was escaped, so the output is ASCII.
    String::from_utf8_lossy(out).into_owned()
}

/// The escaping contexts of Go's `net/url` that the sanitizer needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Path,
    Host,
    Zone,
    UserPassword,
    Fragment,
}

/// Go's `shouldEscape`.
fn should_escape(c: u8, mode: Mode) -> bool {
    if c.is_ascii_alphanumeric() {
        return false;
    }
    if matches!(mode, Mode::Host | Mode::Zone) && b"!$&'()*+,;=:[]<>\"".contains(&c) {
        return false;
    }
    if b"-_.~".contains(&c) {
        return false;
    }
    if b"$&+,/:;=?@".contains(&c) {
        match mode {
            Mode::Path => return c == b'?',
            Mode::UserPassword => return matches!(c, b'@' | b'/' | b'?' | b':'),
            Mode::Fragment => return false,
            Mode::Host | Mode::Zone => {}
        }
    }
    if mode == Mode::Fragment && b"!()*".contains(&c) {
        return false;
    }
    true
}

fn unhex(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => 0,
    }
}

/// Go's `unescape`: validates the escapes for `mode` and decodes them.
fn unescape(s: &[u8], mode: Mode) -> Option<Vec<u8>> {
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if c == b'%' {
            if i + 2 >= s.len() || !s[i + 1].is_ascii_hexdigit() || !s[i + 2].is_ascii_hexdigit() {
                return None;
            }
            let escape = &s[i..i + 3];
            if mode == Mode::Host && unhex(s[i + 1]) < 8 && escape != b"%25" {
                return None;
            }
            if mode == Mode::Zone {
                let v = unhex(s[i + 1]) << 4 | unhex(s[i + 2]);
                if escape != b"%25" && v != b' ' && should_escape(v, Mode::Host) {
                    return None;
                }
            }
            i += 3;
        } else {
            if matches!(mode, Mode::Host | Mode::Zone) && c < 0x80 && should_escape(c, mode) {
                return None;
            }
            i += 1;
        }
    }
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'%' {
            out.push(unhex(s[i + 1]) << 4 | unhex(s[i + 2]));
            i += 3;
        } else {
            out.push(s[i]);
            i += 1;
        }
    }
    Some(out)
}

/// Go's `escape`, which writes upper-case hex digits.
fn escape(s: &[u8], mode: Mode) -> Vec<u8> {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = Vec::with_capacity(s.len());
    for &c in s {
        if should_escape(c, mode) {
            out.extend_from_slice(&[b'%', HEX[usize::from(c >> 4)], HEX[usize::from(c & 15)]]);
        } else {
            out.push(c);
        }
    }
    out
}

/// Go's `validEncoded`.
fn valid_encoded(s: &[u8], mode: Mode) -> bool {
    s.iter()
        .all(|&c| b"!$&'()*+,;=:@[]%".contains(&c) || !should_escape(c, mode))
}

/// Go's `validOptionalPort`.
fn valid_optional_port(port: &[u8]) -> bool {
    match port.split_first() {
        None => true,
        Some((b':', digits)) => digits.iter().all(u8::is_ascii_digit),
        Some(_) => false,
    }
}

/// Go's `validUserinfo`.
fn valid_userinfo(s: &[u8]) -> bool {
    s.iter()
        .all(|&c| c.is_ascii_alphanumeric() || b"-._:~!$&'()*+,;=%@".contains(&c))
}

/// netip's strict dotted-decimal IPv4 parse: four fields, no leading
/// zeros, each at most 255.
fn is_ipv4(s: &[u8]) -> bool {
    let mut fields = 0;
    for field in s.split(|&c| c == b'.') {
        fields += 1;
        let digits_ok = !field.is_empty()
            && field.len() <= 3
            && field.iter().all(u8::is_ascii_digit)
            && (field.len() == 1 || field[0] != b'0');
        if !digits_ok {
            return false;
        }
        let value = field
            .iter()
            .fold(0u32, |acc, &d| acc * 10 + u32::from(d - b'0'));
        if value > 255 {
            return false;
        }
    }
    fields == 4
}

/// netip's IPv6 parse, with an optional non-empty zone after `%`.
fn is_ipv6(input: &[u8]) -> bool {
    let mut s = input;
    if let Some(pct) = s.iter().position(|&c| c == b'%') {
        if pct == s.len() - 1 {
            return false;
        }
        s = &s[..pct];
    }
    let mut ellipsis: Option<usize> = None;
    let mut groups = 0;
    if s.starts_with(b"::") {
        ellipsis = Some(0);
        s = &s[2..];
        if s.is_empty() {
            return true;
        }
    }
    while groups < 8 {
        let digits = s.iter().take_while(|c| c.is_ascii_hexdigit()).count();
        if digits == 0 || digits > 4 {
            return false;
        }
        if s.get(digits) == Some(&b'.') {
            if (ellipsis.is_none() && groups != 6) || groups + 2 > 8 || !is_ipv4(s) {
                return false;
            }
            groups += 2;
            s = &[];
            break;
        }
        groups += 1;
        s = &s[digits..];
        if s.is_empty() {
            break;
        }
        if s[0] != b':' || s.len() == 1 {
            return false;
        }
        s = &s[1..];
        if s[0] == b':' {
            if ellipsis.is_some() {
                return false;
            }
            ellipsis = Some(groups);
            s = &s[1..];
            if s.is_empty() {
                break;
            }
        }
    }
    if !s.is_empty() {
        return false;
    }
    if groups < 8 {
        ellipsis.is_some()
    } else {
        ellipsis.is_none()
    }
}

/// Reports whether `netip.ParseAddr` accepts `s` as an address that is not
/// IPv4.
fn is_ipv6_literal(s: &[u8]) -> bool {
    s.iter().find(|c| matches!(c, b'.' | b':' | b'%')) == Some(&b':') && is_ipv6(s)
}

fn last_index(s: &[u8], c: u8) -> Option<usize> {
    s.iter().rposition(|&b| b == c)
}

fn index(s: &[u8], c: u8) -> Option<usize> {
    s.iter().position(|&b| b == c)
}

/// Go 1.26's `parseHost`.
fn parse_host(scheme: &[u8], host: &[u8]) -> Option<Vec<u8>> {
    match last_index(host, b'[') {
        Some(0) => {
            let close = last_index(host, b']')?;
            let colon_port = host.get(close + 1..)?;
            if !valid_optional_port(colon_port) {
                return None;
            }
            let port = unescape(colon_port, Mode::Host)?;
            let hostname = host.get(1..close)?;
            let unescaped = match hostname.windows(3).position(|w| w == b"%25") {
                Some(zone) => {
                    let mut address = unescape(&hostname[..zone], Mode::Host)?;
                    address.extend(unescape(&hostname[zone..], Mode::Zone)?);
                    address
                }
                None => unescape(hostname, Mode::Host)?,
            };
            if !is_ipv6_literal(&unescaped) {
                return None;
            }
            let mut out = Vec::with_capacity(unescaped.len() + port.len() + 2);
            out.push(b'[');
            out.extend(unescaped);
            out.push(b']');
            out.extend(port);
            Some(out)
        }
        Some(_) => None,
        None => {
            if let Some(first) = index(host, b':') {
                let mut i = first;
                let last = last_index(host, b':').unwrap_or(first);
                // Go keeps the first colon for http and https (GODEBUG
                // urlstrictcolons=1) and the last one for other schemes.
                if last != first && scheme != b"http" && scheme != b"https" {
                    i = last;
                }
                if !valid_optional_port(&host[i..]) {
                    return None;
                }
            }
            unescape(host, Mode::Host)
        }
    }
}

/// The parts of a Go `url.URL` the sanitizer reads.
#[derive(Debug, Default)]
struct ParsedUrl {
    scheme: Vec<u8>,
    opaque: Vec<u8>,
    has_user: bool,
    host: Vec<u8>,
    path: Vec<u8>,
    raw_path: Vec<u8>,
    omit_host: bool,
}

/// Go's `getScheme`. `None` is Go's "missing protocol scheme" error.
fn get_scheme(raw: &[u8]) -> Option<(&[u8], &[u8])> {
    for (i, &c) in raw.iter().enumerate() {
        match c {
            b'a'..=b'z' | b'A'..=b'Z' => {}
            b'0'..=b'9' | b'+' | b'-' | b'.' => {
                if i == 0 {
                    return Some((&[], raw));
                }
            }
            b':' => {
                if i == 0 {
                    return None;
                }
                return Some((&raw[..i], &raw[i + 1..]));
            }
            _ => return Some((&[], raw)),
        }
    }
    Some((&[], raw))
}

/// Go's `url.Parse`, keeping only what the sanitizer reads.
fn parse(raw: &[u8]) -> Option<ParsedUrl> {
    let (u, frag) = match index(raw, b'#') {
        Some(hash) => (&raw[..hash], &raw[hash + 1..]),
        None => (raw, &[][..]),
    };
    // Go rejects any ASCII control character.
    if u.iter().any(|&c| c < 0x20 || c == 0x7f) {
        return None;
    }
    let mut url = ParsedUrl::default();
    if u == b"*" {
        url.path = b"*".to_vec();
    } else {
        let (scheme, mut rest) = get_scheme(u)?;
        url.scheme = scheme.to_ascii_lowercase();
        // A lone trailing '?' is Go's ForceQuery; otherwise the query
        // starts at the first '?'. Either way it is dropped.
        if let Some(q) = index(rest, b'?') {
            rest = &rest[..q];
        }
        let mut opaque = false;
        if !rest.starts_with(b"/") {
            if url.scheme.is_empty() {
                let segment = rest.split(|&c| c == b'/').next().unwrap_or_default();
                if segment.contains(&b':') {
                    return None;
                }
            } else {
                url.opaque = rest.to_vec();
                opaque = true;
            }
        }
        if !opaque {
            if (!url.scheme.is_empty() || !rest.starts_with(b"///")) && rest.starts_with(b"//") {
                let mut authority = &rest[2..];
                rest = &[];
                if let Some(slash) = index(authority, b'/') {
                    rest = &authority[slash..];
                    authority = &authority[..slash];
                }
                let at = last_index(authority, b'@');
                let host_part = at.map_or(authority, |at| &authority[at + 1..]);
                url.host = parse_host(&url.scheme, host_part)?;
                if let Some(at) = at {
                    let userinfo = &authority[..at];
                    if !valid_userinfo(userinfo) {
                        return None;
                    }
                    match index(userinfo, b':') {
                        None => {
                            unescape(userinfo, Mode::UserPassword)?;
                        }
                        Some(colon) => {
                            unescape(&userinfo[..colon], Mode::UserPassword)?;
                            unescape(&userinfo[colon + 1..], Mode::UserPassword)?;
                        }
                    }
                    url.has_user = true;
                }
            } else if !url.scheme.is_empty() && rest.starts_with(b"/") {
                url.omit_host = true;
            }
            url.path = unescape(rest, Mode::Path)?;
            if escape(&url.path, Mode::Path) != rest {
                url.raw_path = rest.to_vec();
            }
        }
    }
    if !frag.is_empty() {
        unescape(frag, Mode::Fragment)?;
    }
    Some(url)
}

impl ParsedUrl {
    /// Go's `URL.EscapedPath`.
    fn escaped_path(&self) -> Vec<u8> {
        if !self.raw_path.is_empty()
            && valid_encoded(&self.raw_path, Mode::Path)
            && unescape(&self.raw_path, Mode::Path).as_deref() == Some(self.path.as_slice())
        {
            return self.raw_path.clone();
        }
        if self.path == b"*" {
            return self.path.clone();
        }
        escape(&self.path, Mode::Path)
    }

    /// Go's `URL.String` for a URL without userinfo, query or fragment.
    fn format(&self) -> Vec<u8> {
        let mut out = Vec::new();
        if !self.scheme.is_empty() {
            out.extend_from_slice(&self.scheme);
            out.push(b':');
        }
        if !self.opaque.is_empty() {
            out.extend_from_slice(&self.opaque);
            return out;
        }
        // Go writes the authority when there is a scheme or a host, except
        // for an empty host the input omitted.
        if !self.host.is_empty() || (!self.scheme.is_empty() && !self.omit_host) {
            if !self.host.is_empty() || !self.path.is_empty() {
                out.extend_from_slice(b"//");
            }
            if !self.host.is_empty() {
                out.extend(escape(&self.host, Mode::Host));
            }
        }
        let path = self.escaped_path();
        if path.first().is_some_and(|&c| c != b'/') && !self.host.is_empty() {
            out.push(b'/');
        }
        if out.is_empty() {
            let segment = path.split(|&c| c == b'/').next().unwrap_or_default();
            if segment.contains(&b':') {
                out.extend_from_slice(b"./");
            }
        }
        out.extend(path);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct Vector {
        #[serde(rename = "in")]
        input: String,
        want: String,
    }

    #[test]
    fn matches_the_conformance_vectors() {
        let Some(path) = crate::test_support::conformance("vectors/endpoint-sanitize.json") else {
            return;
        };
        let raw = std::fs::read_to_string(path).expect("the conformance vectors are readable");
        let vectors: Vec<Vector> = serde_json::from_str(&raw).expect("the vectors are JSON");
        assert!(vectors.len() >= 20, "found {} vectors", vectors.len());
        for v in vectors {
            assert_eq!(sanitize_endpoint(&v.input), v.want, "input {:?}", v.input);
        }
    }

    // The table from go/summary_test.go TestSanitizeEndpoint.
    #[test]
    fn matches_the_go_table() {
        let cases = [
            (
                "https://user:tok3n@collector.example:4318/v1?api_key=k3y#frag",
                "https://collector.example:4318/v1",
            ),
            (
                "http://collector.example:4318",
                "http://collector.example:4318",
            ),
            ("collector.example:4317", "collector.example:4317"),
            ("user:pw@collector.example:4317", "collector.example:4317"),
            ("https://collector.example/?", "https://collector.example/"),
            ("https://[::1]:4318/v1", "https://[::1]:4318/v1"),
            ("://bad", WITHHELD),
            ("http://%zz", WITHHELD),
            ("https://AbC/x+y@collector.example:4318", WITHHELD),
            ("AbC/x+y@collector.example:4317", WITHHELD),
            ("https://user:/s3cr3t@collector.example", WITHHELD),
            ("https://user:12?ab@collector.example:4318", WITHHELD),
            ("https://u:p@x/y@collector.example", WITHHELD),
            ("https://u:p@ss?word@collector.example:4318", WITHHELD),
            ("https://u:S3cr3t@abc?x@collector.example:4318/v1", WITHHELD),
            ("u:p@ss?word@collector.example:4317", WITHHELD),
        ];
        for (raw, want) in cases {
            assert_eq!(sanitize_endpoint(raw), want, "input {raw:?}");
        }
    }
}
