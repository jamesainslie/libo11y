//! HTTP URL, scheme, query redaction, and server address/port helpers per
//! OpenTelemetry HTTP semantic conventions 1.41.0.

use std::borrow::Cow;

use http::Uri;
use http::header::HOST;
use http::request::Parts;

/// Replacement value written for sensitive query parameters.
const REDACTED: &str = "REDACTED";

/// Returns `true` if `key` names a query parameter whose value may hold a
/// credential or signature (case-insensitive).
fn is_sensitive_query_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "awsaccesskeyid"
            | "signature"
            | "sig"
            | "x-goog-signature"
            | "x-amz-signature"
            | "x-amz-credential"
            | "x-amz-security-token"
            | "access_token"
            | "api_key"
            | "apikey"
            | "password"
            | "passwd"
            | "secret"
            | "token"
            | "client_secret"
            | "auth"
    )
}

/// Percent-decodes `input` the way Go's `url.PathUnescape` does: each `%XX`
/// escape becomes the byte it names and `+` is left alone.
///
/// Returns `input` borrowed and unchanged when it holds no `%`, when any
/// escape is invalid (not followed by two hex digits), or when the decoded
/// bytes are not valid UTF-8, so callers fall back to the raw form.
#[must_use]
pub fn percent_decode_or_raw(input: &str) -> Cow<'_, str> {
    if !input.contains('%') {
        return Cow::Borrowed(input);
    }
    let raw = input.as_bytes();
    let mut decoded = Vec::with_capacity(raw.len());
    let mut idx = 0;
    while let Some(&byte) = raw.get(idx) {
        if byte == b'%' {
            let (Some(hi), Some(lo)) = (
                raw.get(idx + 1).copied().and_then(hex_value),
                raw.get(idx + 2).copied().and_then(hex_value),
            ) else {
                return Cow::Borrowed(input);
            };
            decoded.push((hi << 4) | lo);
            idx += 3;
        } else {
            decoded.push(byte);
            idx += 1;
        }
    }
    String::from_utf8(decoded).map_or(Cow::Borrowed(input), Cow::Owned)
}

/// Returns the value of one ASCII hex digit.
const fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Redacts credential-bearing query parameter values in `query`, replacing
/// matched values with `REDACTED` while leaving non-sensitive parameters
/// unchanged.
///
/// Keys are percent-decoded for classification only, so `%74oken=abc`
/// becomes `%74oken=REDACTED`: the key keeps its original spelling. A key
/// with an invalid escape or invalid UTF-8 is classified on its raw form.
#[must_use]
pub fn redact_query(query: &str) -> String {
    if query.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(query.len());
    for (idx, pair) in query.split('&').enumerate() {
        if idx > 0 {
            out.push('&');
        }
        if let Some((key, _val)) = pair.split_once('=')
            && is_sensitive_query_key(&percent_decode_or_raw(key))
        {
            out.push_str(key);
            out.push('=');
            out.push_str(REDACTED);
        } else {
            out.push_str(pair);
        }
    }
    out
}

/// Renders `uri` for the `url.full` attribute, stripping any embedded userinfo
/// (`user:pass@`) from the authority and redacting sensitive query parameter
/// values.
#[must_use]
pub fn sanitize_url_full(uri: &Uri) -> String {
    let mut out = String::new();
    if let Some(scheme) = uri.scheme_str() {
        out.push_str(&scheme.to_ascii_lowercase());
        out.push(':');
    }
    if let Some(authority) = uri.authority() {
        out.push_str("//");
        // `Authority::host` and `Authority::port_str` exclude userinfo.
        out.push_str(authority.host());
        if let Some(port) = authority.port() {
            out.push(':');
            out.push_str(port.as_str());
        }
    }
    out.push_str(uri.path());
    if let Some(query) = uri.query() {
        out.push('?');
        out.push_str(&redact_query(query));
    }
    out
}

/// Determines `url.scheme` from request parts: `"https"` when the request
/// target names `https` in any case, and `"http"` otherwise.
///
/// The value lands on the `http.server.request.duration` metric, so it is
/// clamped to the two schemes an HTTP server serves. A client sending an
/// absolute-form target with an arbitrary scheme, such as `x1://a/ok`,
/// cannot mint a new series per scheme. An origin-form target with no
/// scheme reads as `"http"`.
#[must_use]
pub fn extract_scheme(parts: &Parts) -> String {
    match parts.uri.scheme_str() {
        Some(scheme) if scheme.eq_ignore_ascii_case("https") => "https".to_owned(),
        _ => "http".to_owned(),
    }
}

