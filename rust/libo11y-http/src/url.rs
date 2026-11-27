//! HTTP URL, scheme, query redaction, and server address/port helpers per
//! OpenTelemetry HTTP semantic conventions 1.41.0.

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

/// Redacts credential-bearing query parameter values in `query`, replacing
/// matched values with `REDACTED` while leaving non-sensitive parameters
/// unchanged.
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
            && is_sensitive_query_key(key)
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

/// Determines `url.scheme` from request parts, defaulting to `"http"` when the
/// request target is in origin form without a scheme.
#[must_use]
pub fn extract_scheme(parts: &Parts) -> String {
    parts
        .uri
        .scheme_str()
        .map_or_else(|| "http".to_owned(), str::to_ascii_lowercase)
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
