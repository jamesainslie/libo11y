//! Instrumented HTTP response future and body wrappers for `libo11y-connect`
//! Tower layers and [`InstrumentedTransport`](crate::InstrumentedTransport).

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use bytes::Buf as _;
use connectrpc::{ErrorCode, Protocol};
use http::{Response, StatusCode};
use http_body::{Body, Frame, SizeHint};
use libo11y::{Record, Sdk};
use opentelemetry::metrics::Histogram;
use opentelemetry::trace::{Status as SpanStatus, TraceContextExt as _};
use opentelemetry::{Context, KeyValue};
use pin_project_lite::pin_project;

use crate::canonical::{CanonicalSummary, emit_canonical_line};
use crate::semconv::{
    ERROR_TYPE, HTTP_RESPONSE_STATUS_CODE, RPC_RESPONSE_STATUS_CODE, STATUS_CODE_OK,
    canonical_code, error_code_from_http_status, is_server_fault, parse_connect_end_stream_error,
    parse_connect_error_json, parse_grpc_status_headers, parse_grpc_web_trailer_status,
};

/// Maximum number of response body bytes buffered for extracting Connect JSON
/// error codes or streaming end-of-stream / gRPC-Web trailer frames.
const MAX_INSPECT_BYTES: usize = 16 * 1024;

/// Which side of the RPC is being instrumented.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallRole {
    Server,
    Client,
}

impl CallRole {
    const fn marks_span_error(self, code: ErrorCode) -> bool {
        match self {
            Self::Server => is_server_fault(code),
            Self::Client => true,
        }
    }
}

pub(crate) struct CanonicalState {
    pub(crate) sdk: Sdk,
    pub(crate) record: Record,
    pub(crate) procedure: String,
    pub(crate) http_method: String,
}

struct RpcStateInner {
    cx: Context,
    duration: Histogram<f64>,
    metric_attrs: Vec<KeyValue>,
    start: Instant,
    role: CallRole,
    protocol: Option<Protocol>,
    is_unary: bool,
    http_status: Option<StatusCode>,
    observed_grpc: Option<Result<(), (ErrorCode, Option<String>)>>,
    inspect_buf: Vec<u8>,
    inspect_overflow: bool,
    canonical: Option<CanonicalState>,
    seen_end_stream: bool,
}

impl RpcStateInner {
    fn inspect_chunk(&mut self, chunk: &[u8]) {
        if self.inspect_overflow {
            return;
        }
        let should_buffer = match self.protocol {
            Some(Protocol::Connect) | None => {
                if self.is_unary {
                    // Only buffer Connect unary responses when HTTP status indicates an error.
                    self.http_status
                        .is_some_and(|s| s != StatusCode::OK && s != StatusCode::NOT_MODIFIED)
                } else {
                    true
                }
            }
            Some(Protocol::GrpcWeb) => true,
            Some(_) => false,
        };
        if !should_buffer {
            return;
        }
        if self.inspect_buf.len().saturating_add(chunk.len()) <= MAX_INSPECT_BYTES {
            self.inspect_buf.extend_from_slice(chunk);
        } else {
            self.inspect_overflow = true;
            self.inspect_buf.clear();
        }
    }

    fn resolve_error(&self) -> Option<(ErrorCode, Option<String>)> {
        // 1. Explicit gRPC status from HTTP headers or HTTP/2 trailers.
        if let Some(grpc_res) = &self.observed_grpc {
            return match grpc_res {
                Ok(()) => None,
                Err(err) => Some(err.clone()),
            };
        }

        // 2. Protocol-specific body inspection.
        match self.protocol {
            Some(Protocol::GrpcWeb) => {
                if let Some(res) = parse_grpc_web_trailer_status(&self.inspect_buf) {
                    return res.err();
                }
            }
            Some(Protocol::Connect) | None => {
                if self.is_unary {
                    if let Some(status) = self.http_status
                        && status != StatusCode::OK
                        && status != StatusCode::NOT_MODIFIED
                    {
                        if let Some(parsed) = parse_connect_error_json(&self.inspect_buf) {
                            return Some(parsed);
                        }
                        if let Some(code) = error_code_from_http_status(status) {
                            return Some((code, None));
                        }
                    }
                    return None;
                }
                if let Some(parsed) = parse_connect_end_stream_error(&self.inspect_buf) {
                    return Some(parsed);
                }
            }
            Some(_) => {}
        }

        // 3. Fallback on non-200 HTTP status.
        self.http_status
            .and_then(error_code_from_http_status)
            .map(|c| (c, None))
    }

