//! OpenTelemetry RPC semantic conventions (v1.41.0), Connect/gRPC protocol
//! helpers, and W3C header propagation adapters for `libo11y-connect`.

use connectrpc::{ErrorCode, Protocol};
use http::header::{HOST, HeaderName, HeaderValue};
use http::{HeaderMap, StatusCode, Uri};
use opentelemetry::propagation::{Extractor, Injector};

/// Scope name stamped on the tracer and meter obtained from [`libo11y::Sdk`].
pub(crate) const SCOPE_NAME: &str = "libo11y-connect";

/// Semconv `rpc.system.name` attribute key.
pub(crate) const RPC_SYSTEM_NAME: &str = "rpc.system.name";
/// Semconv `rpc.system.name` value for the Connect protocol.
pub(crate) const RPC_SYSTEM_CONNECTRPC: &str = "connectrpc";
/// Semconv `rpc.system.name` value for gRPC and gRPC-Web protocols.
pub(crate) const RPC_SYSTEM_GRPC: &str = "grpc";
/// Semconv `rpc.method` attribute key.
pub(crate) const RPC_METHOD: &str = "rpc.method";
/// Semconv `rpc.response.status_code` attribute key.
pub(crate) const RPC_RESPONSE_STATUS_CODE: &str = "rpc.response.status_code";
/// Semconv `http.request.method` attribute key.
pub(crate) const HTTP_REQUEST_METHOD: &str = "http.request.method";
/// Semconv `http.response.status_code` attribute key.
pub(crate) const HTTP_RESPONSE_STATUS_CODE: &str = "http.response.status_code";
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

/// Procedure prefix of the standard gRPC health checking service.
pub(crate) const HEALTH_PROCEDURE_PREFIX: &str = "/grpc.health.v1.Health/";

/// Canonical `rpc.response.status_code` spelling for a successful RPC.
pub(crate) const STATUS_CODE_OK: &str = "OK";

/// Header/trailer carrying the numeric gRPC status code.
const GRPC_STATUS_HEADER: &str = "grpc-status";
/// Header/trailer carrying the gRPC status message.
const GRPC_MESSAGE_HEADER: &str = "grpc-message";

/// Connect streaming end-of-stream envelope flag bit.
const CONNECT_END_STREAM_FLAG: u8 = 0x02;
/// Envelope compression flag bit.
const ENVELOPE_COMPRESSED_FLAG: u8 = 0x01;
/// gRPC-Web trailer envelope flag bit.
const GRPC_WEB_TRAILER_FLAG: u8 = 0x80;
/// Size of a Connect/gRPC envelope header (1 flag byte + 4-byte BE length).
const ENVELOPE_HEADER_LEN: usize = 5;

/// Returns the `rpc.system.name` attribute value for a wire protocol, matching
/// Go's `o11yconnect` and `otelconnect`.
pub(crate) const fn rpc_system(protocol: Option<Protocol>) -> &'static str {
    match protocol {
        Some(Protocol::Grpc | Protocol::GrpcWeb) => RPC_SYSTEM_GRPC,
        _ => RPC_SYSTEM_CONNECTRPC,
    }
}

/// Returns the canonical uppercase `rpc.response.status_code` spelling for a
/// Connect [`ErrorCode`], matching Go's `strings.ToUpper(code.String())` and
/// `otelconnect`.
pub(crate) const fn canonical_code(code: ErrorCode) -> &'static str {
    match code {
        ErrorCode::Canceled => "CANCELED",
        ErrorCode::InvalidArgument => "INVALID_ARGUMENT",
        ErrorCode::DeadlineExceeded => "DEADLINE_EXCEEDED",
        ErrorCode::NotFound => "NOT_FOUND",
        ErrorCode::AlreadyExists => "ALREADY_EXISTS",
        ErrorCode::PermissionDenied => "PERMISSION_DENIED",
        ErrorCode::ResourceExhausted => "RESOURCE_EXHAUSTED",
        ErrorCode::FailedPrecondition => "FAILED_PRECONDITION",
        ErrorCode::Aborted => "ABORTED",
        ErrorCode::OutOfRange => "OUT_OF_RANGE",
        ErrorCode::Unimplemented => "UNIMPLEMENTED",
        ErrorCode::Internal => "INTERNAL",
        ErrorCode::Unavailable => "UNAVAILABLE",
        ErrorCode::DataLoss => "DATA_LOSS",
        ErrorCode::Unauthenticated => "UNAUTHENTICATED",
        _ => "UNKNOWN",
    }
}

/// Reports whether `code` indicates a server fault (matching Go's
/// `o11yconnect.serverFault` and `otelconnect`).
pub(crate) const fn is_server_fault(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::Unknown
            | ErrorCode::DeadlineExceeded
            | ErrorCode::Unimplemented
            | ErrorCode::Internal
            | ErrorCode::Unavailable
            | ErrorCode::DataLoss
    )
}

