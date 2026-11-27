//! Canonical wide-event (`o11y.request.summary`) emission for Connect RPC
//! servers, matching `go/o11yconnect/canonical.go`.

use std::time::Instant;

use connectrpc::{ErrorCode, Protocol};
use libo11y::{Record, Sdk};
use libo11y_spec::{Outcome, attr, event};
use opentelemetry::{Context, KeyValue};

use crate::semconv::{
    HTTP_REQUEST_METHOD, HTTP_RESPONSE_STATUS_CODE, RPC_METHOD, RPC_RESPONSE_STATUS_CODE,
    RPC_SYSTEM_NAME, STATUS_CODE_OK, canonical_code, http_status_for_code, is_server_fault,
    parse_procedure, rpc_system,
};

/// Outcome metadata needed to emit one `o11y.request.summary` event.
pub(crate) struct CanonicalSummary<'a> {
    pub(crate) procedure: &'a str,
    pub(crate) protocol: Option<Protocol>,
    pub(crate) http_method: &'a str,
    pub(crate) http_status: Option<u16>,
    pub(crate) is_unary: bool,
    pub(crate) start: Instant,
    pub(crate) error_code: Option<ErrorCode>,
    pub(crate) panicked: bool,
}

/// Flushes `record` as `o11y.request.summary` correlated to `cx`.
pub(crate) fn emit_canonical_line(
    cx: &Context,
    sdk: &Sdk,
    record: &Record,
    summary: &CanonicalSummary<'_>,
) {
    let (http_status, rpc_status, outcome) = if summary.panicked {
        (500_u16, "INTERNAL", Outcome::Failure)
    } else if let Some(code) = summary.error_code {
        let rpc_code = canonical_code(code);
        let status = summary.http_status.unwrap_or_else(|| {
            if summary.is_unary && matches!(summary.protocol, Some(Protocol::Connect) | None) {
                http_status_for_code(code)
            } else {
                200
            }
        });
        let outcome = if is_server_fault(code) {
            Outcome::Failure
        } else {
            Outcome::Success
        };
        (status, rpc_code, outcome)
    } else {
        (
            summary.http_status.unwrap_or(200),
            STATUS_CODE_OK,
            Outcome::Success,
        )
    };

    let (rpc_method, _) = parse_procedure(summary.procedure);
    record.emit_event_in_context(
        cx,
        sdk,
        event::REQUEST_SUMMARY,
        [
            KeyValue::new(HTTP_REQUEST_METHOD, summary.http_method.to_owned()),
            KeyValue::new(HTTP_RESPONSE_STATUS_CODE, i64::from(http_status)),
            KeyValue::new(attr::OUTCOME, outcome.as_str()),
            KeyValue::new(attr::DURATION, summary.start.elapsed().as_secs_f64()),
            KeyValue::new(RPC_SYSTEM_NAME, rpc_system(summary.protocol)),
            KeyValue::new(RPC_METHOD, rpc_method.to_owned()),
            KeyValue::new(RPC_RESPONSE_STATUS_CODE, rpc_status),
        ],
    );
}
