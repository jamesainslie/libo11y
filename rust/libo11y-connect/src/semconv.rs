//! OpenTelemetry RPC semantic conventions (v1.41.0), Connect/gRPC protocol
//! helpers, incremental envelope parsing, and W3C header propagation adapters
//! for `libo11y-connect`.

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

/// Maximum payload size buffered for a Connect unary error body or a single
/// terminal envelope frame (`0x02` Connect end-of-stream or `0x80` gRPC-Web
/// trailers). Non-terminal message frames are skipped without buffering.
pub(crate) const MAX_INSPECT_BYTES: usize = 16 * 1024;

/// Header/trailer carrying the numeric gRPC status code.
const GRPC_STATUS_HEADER: &str = "grpc-status";
/// Header/trailer carrying the percent-encoded gRPC status message.
const GRPC_MESSAGE_HEADER: &str = "grpc-message";

/// Connect streaming end-of-stream envelope flag bit.
const CONNECT_END_STREAM_FLAG: u8 = 0x02;
/// Envelope compression flag bit.
const ENVELOPE_COMPRESSED_FLAG: u8 = 0x01;
/// gRPC-Web trailer envelope flag bit.
const GRPC_WEB_TRAILER_FLAG: u8 = 0x80;
/// Size of a Connect/gRPC envelope header (1 flag byte + 4-byte BE length).
const ENVELOPE_HEADER_LEN: usize = 5;

/// Parsed status outcome from a terminal Connect / gRPC / gRPC-Web signal:
/// `Ok(())` for success, `Err((code, message))` for an RPC error.
pub(crate) type RpcStatusOutcome = Result<(), (ErrorCode, Option<String>)>;

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
/// [`ErrorCode`] when the JSON body does not specify one, per the Connect
/// protocol's HTTP-to-error-code table: every status it does not list, such
/// as 409, 499 or 501, reads `Unknown`.
pub(crate) const fn error_code_from_http_status(status: StatusCode) -> Option<ErrorCode> {
    match status.as_u16() {
        200 | 304 => None,
        400 => Some(ErrorCode::Internal),
        401 => Some(ErrorCode::Unauthenticated),
        403 => Some(ErrorCode::PermissionDenied),
        404 => Some(ErrorCode::Unimplemented),
        429 | 502 | 503 | 504 => Some(ErrorCode::Unavailable),
        _ => Some(ErrorCode::Unknown),
    }
}

/// The value for `rpc.method`, and the server span name, of a procedure the
/// server does not implement, so unrouted paths cannot create unbounded
/// series.
pub(crate) const RPC_METHOD_OTHER: &str = "_OTHER";

/// HTTP methods the semantic conventions name; any other reads `_OTHER`.
const KNOWN_HTTP_METHODS: &[&str] = &[
    "CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE",
];

/// Normalizes an HTTP request method for `http.request.method`: a known
/// method in any case reads in uppercase, and any other reads `_OTHER`.
pub(crate) fn normalize_http_method(method: &str) -> &'static str {
    KNOWN_HTTP_METHODS
        .iter()
        .find(|known| method.eq_ignore_ascii_case(known))
        .copied()
        .unwrap_or("_OTHER")
}

/// Parses a gRPC status code and percent-decoded `grpc-message` from HTTP
/// headers or trailers.
pub(crate) fn parse_grpc_status_headers(headers: &HeaderMap) -> Option<RpcStatusOutcome> {
    let raw = headers.get(GRPC_STATUS_HEADER)?.to_str().ok()?.trim();
    let numeric = raw.parse::<u32>().ok()?;
    if numeric == 0 {
        return Some(Ok(()));
    }
    let code = ErrorCode::from_grpc_code(numeric).unwrap_or(ErrorCode::Unknown);
    let message = headers
        .get(GRPC_MESSAGE_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(percent_decode);
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

/// Parses the JSON payload of a Connect streaming `END_STREAM` (`0x02`) frame.
///
/// Returns `Some(Ok(()))` for a valid JSON object without an `"error"` object
/// (for example `{}` or `{"metadata": {...}}`), `Some(Err((code, msg)))` when
/// `"error"` is present, or `None` if the payload is not a valid JSON object.
pub(crate) fn parse_connect_end_stream_payload(payload: &[u8]) -> Option<RpcStatusOutcome> {
    let val: serde_json::Value = serde_json::from_slice(payload).ok()?;
    let obj = val.as_object()?;
    let Some(err_val) = obj.get("error").filter(|v| !v.is_null()) else {
        return Some(Ok(()));
    };
    let err_obj = err_val.as_object()?;
    let code = err_obj
        .get("code")
        .and_then(serde_json::Value::as_str)
        .and_then(|s| s.parse::<ErrorCode>().ok())
        .unwrap_or(ErrorCode::Unknown);
    let message = err_obj
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    Some(Err((code, message)))
}

/// Parses the ASCII header-block payload of a gRPC-Web trailer (`0x80`) frame.
pub(crate) fn parse_grpc_web_trailer_payload(payload: &[u8]) -> Option<RpcStatusOutcome> {
    let text = std::str::from_utf8(payload).ok()?;
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
                message = Some(percent_decode(val));
            }
        }
    }
    let num = numeric?;
    if num == 0 {
        return Some(Ok(()));
    }
    let code = ErrorCode::from_grpc_code(num).unwrap_or(ErrorCode::Unknown);
    Some(Err((code, message)))
}