    fn finish(
        mut self,
        error: Option<(ErrorCode, Option<String>)>,
        transport_error: Option<String>,
        panicked: bool,
    ) {
        let http_status_u16 = if panicked {
            500
        } else {
            self.http_status.map_or(200, |s| s.as_u16())
        };

        let span = self.cx.span();
        if self.http_status.is_some() || panicked {
            span.set_attribute(KeyValue::new(
                HTTP_RESPONSE_STATUS_CODE,
                i64::from(http_status_u16),
            ));
        }

        let (rpc_code, is_err, err_desc) = if panicked {
            ("INTERNAL", true, Some("panic".to_owned()))
        } else if let Some(transport_msg) = transport_error {
            let code = error.as_ref().map_or(ErrorCode::Unavailable, |(c, _)| *c);
            (canonical_code(code), true, Some(transport_msg))
        } else if let Some((code, msg)) = error.as_ref() {
            let name = canonical_code(*code);
            (
                name,
                self.role.marks_span_error(*code),
                msg.clone().or_else(|| Some(name.to_owned())),
            )
        } else {
            (STATUS_CODE_OK, false, None)
        };

        let status_kv = KeyValue::new(RPC_RESPONSE_STATUS_CODE, rpc_code);
        span.set_attribute(status_kv.clone());
        self.metric_attrs.push(status_kv);

        if panicked || error.is_some() || is_err {
            let err_kv = KeyValue::new(ERROR_TYPE, rpc_code);
            span.set_attribute(err_kv.clone());
            self.metric_attrs.push(err_kv);
        }
        if is_err {
            span.set_status(SpanStatus::error(
                err_desc.unwrap_or_else(|| rpc_code.to_owned()),
            ));
        }

        let elapsed = self.start.elapsed().as_secs_f64();
        {
            let _guard = self.cx.clone().attach();
            if let Some(canonical) = self.canonical.take() {
                emit_canonical_line(
                    &self.cx,
                    &canonical.sdk,
                    &canonical.record,
                    &CanonicalSummary {
                        procedure: &canonical.procedure,
                        protocol: self.protocol,
                        http_method: &canonical.http_method,
                        http_status: Some(http_status_u16),
                        is_unary: self.is_unary,
                        start: self.start,
                        error_code: error.map(|(c, _)| c),
                        panicked,
                    },
                );
            }
            self.duration.record(elapsed, &self.metric_attrs);
        }
        span.end();
    }

    fn finish_on_drop(self) {
        if std::thread::panicking() {
            self.finish(
                Some((ErrorCode::Internal, Some("panic".to_owned()))),
                None,
                true,
            );
            return;
        }
        if self.seen_end_stream || self.observed_grpc.is_some() {
            let err = self.resolve_error();
            self.finish(err, None, false);
            return;
        }
        // Clients may stop polling as soon as a terminal gRPC-Web trailer
        // frame, Connect end-of-stream frame, or Connect unary JSON error body
        // has been decoded, dropping the body before a trailing `None` poll.
        match self.protocol {
            Some(Protocol::GrpcWeb) => {
                if let Some(res) = parse_grpc_web_trailer_status(&self.inspect_buf) {
                    self.finish(res.err(), None, false);
                    return;
                }
            }
            Some(Protocol::Connect) | None => {
                if self.is_unary {
                    if let Some(status) = self.http_status
                        && status != StatusCode::OK
                        && status != StatusCode::NOT_MODIFIED
                        && let Some(err) = parse_connect_error_json(&self.inspect_buf)
                    {
                        self.finish(Some(err), None, false);
                        return;
                    }
                } else if let Some(err) = parse_connect_end_stream_error(&self.inspect_buf) {
                    self.finish(Some(err), None, false);
                    return;
                }
            }
            Some(_) => {}
        }
        self.finish(Some((ErrorCode::Canceled, None)), None, false);
    }
}

