//! OpenTelemetry RPC semantic conventions (v1.41.0) and HTTP/gRPC header
//! helpers for `libo11y-tonic`.

use std::borrow::Cow;

use http::header::{HOST, HeaderName, HeaderValue};
use http::{HeaderMap, StatusCode, Uri};
use opentelemetry::propagation::{Extractor, Injector};

/// Scope name stamped on the tracer and meter obtained from [`libo11y::Sdk`].
pub(crate) const SCOPE_NAME: &str = "libo11y-tonic";

/// Semconv `rpc.system.name` attribute key.
pub(crate) const RPC_SYSTEM_NAME: &str = "rpc.system.name";
/// Semconv `rpc.system.name` value for gRPC.
pub(crate) const RPC_SYSTEM_GRPC: &str = "grpc";
/// Semconv `rpc.method` attribute key.
pub(crate) const RPC_METHOD: &str = "rpc.method";
/// Semconv `rpc.method` value, and span name, for a method the server does
/// not implement, so unrouted paths cannot create unbounded series.
pub(crate) const RPC_METHOD_OTHER: &str = "_OTHER";
/// Semconv `rpc.response.status_code` attribute key.
pub(crate) const RPC_RESPONSE_STATUS_CODE: &str = "rpc.response.status_code";
/// Semconv `server.address` attribute key.
pub(crate) const SERVER_ADDRESS: &str = "server.address";
/// Semconv `server.port` attribute key.
pub(crate) const SERVER_PORT: &str = "server.port";
/// Semconv `error.type` attribute key.
pub(crate) const ERROR_TYPE: &str = "error.type";

/// Semconv server RPC duration histogram name.
pub(crate) const SERVER_CALL_DURATION: &str = "rpc.server.call.duration";
/// Semconv client RPC duration histogram name.
pub(crate) const CLIENT_CALL_DURATION: &str = "rpc.client.call.duration";

/// Recommended explicit bucket boundaries (in seconds) for RPC call duration
/// histograms in OpenTelemetry semantic conventions v1.41.0.
pub(crate) const DURATION_BUCKETS: &[f64] = &[
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1.0, 2.5, 5.0, 7.5, 10.0,
];

/// Full-method prefix of the standard gRPC health checking service.
pub(crate) const HEALTH_METHOD_PREFIX: &str = "/grpc.health.v1.Health/";

/// Header/trailer carrying the numeric gRPC status code.
const GRPC_STATUS_HEADER: &str = "grpc-status";
/// Header/trailer carrying the percent-encoded gRPC status message.
const GRPC_MESSAGE_HEADER: &str = "grpc-message";

/// Numeric gRPC status codes (per the gRPC specification).
pub(crate) const CODE_OK: i32 = 0;
pub(crate) const CODE_CANCELLED: i32 = 1;
pub(crate) const CODE_UNKNOWN: i32 = 2;
pub(crate) const CODE_DEADLINE_EXCEEDED: i32 = 4;
#[cfg(test)]
pub(crate) const CODE_NOT_FOUND: i32 = 5;
pub(crate) const CODE_PERMISSION_DENIED: i32 = 7;
pub(crate) const CODE_RESOURCE_EXHAUSTED: i32 = 8;
pub(crate) const CODE_UNIMPLEMENTED: i32 = 12;
pub(crate) const CODE_INTERNAL: i32 = 13;
pub(crate) const CODE_UNAVAILABLE: i32 = 14;
pub(crate) const CODE_DATA_LOSS: i32 = 15;
pub(crate) const CODE_UNAUTHENTICATED: i32 = 16;

/// Parsed gRPC response status code and optional message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GrpcStatus {
    pub(crate) code: i32,
    pub(crate) message: Option<String>,
}

impl GrpcStatus {
    /// Creates a status without a message.
    pub(crate) const fn new(code: i32) -> Self {
        Self {
            code,
            message: None,
        }
    }