/// Maps a Connect [`ErrorCode`] to its Connect unary HTTP status code.
pub(crate) fn http_status_for_code(code: ErrorCode) -> u16 {
    code.http_status().as_u16()
}

/// Maps an HTTP status code from a Connect unary error response to a fallback
/// [`ErrorCode`] when the JSON body does not specify one.
pub(crate) const fn error_code_from_http_status(status: StatusCode) -> Option<ErrorCode> {
    match status.as_u16() {
        200 | 304 => None,
        400 => Some(ErrorCode::Internal),
        401 => Some(ErrorCode::Unauthenticated),
        403 => Some(ErrorCode::PermissionDenied),
        404 | 501 => Some(ErrorCode::Unimplemented),
        409 => Some(ErrorCode::Aborted),
        429 | 502 | 503 | 504 => Some(ErrorCode::Unavailable),
        499 => Some(ErrorCode::Canceled),
        _ => Some(ErrorCode::Unknown),
    }
}

/// Parses a gRPC status code from HTTP headers or trailers.
///
/// Returns `Some(Ok(()))` when `grpc-status: 0` (OK), `Some(Err((code, msg)))`
/// for any non-zero status, or `None` if `grpc-status` is absent.
pub(crate) fn parse_grpc_status_headers(
    headers: &HeaderMap,
) -> Option<Result<(), (ErrorCode, Option<String>)>> {
    let raw = headers.get(GRPC_STATUS_HEADER)?.to_str().ok()?.trim();
    let numeric = raw.parse::<u32>().ok()?;
    if numeric == 0 {
        return Some(Ok(()));
    }
    let code = ErrorCode::from_grpc_code(numeric).unwrap_or(ErrorCode::Unknown);
    let message = headers
        .get(GRPC_MESSAGE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    Some(Err((code, message)))
}

/// Attempts to parse `{"code": "..."}` from a Connect unary JSON error body.
pub(crate) fn parse_connect_error_json(bytes: &[u8]) -> Option<(ErrorCode, Option<String>)> {
    let val: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let obj = val.as_object()?;
    let code_str = obj.get("code")?.as_str()?;
    let code = code_str.parse::<ErrorCode>().ok()?;
    let message = obj
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    Some((code, message))
}

/// Scans uncompressed Connect streaming envelope frames for an `END_STREAM`
/// (`0x02`) frame carrying `{"error": {"code": "..."}}`.
pub(crate) fn parse_connect_end_stream_error(bytes: &[u8]) -> Option<(ErrorCode, Option<String>)> {
    let mut offset = 0;
    while bytes.len().saturating_sub(offset) >= ENVELOPE_HEADER_LEN {
        let flags = bytes[offset];
        let len = u32::from_be_bytes([
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
            bytes[offset + 4],
        ]) as usize;
        let payload_start = offset + ENVELOPE_HEADER_LEN;
        let frame_end = payload_start.checked_add(len)?;
        if frame_end > bytes.len() {
            return None;
        }
        if flags & CONNECT_END_STREAM_FLAG != 0 && flags & ENVELOPE_COMPRESSED_FLAG == 0 {
            let val: serde_json::Value =
                serde_json::from_slice(&bytes[payload_start..frame_end]).ok()?;
            let err_obj = val.get("error")?.as_object()?;
            let code_str = err_obj.get("code")?.as_str()?;
            let code = code_str.parse::<ErrorCode>().ok()?;
            let message = err_obj
                .get("message")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            return Some((code, message));
        }
        offset = frame_end;
    }
    None
}

/// Scans uncompressed gRPC-Web envelope frames for a trailer frame (`0x80`)
/// carrying `grpc-status`.
pub(crate) fn parse_grpc_web_trailer_status(
    bytes: &[u8],
) -> Option<Result<(), (ErrorCode, Option<String>)>> {
    let mut offset = 0;
    while bytes.len().saturating_sub(offset) >= ENVELOPE_HEADER_LEN {
        let flags = bytes[offset];
        let len = u32::from_be_bytes([
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
            bytes[offset + 4],
        ]) as usize;
        let payload_start = offset + ENVELOPE_HEADER_LEN;
        let frame_end = payload_start.checked_add(len)?;
        if frame_end > bytes.len() {
            return None;
        }
        if flags & GRPC_WEB_TRAILER_FLAG != 0 && flags & ENVELOPE_COMPRESSED_FLAG == 0 {
            let text = std::str::from_utf8(&bytes[payload_start..frame_end]).ok()?;
            let mut numeric = None;
            let mut message = None;
            for line in text.split('\n') {
                let line = line.trim_end_matches('\r');
                if let Some((k, v)) = line.split_once(':') {
                    let key = k.trim();
                    let val = v.trim();
                    if key.eq_ignore_ascii_case(GRPC_STATUS_HEADER) {
                        numeric = val.parse::<u32>().ok();
                    } else if key.eq_ignore_ascii_case(GRPC_MESSAGE_HEADER) {
                        message = Some(val.to_owned());
                    }
                }
            }
            let num = numeric?;
            if num == 0 {
                return Some(Ok(()));
            }
            let code = ErrorCode::from_grpc_code(num).unwrap_or(ErrorCode::Unknown);
            return Some(Err((code, message)));
        }
        offset = frame_end;
    }
    None
}

/// Strips a leading `/` from a procedure path (`"/pkg.Svc/Method"` ->
/// `"pkg.Svc/Method"`).
pub(crate) fn parse_procedure(procedure: &str) -> (&str, Option<&str>) {
    match procedure.strip_prefix('/') {
        Some(trimmed) if !trimmed.is_empty() => (trimmed, Some(trimmed)),
        Some(trimmed) => (trimmed, None),
        None => (procedure, None),
    }
}

/// Extracts `(server.address, server.port)` from an optional [`Uri`] authority
/// or the `Host` header.
pub(crate) fn parse_server_address(
    uri: Option<&Uri>,
    headers: &HeaderMap,
) -> (Option<String>, Option<i64>) {
    if let Some(authority) = uri.and_then(Uri::authority) {
        let host = authority
            .host()
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .unwrap_or_else(|| authority.host());
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

fn split_host_port(raw: &str) -> (Option<String>, Option<i64>) {
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
    fn http_status_and_server_fault_match_go_o11yconnect() {
        let cases = [
            (ErrorCode::Canceled, 499, "CANCELED", false),
            (ErrorCode::Unknown, 500, "UNKNOWN", true),
            (ErrorCode::InvalidArgument, 400, "INVALID_ARGUMENT", false),
            (ErrorCode::DeadlineExceeded, 504, "DEADLINE_EXCEEDED", true),
            (ErrorCode::NotFound, 404, "NOT_FOUND", false),
            (ErrorCode::AlreadyExists, 409, "ALREADY_EXISTS", false),
            (ErrorCode::PermissionDenied, 403, "PERMISSION_DENIED", false),
            (
                ErrorCode::ResourceExhausted,
                429,
                "RESOURCE_EXHAUSTED",
                false,
            ),
            (
                ErrorCode::FailedPrecondition,
                400,
                "FAILED_PRECONDITION",
                false,
            ),
            (ErrorCode::Aborted, 409, "ABORTED", false),
            (ErrorCode::OutOfRange, 400, "OUT_OF_RANGE", false),
            (ErrorCode::Unimplemented, 501, "UNIMPLEMENTED", true),
            (ErrorCode::Internal, 500, "INTERNAL", true),
            (ErrorCode::Unavailable, 503, "UNAVAILABLE", true),
            (ErrorCode::DataLoss, 500, "DATA_LOSS", true),
            (ErrorCode::Unauthenticated, 401, "UNAUTHENTICATED", false),
        ];
        for (code, status, name, fault) in cases {
            assert_eq!(http_status_for_code(code), status, "{code:?}");
            assert_eq!(canonical_code(code), name, "{code:?}");
            assert_eq!(is_server_fault(code), fault, "{code:?}");
        }
    }

    #[test]
    fn rpc_system_maps_protocols() {
        assert_eq!(rpc_system(Some(Protocol::Connect)), "connectrpc");
        assert_eq!(rpc_system(Some(Protocol::Grpc)), "grpc");
        assert_eq!(rpc_system(Some(Protocol::GrpcWeb)), "grpc");
        assert_eq!(rpc_system(None), "connectrpc");
    }

    #[test]
    fn parses_connect_error_json_end_stream_and_grpc_web_trailers() {
        let json = br#"{"code":"not_found","message":"no such item"}"#;
        assert_eq!(
            parse_connect_error_json(json),
            Some((ErrorCode::NotFound, Some("no such item".to_owned())))
        );

        let end_payload = br#"{"error":{"code":"internal","message":"boom"}}"#;
        let mut frame = Vec::new();
        frame.push(CONNECT_END_STREAM_FLAG);
        frame.extend_from_slice(&(u32::try_from(end_payload.len()).expect("len")).to_be_bytes());
        frame.extend_from_slice(end_payload);
        assert_eq!(
            parse_connect_end_stream_error(&frame),
            Some((ErrorCode::Internal, Some("boom".to_owned())))
        );

        let trailer_text = b"grpc-status: 5\r\ngrpc-message: gone\r\n";
        let mut gw = Vec::new();
        gw.push(GRPC_WEB_TRAILER_FLAG);
        gw.extend_from_slice(&(u32::try_from(trailer_text.len()).expect("len")).to_be_bytes());
        gw.extend_from_slice(trailer_text);
        assert_eq!(
            parse_grpc_web_trailer_status(&gw),
            Some(Err((ErrorCode::NotFound, Some("gone".to_owned()))))
        );
    }
}