/// Extracts `(server.address, server.port)` from request URI authority or the
/// `Host` header, falling back to the default port for `http` (80) or `https`
/// (443) when a host is present without an explicit port.
#[must_use]
pub fn extract_server_address_port(parts: &Parts, scheme: &str) -> (Option<String>, Option<i64>) {
    if let Some(authority) = parts.uri.authority() {
        let host = strip_ipv6_brackets(authority.host());
        if !host.is_empty() {
            let port = authority
                .port_u16()
                .or_else(|| default_port_for_scheme(scheme))
                .map(i64::from);
            return (Some(host.to_owned()), port);
        }
    }
    if let Some(raw_host) = parts
        .headers
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|h| !h.is_empty())
    {
        let (host, explicit_port) = parse_host_port(raw_host);
        if !host.is_empty() {
            let port = explicit_port
                .or_else(|| default_port_for_scheme(scheme))
                .map(i64::from);
            return (Some(host.to_owned()), port);
        }
    }
    (None, None)
}

/// Strips surrounding `[` and `]` brackets from an IPv6 literal host.
#[must_use]
pub fn strip_ipv6_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host)
}

/// Returns the default TCP port for `http` (80) and `https` (443).
#[must_use]
pub fn default_port_for_scheme(scheme: &str) -> Option<u16> {
    if scheme.eq_ignore_ascii_case("http") {
        Some(80)
    } else if scheme.eq_ignore_ascii_case("https") {
        Some(443)
    } else {
        None
    }
}

fn parse_host_port(raw: &str) -> (&str, Option<u16>) {
    if let Some(rest) = raw.strip_prefix('[') {
        if let Some((addr, after)) = rest.split_once(']') {
            let port = after.strip_prefix(':').and_then(|p| p.parse::<u16>().ok());
            return (addr, port);
        }
        return (raw, None);
    }
    if let Some((host, port_str)) = raw.rsplit_once(':')
        && !host.contains(':')
        && let Ok(port) = port_str.parse::<u16>()
    {
        return (host, Some(port));
    }
    (raw, None)
}

#[cfg(test)]
mod tests {
    use http::Request;

    use super::*;

    #[test]
    fn redact_query_masks_credentials_and_preserves_other_params() {
        assert_eq!(redact_query(""), "");
        assert_eq!(redact_query("page=2&sort=asc"), "page=2&sort=asc");
        assert_eq!(
            redact_query("page=1&api_key=s3cr3t&AWSAccessKeyId=AKIA&sig=abc&ok=yes"),
            "page=1&api_key=REDACTED&AWSAccessKeyId=REDACTED&sig=REDACTED&ok=yes"
        );
        assert_eq!(redact_query("flag&token=xyz"), "flag&token=REDACTED");
    }

    #[test]
    fn redact_query_masks_aws_sigv4_presigned_params() {
        assert_eq!(
            redact_query(
                "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261128&\
                 X-Amz-Signature=deadbeef&X-Amz-Security-Token=FwoG&X-Amz-Expires=60"
            ),
            "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=REDACTED&\
             X-Amz-Signature=REDACTED&X-Amz-Security-Token=REDACTED&X-Amz-Expires=60"
        );
        assert_eq!(
            redact_query("x-amz-signature=abc"),
            "x-amz-signature=REDACTED"
        );
    }

    fn scheme_of(uri: &str) -> String {
        let (parts, ()) = Request::builder()
            .uri(uri)
            .body(())
            .expect("req")
            .into_parts();
        extract_scheme(&parts)
    }

    #[test]
    fn extract_scheme_clamps_to_http_or_https() {
        assert_eq!(scheme_of("/ok"), "http");
        assert_eq!(scheme_of("http://a/ok"), "http");
        assert_eq!(scheme_of("HTTP://a/ok"), "http");
        assert_eq!(scheme_of("https://a/ok"), "https");
        assert_eq!(scheme_of("HtTpS://a/ok"), "https");
        assert_eq!(scheme_of("x1://a/ok"), "http");
        assert_eq!(scheme_of("x2://a/ok"), "http");
        assert_eq!(scheme_of("ftp://a/ok"), "http");
    }