    /// Creates a status with a message.
    pub(crate) fn with_message(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: Some(message.into()),
        }
    }

    /// Canonical OpenTelemetry / gRPC spelling of `self.code`.
    pub(crate) fn canonical_name(&self) -> Cow<'static, str> {
        canonical_code(self.code)
    }

    /// Extracts a `GrpcStatus` from HTTP headers or trailers if `grpc-status`
    /// is present and parses as an integer.
    pub(crate) fn from_headers(headers: &HeaderMap) -> Option<Self> {
        let raw = headers.get(GRPC_STATUS_HEADER)?.to_str().ok()?.trim();
        let code = raw.parse::<i32>().ok()?;
        let message = headers
            .get(GRPC_MESSAGE_HEADER)
            .and_then(|val| val.to_str().ok())
            .map(percent_decode);
        Some(Self { code, message })
    }

    /// Maps an HTTP status code to a gRPC status code per the gRPC over HTTP/2
    /// specification when no `grpc-status` header or trailer was delivered.
    ///
    /// An HTTP 200 without `grpc-status` is a truncated response, not a
    /// success: the stream ended before the trailers, so it reads `UNKNOWN`,
    /// as tonic and grpc-go report it.
    pub(crate) fn from_http_status(status: StatusCode) -> Self {
        if status == StatusCode::OK {
            return Self::with_message(CODE_UNKNOWN, "missing grpc-status trailer");
        }
        let code = match status.as_u16() {
            400 => CODE_INTERNAL,
            401 => CODE_UNAUTHENTICATED,
            403 => CODE_PERMISSION_DENIED,
            404 => CODE_UNIMPLEMENTED,
            429 | 502 | 503 | 504 => CODE_UNAVAILABLE,
            _ => CODE_UNKNOWN,
        };
        let reason = status.canonical_reason().unwrap_or("HTTP error");
        Self::with_message(code, format!("HTTP {}: {reason}", status.as_u16()))
    }
}

/// Returns the canonical uppercase gRPC status name for `code`, matching
/// `otelgrpc`'s `canonicalString` and semconv 1.41.0.
pub(crate) fn canonical_code(code: i32) -> Cow<'static, str> {
    match code {
        0 => Cow::Borrowed("OK"),
        1 => Cow::Borrowed("CANCELLED"),
        2 => Cow::Borrowed("UNKNOWN"),
        3 => Cow::Borrowed("INVALID_ARGUMENT"),
        4 => Cow::Borrowed("DEADLINE_EXCEEDED"),
        5 => Cow::Borrowed("NOT_FOUND"),
        6 => Cow::Borrowed("ALREADY_EXISTS"),
        7 => Cow::Borrowed("PERMISSION_DENIED"),
        8 => Cow::Borrowed("RESOURCE_EXHAUSTED"),
        9 => Cow::Borrowed("FAILED_PRECONDITION"),
        10 => Cow::Borrowed("ABORTED"),
        11 => Cow::Borrowed("OUT_OF_RANGE"),
        12 => Cow::Borrowed("UNIMPLEMENTED"),
        13 => Cow::Borrowed("INTERNAL"),
        14 => Cow::Borrowed("UNAVAILABLE"),
        15 => Cow::Borrowed("DATA_LOSS"),
        16 => Cow::Borrowed("UNAUTHENTICATED"),
        other => Cow::Owned(format!("CODE({other})")),
    }
}

/// Reports whether a gRPC status code represents a server-side failure.
///
/// Matches OpenTelemetry RPC semantic conventions and `otelgrpc`: client-fault
/// codes (such as `INVALID_ARGUMENT`, `NOT_FOUND`, `CANCELLED`) leave the
/// server span status `Unset`.
pub(crate) const fn is_server_error(code: i32) -> bool {
    matches!(
        code,
        CODE_UNKNOWN
            | CODE_DEADLINE_EXCEEDED
            | CODE_UNIMPLEMENTED
            | CODE_INTERNAL
            | CODE_UNAVAILABLE
            | CODE_DATA_LOSS
    )
}