/// Per-RPC telemetry state guarded by `Drop` so panics and cancellations
/// always finalize spans, metrics, and canonical lines cleanly.
pub(crate) struct RpcState {
    inner: Option<Box<RpcStateInner>>,
}

impl RpcState {
    #[allow(
        clippy::too_many_arguments,
        reason = "internal per-RPC constructor grouping span, metric, and canonical state"
    )]
    pub(crate) fn new(
        cx: Context,
        duration: Histogram<f64>,
        metric_attrs: Vec<KeyValue>,
        start: Instant,
        role: CallRole,
        protocol: Option<Protocol>,
        is_unary: bool,
        canonical: Option<CanonicalState>,
    ) -> Self {
        Self {
            inner: Some(Box::new(RpcStateInner {
                cx,
                duration,
                metric_attrs,
                start,
                role,
                protocol,
                is_unary,
                http_status: None,
                observed_grpc: None,
                inspect_buf: Vec::new(),
                inspect_overflow: false,
                canonical,
                seen_end_stream: false,
            })),
        }
    }

    pub(crate) fn cx(&self) -> Option<&Context> {
        self.inner.as_ref().map(|i| &i.cx)
    }

    pub(crate) fn set_http_status(&mut self, status: StatusCode) {
        if let Some(inner) = self.inner.as_mut() {
            inner.http_status = Some(status);
        }
    }

    pub(crate) fn inspect_headers(&mut self, headers: &http::HeaderMap) {
        if let Some(inner) = self.inner.as_mut()
            && let Some(res) = parse_grpc_status_headers(headers)
        {
            inner.observed_grpc = Some(res);
        }
    }

    fn inspect_data(&mut self, chunk: &[u8]) {
        if let Some(inner) = self.inner.as_mut() {
            inner.inspect_chunk(chunk);
        }
    }

    pub(crate) fn finish_from_stream_end(&mut self) {
        if let Some(mut inner) = self.inner.take() {
            inner.seen_end_stream = true;
            let err = inner.resolve_error();
            inner.finish(err, None, false);
        }
    }

    pub(crate) fn finish_transport_error(&mut self, msg: String) {
        if let Some(inner) = self.inner.take() {
            inner.finish(
                Some((ErrorCode::Unavailable, Some(msg.clone()))),
                Some(msg),
                false,
            );
        }
    }
}

impl Drop for RpcState {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.take() {
            inner.finish_on_drop();
        }
    }
}

pin_project! {
    /// HTTP response body wrapper that polls inside the RPC's OpenTelemetry
    /// context and extracts Connect, gRPC, or gRPC-Web status codes when the
    /// response stream finishes.
    pub struct InstrumentedBody<B> {
        #[pin]
        inner: B,
        state: Option<RpcState>,
    }
}

impl<B> fmt::Debug for InstrumentedBody<B>
where
    B: fmt::Debug,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InstrumentedBody")
            .field("inner", &self.inner)
            .field("instrumented", &self.state.is_some())
            .finish()
    }
}

impl<B> InstrumentedBody<B> {
    pub(crate) fn passthrough(inner: B) -> Self {
        Self { inner, state: None }
    }

    pub(crate) fn instrumented(inner: B, state: RpcState) -> Self {
        Self {
            inner,
            state: Some(state),
        }
    }
}