/// Which envelope framing protocol [`EnvelopeInspector`] scans.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EnvelopeKind {
    /// Connect streaming (`application/connect+*`): terminal frame flag `0x02`.
    ConnectStream,
    /// gRPC-Web (`application/grpc-web*`): terminal trailer frame flag `0x80`.
    GrpcWeb,
}

impl EnvelopeKind {
    const fn is_terminal(self, flags: u8) -> bool {
        match self {
            Self::ConnectStream => flags & CONNECT_END_STREAM_FLAG != 0,
            Self::GrpcWeb => flags & GRPC_WEB_TRAILER_FLAG != 0,
        }
    }
}

enum EnvelopeState {
    Header {
        buf: [u8; ENVELOPE_HEADER_LEN],
        filled: usize,
    },
    Skip {
        remaining: usize,
    },
    Capture {
        remaining: usize,
        buf: Vec<u8>,
    },
    Done,
}

/// Incremental 5-byte envelope frame state machine for Connect streaming and
/// gRPC-Web responses.
///
/// Non-terminal message frames (of any size) are skipped by decrementing a
/// remaining-bytes counter without allocating or buffering payload bytes.
/// Only the single uncompressed terminal frame (`0x02` or `0x80`, up to
/// [`MAX_INSPECT_BYTES`]) is buffered and parsed.
pub(crate) struct EnvelopeInspector {
    kind: EnvelopeKind,
    state: EnvelopeState,
    outcome: Option<RpcStatusOutcome>,
}

impl EnvelopeInspector {
    pub(crate) const fn new(kind: EnvelopeKind) -> Self {
        Self {
            kind,
            state: EnvelopeState::Header {
                buf: [0; ENVELOPE_HEADER_LEN],
                filled: 0,
            },
            outcome: None,
        }
    }

    /// Feeds the next slice of response body bytes into the state machine.
    pub(crate) fn feed(&mut self, mut bytes: &[u8]) {
        while !bytes.is_empty() {
            match &mut self.state {
                EnvelopeState::Done => return,
                EnvelopeState::Header { buf, filled } => {
                    let need = ENVELOPE_HEADER_LEN - *filled;
                    let take = bytes.len().min(need);
                    buf[*filled..*filled + take].copy_from_slice(&bytes[..take]);
                    *filled += take;
                    bytes = &bytes[take..];

                    if *filled == ENVELOPE_HEADER_LEN {
                        let flags = buf[0];
                        let len = u32::from_be_bytes([buf[1], buf[2], buf[3], buf[4]]) as usize;
                        let is_terminal = self.kind.is_terminal(flags);
                        let is_uncompressed = flags & ENVELOPE_COMPRESSED_FLAG == 0;

                        if is_terminal && is_uncompressed && len <= MAX_INSPECT_BYTES {
                            if len == 0 {
                                self.finish_terminal(&[]);
                            } else {
                                self.state = EnvelopeState::Capture {
                                    remaining: len,
                                    buf: Vec::with_capacity(len.min(1024)),
                                };
                            }
                        } else if len == 0 {
                            *filled = 0;
                        } else {
                            self.state = EnvelopeState::Skip { remaining: len };
                        }
                    }
                }
                EnvelopeState::Skip { remaining } => {
                    let take = bytes.len().min(*remaining);
                    *remaining -= take;
                    bytes = &bytes[take..];
                    if *remaining == 0 {
                        self.state = EnvelopeState::Header {
                            buf: [0; ENVELOPE_HEADER_LEN],
                            filled: 0,
                        };
                    }
                }
                EnvelopeState::Capture { remaining, buf } => {
                    let take = bytes.len().min(*remaining);
                    buf.extend_from_slice(&bytes[..take]);
                    *remaining -= take;
                    bytes = &bytes[take..];
                    if *remaining == 0 {
                        let payload = std::mem::take(buf);
                        self.finish_terminal(&payload);
                    }
                }
            }
        }
    }

    fn finish_terminal(&mut self, payload: &[u8]) {
        self.outcome = match self.kind {
            EnvelopeKind::ConnectStream => parse_connect_end_stream_payload(payload),
            EnvelopeKind::GrpcWeb => parse_grpc_web_trailer_payload(payload),
        };
        self.state = EnvelopeState::Done;
    }