/// Reports whether a gRPC status code represents a client-side failure.
pub(crate) const fn is_client_error(code: i32) -> bool {
    code != CODE_OK
}

/// Parses a gRPC request URI path (`/package.Service/Method`) into
/// `(span_name, rpc_method_attr)`.
///
/// Leading `/` is stripped to produce `package.Service/Method`. If the path
/// does not begin with `/`, the raw path is used as the span name and
/// `rpc.method` is omitted (matching `otelgrpc`'s `ParseFullMethod`).
pub(crate) fn parse_full_method(full_method: &str) -> (&str, Option<&str>) {
    match full_method.strip_prefix('/') {
        Some(trimmed) if !trimmed.is_empty() => (trimmed, Some(trimmed)),
        Some(trimmed) => (trimmed, None),
        None => (full_method, None),
    }
}

/// Extracts `(server.address, server.port)` from a request's URI authority or
/// `Host` header.
pub(crate) fn parse_server_address(
    uri: &Uri,
    headers: &HeaderMap,
) -> (Option<String>, Option<i64>) {
    if let Some(authority) = uri.authority() {
        let host = strip_ipv6_brackets(authority.host());
        let addr = (!host.is_empty()).then(|| host.to_owned());
        let port = authority.port_u16().map(i64::from);
        if addr.is_some() {
            return (addr, port);
        }
    }
    if let Some(host_val) = headers.get(HOST).and_then(|v| v.to_str().ok()) {
        return split_host_port(host_val.trim());
    }
    (None, None)
}

/// Splits a `Host` header value (`host`, `host:port`, `[::1]`, `[::1]:port`)
/// into `(address, port)`.
pub(crate) fn split_host_port(raw: &str) -> (Option<String>, Option<i64>) {
    if raw.is_empty() {
        return (None, None);
    }
    if let Some(rest) = raw.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let host = &rest[..end];
            let port = rest[end + 1..]
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .map(i64::from);
            return ((!host.is_empty()).then(|| host.to_owned()), port);
        }
        return (Some(raw.to_owned()), None);
    }
    if let Some((host, port_str)) = raw.rsplit_once(':')
        && !host.contains(':')
        && let Ok(port) = port_str.parse::<u16>()
    {
        return (
            (!host.is_empty()).then(|| host.to_owned()),
            Some(i64::from(port)),
        );
    }
    (Some(raw.to_owned()), None)
}

fn strip_ipv6_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host)
}

/// Percent-decodes a `grpc-message` header value without panicking on
/// malformed escape sequences.
pub(crate) fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    if !bytes.contains(&b'%') {
        return input.to_owned();
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

const fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Adapter reading W3C propagation headers from an [`http::HeaderMap`].
pub(crate) struct HeaderExtractor<'a>(pub(crate) &'a HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|v| v.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(HeaderName::as_str).collect()
    }
}

/// Adapter writing W3C propagation headers into an [`http::HeaderMap`].
pub(crate) struct HeaderInjector<'a>(pub(crate) &'a mut HeaderMap);