    #[test]
    fn redact_query_classifies_percent_encoded_keys_and_keeps_their_spelling() {
        assert_eq!(redact_query("%74oken=abc"), "%74oken=REDACTED");
        assert_eq!(
            redact_query("page=1&api%5Fkey=s3cr3t&%41WSAccessKeyId=AKIA&q=%74oken"),
            "page=1&api%5Fkey=REDACTED&%41WSAccessKeyId=REDACTED&q=%74oken"
        );
    }

    #[test]
    fn redact_query_classifies_keys_with_bad_escapes_on_their_raw_form() {
        assert_eq!(
            redact_query("%zztoken=abc&tok%en=x"),
            "%zztoken=abc&tok%en=x"
        );
        assert_eq!(redact_query("%ff%fe=abc"), "%ff%fe=abc");
    }

    #[test]
    fn percent_decode_borrows_unless_it_decodes() {
        assert!(matches!(
            percent_decode_or_raw("/healthz"),
            Cow::Borrowed("/healthz")
        ));
        assert_eq!(percent_decode_or_raw("/%68ealthz"), "/healthz");
        assert_eq!(percent_decode_or_raw("/a%2Fb"), "/a/b");
        assert!(matches!(
            percent_decode_or_raw("/bad%zz"),
            Cow::Borrowed("/bad%zz")
        ));
        assert!(matches!(
            percent_decode_or_raw("/trunc%6"),
            Cow::Borrowed("/trunc%6")
        ));
        assert!(matches!(
            percent_decode_or_raw("/%ff"),
            Cow::Borrowed("/%ff")
        ));
        assert_eq!(percent_decode_or_raw("/caf%C3%A9"), "/caf\u{e9}");
        assert_eq!(percent_decode_or_raw("/\u{e9}%41"), "/\u{e9}A");
        assert_eq!(
            percent_decode_or_raw("%2541"),
            "%41",
            "decodes exactly once"
        );
        assert_eq!(
            percent_decode_or_raw("a+b%2Bc"),
            "a+b+c",
            "+ is not a space"
        );
        assert!(matches!(percent_decode_or_raw("/a%"), Cow::Borrowed("/a%")));
        assert!(matches!(
            percent_decode_or_raw("/%\u{e9}"),
            Cow::Borrowed("/%\u{e9}")
        ));
    }

    #[test]
    fn sanitize_url_full_strips_userinfo_and_redacts_query() {
        let uri: Uri = "https://alice:hunter2@api.example.com:8443/v1/orders?id=7&token=abc"
            .parse()
            .expect("valid uri");
        assert_eq!(
            sanitize_url_full(&uri),
            "https://api.example.com:8443/v1/orders?id=7&token=REDACTED"
        );

        let ipv6: Uri = "http://user@ [::1]:8080/ping"
            .replace(' ', "")
            .parse()
            .expect("valid ipv6 uri");
        assert_eq!(sanitize_url_full(&ipv6), "http://[::1]:8080/ping");
    }

    #[test]
    fn extract_server_address_port_handles_uri_and_host_header() {
        let req = Request::builder()
            .uri("https://api.example.com:8443/users")
            .body(())
            .expect("req");
        let (parts, ()) = req.into_parts();
        assert_eq!(
            extract_server_address_port(&parts, "https"),
            (Some("api.example.com".to_owned()), Some(8443))
        );

        let req = Request::builder()
            .uri("/users")
            .header(HOST, "example.com")
            .body(())
            .expect("req");
        let (parts, ()) = req.into_parts();
        assert_eq!(
            extract_server_address_port(&parts, "http"),
            (Some("example.com".to_owned()), Some(80))
        );

        let req = Request::builder()
            .uri("/users")
            .header(HOST, "[::1]:9090")
            .body(())
            .expect("req");
        let (parts, ()) = req.into_parts();
        assert_eq!(
            extract_server_address_port(&parts, "http"),
            (Some("::1".to_owned()), Some(9090))
        );
    }
}