    /// Returns the parsed terminal status outcome once a terminal frame has
    /// been decoded.
    pub(crate) fn outcome(&self) -> Option<&RpcStatusOutcome> {
        self.outcome.as_ref()
    }
}

/// Percent-decodes a `grpc-message` header or trailer value without panicking
/// on malformed escape sequences.
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

    fn push_frame(out: &mut Vec<u8>, flags: u8, payload: &[u8]) {
        out.push(flags);
        out.extend_from_slice(&(u32::try_from(payload.len()).expect("len")).to_be_bytes());
        out.extend_from_slice(payload);
    }

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
    fn http_status_fallback_follows_the_connect_protocol_table() {
        let cases = [
            (200, None),
            (304, None),
            (400, Some(ErrorCode::Internal)),
            (401, Some(ErrorCode::Unauthenticated)),
            (403, Some(ErrorCode::PermissionDenied)),
            (404, Some(ErrorCode::Unimplemented)),
            (409, Some(ErrorCode::Unknown)),
            (429, Some(ErrorCode::Unavailable)),
            (499, Some(ErrorCode::Unknown)),
            (500, Some(ErrorCode::Unknown)),
            (501, Some(ErrorCode::Unknown)),
            (502, Some(ErrorCode::Unavailable)),
            (503, Some(ErrorCode::Unavailable)),
            (504, Some(ErrorCode::Unavailable)),
            (418, Some(ErrorCode::Unknown)),
        ];
        for (status, want) in cases {
            let status = StatusCode::from_u16(status).expect("status");
            assert_eq!(error_code_from_http_status(status), want, "{status}");
        }
    }

    #[test]
    fn http_methods_normalize_to_the_bounded_set() {
        for (raw, want) in [
            ("GET", "GET"),
            ("post", "POST"),
            ("Patch", "PATCH"),
            ("PURGE", "_OTHER"),
            ("", "_OTHER"),
            ("x-random-1", "_OTHER"),
        ] {
            assert_eq!(normalize_http_method(raw), want, "{raw:?}");
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
    fn envelope_inspector_skips_large_payloads_and_parses_terminal_frames() {
        // Connect streaming: 32 KiB payload frame + terminal 0x02 error frame, fed in tiny 7-byte chunks.
        let big_payload = vec![b'a'; 32 * 1024];
        let mut wire = Vec::new();
        push_frame(&mut wire, 0x00, &big_payload);
        push_frame(
            &mut wire,
            CONNECT_END_STREAM_FLAG,
            br#"{"error":{"code":"internal","message":"boom"}}"#,
        );
        let mut inspector = EnvelopeInspector::new(EnvelopeKind::ConnectStream);
        for chunk in wire.chunks(7) {
            inspector.feed(chunk);
        }
        assert_eq!(
            inspector.outcome(),
            Some(&Err((ErrorCode::Internal, Some("boom".to_owned()))))
        );

        // Connect streaming: successful 0x02 {} frame yields Some(Ok(())).
        let mut ok_wire = Vec::new();
        push_frame(&mut ok_wire, 0x00, b"msg");
        push_frame(&mut ok_wire, CONNECT_END_STREAM_FLAG, b"{}");
        let mut ok_insp = EnvelopeInspector::new(EnvelopeKind::ConnectStream);
        ok_insp.feed(&ok_wire);
        assert_eq!(ok_insp.outcome(), Some(&Ok(())));

        // gRPC-Web: 32 KiB payload frame + 0x80 trailer frame with percent-encoded grpc-message.
        let mut gw_wire = Vec::new();
        push_frame(&mut gw_wire, 0x00, &big_payload);
        push_frame(
            &mut gw_wire,
            GRPC_WEB_TRAILER_FLAG,
            b"grpc-status: 5\r\ngrpc-message: item%20not%20found\r\n",
        );
        let mut gw_insp = EnvelopeInspector::new(EnvelopeKind::GrpcWeb);
        for chunk in gw_wire.chunks(13) {
            gw_insp.feed(chunk);
        }
        assert_eq!(
            gw_insp.outcome(),
            Some(&Err((
                ErrorCode::NotFound,
                Some("item not found".to_owned())
            )))
        );
    }

    #[test]
    fn parse_grpc_status_headers_percent_decodes_message() {
        let mut headers = HeaderMap::new();
        headers.insert("grpc-status", HeaderValue::from_static("5"));
        headers.insert("grpc-message", HeaderValue::from_static("missing%20id%3D7"));
        assert_eq!(
            parse_grpc_status_headers(&headers),
            Some(Err((ErrorCode::NotFound, Some("missing id=7".to_owned()))))
        );
    }

    #[test]
    fn parses_connect_unary_error_json() {
        let json = br#"{"code":"not_found","message":"no such item"}"#;
        assert_eq!(
            parse_connect_error_json(json),
            Some((ErrorCode::NotFound, Some("no such item".to_owned())))
        );
    }
}