impl Injector for HeaderInjector<'_> {
    fn set(&mut self, key: &str, value: String) {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(key.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            self.0.insert(name, val);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_codes_cover_all_standard_and_unknown_values() {
        let expected = [
            (0, "OK"),
            (1, "CANCELLED"),
            (2, "UNKNOWN"),
            (3, "INVALID_ARGUMENT"),
            (4, "DEADLINE_EXCEEDED"),
            (5, "NOT_FOUND"),
            (6, "ALREADY_EXISTS"),
            (7, "PERMISSION_DENIED"),
            (8, "RESOURCE_EXHAUSTED"),
            (9, "FAILED_PRECONDITION"),
            (10, "ABORTED"),
            (11, "OUT_OF_RANGE"),
            (12, "UNIMPLEMENTED"),
            (13, "INTERNAL"),
            (14, "UNAVAILABLE"),
            (15, "DATA_LOSS"),
            (16, "UNAUTHENTICATED"),
        ];
        for (code, name) in expected {
            assert_eq!(canonical_code(code), name);
        }
        assert_eq!(canonical_code(99), "CODE(99)");
    }

    #[test]
    fn server_and_client_error_classification_matches_otelgrpc() {
        let server_faults = [2, 4, 12, 13, 14, 15];
        for code in 0..=16 {
            assert_eq!(
                is_server_error(code),
                server_faults.contains(&code),
                "server error for code {code}"
            );
            assert_eq!(
                is_client_error(code),
                code != 0,
                "client error for code {code}"
            );
        }
    }

    #[test]
    fn parse_full_method_strips_leading_slash() {
        assert_eq!(
            parse_full_method("/checkout.Cart/AddItem"),
            ("checkout.Cart/AddItem", Some("checkout.Cart/AddItem"))
        );
        assert_eq!(parse_full_method("bare"), ("bare", None));
        assert_eq!(parse_full_method("/"), ("", None));
    }

    #[test]
    fn parse_server_address_handles_authority_and_host_variants() {
        let uri: Uri = "http://api.example.com:8443/pkg.Svc/Call"
            .parse()
            .expect("uri");
        assert_eq!(
            parse_server_address(&uri, &HeaderMap::new()),
            (Some("api.example.com".to_owned()), Some(8443))
        );

        let ipv6: Uri = "http://[::1]:50051/pkg.Svc/Call".parse().expect("uri");
        assert_eq!(
            parse_server_address(&ipv6, &HeaderMap::new()),
            (Some("::1".to_owned()), Some(50051))
        );

        let rel: Uri = "/pkg.Svc/Call".parse().expect("uri");
        let mut headers = HeaderMap::new();
        headers.insert(HOST, HeaderValue::from_static("svc.local:9090"));
        assert_eq!(
            parse_server_address(&rel, &headers),
            (Some("svc.local".to_owned()), Some(9090))
        );

        headers.insert(HOST, HeaderValue::from_static("[::1]:50051"));
        assert_eq!(
            parse_server_address(&rel, &headers),
            (Some("::1".to_owned()), Some(50051))
        );

        headers.insert(HOST, HeaderValue::from_static("svc.local"));
        assert_eq!(
            parse_server_address(&rel, &headers),
            (Some("svc.local".to_owned()), None)
        );
    }

    #[test]
    fn percent_decode_decodes_grpc_messages_safely() {
        assert_eq!(percent_decode("plain text"), "plain text");
        assert_eq!(
            percent_decode("not%20found%3A%20id%3D42"),
            "not found: id=42"
        );
        assert_eq!(percent_decode("dangling%2"), "dangling%2");
        assert_eq!(percent_decode("bad%ZZhex"), "bad%ZZhex");
    }

    #[test]
    fn grpc_status_from_headers_and_http_fallback() {
        let mut headers = HeaderMap::new();
        headers.insert("grpc-status", HeaderValue::from_static("5"));
        headers.insert("grpc-message", HeaderValue::from_static("item%20missing"));
        assert_eq!(
            GrpcStatus::from_headers(&headers),
            Some(GrpcStatus::with_message(5, "item missing"))
        );

        assert_eq!(
            GrpcStatus::from_http_status(StatusCode::OK),
            GrpcStatus::with_message(CODE_UNKNOWN, "missing grpc-status trailer")
        );
        assert_eq!(
            GrpcStatus::from_http_status(StatusCode::NOT_FOUND).code,
            CODE_UNIMPLEMENTED
        );
        assert_eq!(
            GrpcStatus::from_http_status(StatusCode::SERVICE_UNAVAILABLE).code,
            CODE_UNAVAILABLE
        );
    }
}