impl<B> Body for InstrumentedBody<B>
where
    B: Body,
    B::Error: fmt::Display,
{
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let mut this = self.project();
        let poll_result = if let Some(otel_cx) = this.state.as_ref().and_then(RpcState::cx) {
            let _guard = otel_cx.clone().attach();
            this.inner.as_mut().poll_frame(cx)
        } else {
            this.inner.as_mut().poll_frame(cx)
        };

        let Poll::Ready(item) = poll_result else {
            return Poll::Pending;
        };

        match &item {
            Some(Ok(frame)) => {
                if let Some(state) = this.state.as_mut() {
                    if let Some(data) = frame.data_ref() {
                        state.inspect_data(data.chunk());
                    }
                    if let Some(trailers) = frame.trailers_ref() {
                        state.inspect_headers(trailers);
                    }
                }
                if this.inner.is_end_stream()
                    && let Some(mut state) = this.state.take()
                {
                    state.finish_from_stream_end();
                }
            }
            Some(Err(err)) => {
                if let Some(mut state) = this.state.take() {
                    state.finish_transport_error(err.to_string());
                }
            }
            None => {
                if let Some(mut state) = this.state.take() {
                    state.finish_from_stream_end();
                }
            }
        }

        Poll::Ready(item)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

pub(crate) enum FutureState {
    Passthrough,
    Instrumented(Option<RpcState>),
}

pin_project! {
    /// Future returned by [`ServerService`](crate::ServerService) and
    /// [`ClientService`](crate::ClientService).
    pub struct ResponseFuture<F> {
        #[pin]
        inner: F,
        state: FutureState,
    }
}

impl<F> fmt::Debug for ResponseFuture<F> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResponseFuture").finish_non_exhaustive()
    }
}

impl<F> ResponseFuture<F> {
    pub(crate) fn passthrough(inner: F) -> Self {
        Self {
            inner,
            state: FutureState::Passthrough,
        }
    }

    pub(crate) fn instrumented(inner: F, state: RpcState) -> Self {
        Self {
            inner,
            state: FutureState::Instrumented(Some(state)),
        }
    }
}

impl<F, ResBody, E> Future for ResponseFuture<F>
where
    F: Future<Output = Result<Response<ResBody>, E>>,
    ResBody: Body,
    E: fmt::Display,
{
    type Output = Result<Response<InstrumentedBody<ResBody>>, E>;

    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        let this = self.project();

        let poll_result = match this.state {
            FutureState::Passthrough | FutureState::Instrumented(None) => this.inner.poll(cx),
            FutureState::Instrumented(Some(state)) => {
                if let Some(otel_cx) = state.cx() {
                    let _guard = otel_cx.clone().attach();
                    this.inner.poll(cx)
                } else {
                    this.inner.poll(cx)
                }
            }
        };

        let Poll::Ready(result) = poll_result else {
            return Poll::Pending;
        };

        match this.state {
            FutureState::Passthrough => {
                Poll::Ready(result.map(|resp| resp.map(InstrumentedBody::passthrough)))
            }
            FutureState::Instrumented(slot) => match result {
                Ok(response) => {
                    let Some(mut state) = slot.take() else {
                        return Poll::Ready(Ok(response.map(InstrumentedBody::passthrough)));
                    };
                    state.set_http_status(response.status());
                    state.inspect_headers(response.headers());
                    if response.body().is_end_stream() {
                        state.finish_from_stream_end();
                        Poll::Ready(Ok(response.map(InstrumentedBody::passthrough)))
                    } else {
                        Poll::Ready(Ok(
                            response.map(|body| InstrumentedBody::instrumented(body, state))
                        ))
                    }
                }
                Err(err) => {
                    if let Some(mut state) = slot.take() {
                        state.finish_transport_error(err.to_string());
                    }
                    Poll::Ready(Err(err))
                }
            },
        }
    }
}
