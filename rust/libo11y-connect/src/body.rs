//! Instrumented HTTP response future and body wrappers for `libo11y-connect`
//! Tower layers and [`InstrumentedTransport`](crate::InstrumentedTransport).

use std::fmt;
use std::future::Future;
use std::io::IoSlice;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use bytes::Buf;
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
    ERROR_TYPE, EnvelopeInspector, EnvelopeKind, HTTP_RESPONSE_STATUS_CODE, MAX_INSPECT_BYTES,
    RPC_RESPONSE_STATUS_CODE, RpcStatusOutcome, STATUS_CODE_OK, canonical_code,
    error_code_from_http_status, is_server_fault, parse_connect_error_json,
    parse_grpc_status_headers,
};

/// Maximum number of vectored `IoSlice` slots allocated when inspecting a
/// heavily segmented [`Buf`] without consuming it.
const MAX_VECTORED_CHUNKS: usize = 1024;

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

enum BodyInspector {
    /// Body bytes do not carry protocol status (e.g., gRPC HTTP/2 trailers or
    /// Connect unary 200/304).
    None,
    /// Connect unary non-200/non-304 response carrying a small JSON error body.
    ConnectUnaryError { buf: Vec<u8>, overflow: bool },
    /// Connect streaming (`0x02`) or gRPC-Web (`0x80`) incremental frame scanner.
    Envelope(EnvelopeInspector),
}

impl BodyInspector {
    fn for_response(protocol: Option<Protocol>, is_unary: bool, status: StatusCode) -> Self {
        match protocol {
            Some(Protocol::GrpcWeb) => {
                Self::Envelope(EnvelopeInspector::new(EnvelopeKind::GrpcWeb))
            }
            Some(Protocol::Connect) | None => {
                if is_unary {
                    if status != StatusCode::OK && status != StatusCode::NOT_MODIFIED {
                        Self::ConnectUnaryError {
                            buf: Vec::new(),
                            overflow: false,
                        }
                    } else {
                        Self::None
                    }
                } else {
                    Self::Envelope(EnvelopeInspector::new(EnvelopeKind::ConnectStream))
                }
            }
            Some(_) => Self::None,
        }
    }

    fn feed(&mut self, chunk: &[u8]) {
        match self {
            Self::None => {}
            Self::ConnectUnaryError { buf, overflow } => {
                if *overflow {
                    return;
                }
                if buf.len().saturating_add(chunk.len()) <= MAX_INSPECT_BYTES {
                    buf.extend_from_slice(chunk);
                } else {
                    *overflow = true;
                    buf.clear();
                }
            }
            Self::Envelope(inspector) => inspector.feed(chunk),
        }
    }
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
    observed_grpc: Option<RpcStatusOutcome>,
    inspector: BodyInspector,
    canonical: Option<CanonicalState>,
    seen_end_stream: bool,
}

impl RpcStateInner {
    fn resolve_error(&self) -> Option<(ErrorCode, Option<String>)> {
        // 1. Explicit gRPC status from HTTP headers or HTTP/2 trailers.
        if let Some(grpc_res) = &self.observed_grpc {
            return grpc_res.clone().err();
        }

        // 2. Protocol-specific body inspection.
        match &self.inspector {
            BodyInspector::Envelope(inspector) => {
                if let Some(outcome) = inspector.outcome() {
                    return outcome.clone().err();
                }
            }
            BodyInspector::ConnectUnaryError { buf, .. } => {
                if let Some(parsed) = parse_connect_error_json(buf) {
                    return Some(parsed);
                }
            }
            BodyInspector::None => {}
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
        let span = self.cx.span();
        if panicked {
            span.set_attribute(KeyValue::new(HTTP_RESPONSE_STATUS_CODE, 500_i64));
        } else if let Some(status) = self.http_status {
            span.set_attribute(KeyValue::new(
                HTTP_RESPONSE_STATUS_CODE,
                i64::from(status.as_u16()),
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

        if is_err {
            span.set_status(SpanStatus::error(
                err_desc.unwrap_or_else(|| rpc_code.to_owned()),
            ));
            let err_kv = KeyValue::new(ERROR_TYPE, rpc_code);
            span.set_attribute(err_kv.clone());
            self.metric_attrs.push(err_kv);
        }

        let canonical_http_status = if panicked {
            Some(500)
        } else {
            self.http_status.as_ref().map(StatusCode::as_u16)
        };

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
                        http_status: canonical_http_status,
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

    fn finish_panic(self) {
        self.finish(
            Some((ErrorCode::Internal, Some("panic".to_owned()))),
            None,
            true,
        );
    }

    fn finish_on_drop(self) {
        if std::thread::panicking() {
            self.finish_panic();
            return;
        }
        if self.seen_end_stream || self.observed_grpc.is_some() {
            let err = self.resolve_error();
            self.finish(err, None, false);
            return;
        }
        // Clients may stop polling as soon as a terminal gRPC-Web trailer
        // frame, Connect end-of-stream frame (including `{}` on success), or
        // Connect unary JSON error body has been decoded, dropping the body
        // before a trailing `None` poll.
        match &self.inspector {
            BodyInspector::Envelope(inspector) => {
                if let Some(outcome) = inspector.outcome().cloned() {
                    self.finish(outcome.err(), None, false);
                    return;
                }
            }
            BodyInspector::ConnectUnaryError { buf, .. } => {
                if let Some(err) = parse_connect_error_json(buf) {
                    self.finish(Some(err), None, false);
                    return;
                }
            }
            BodyInspector::None => {}
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
                inspector: BodyInspector::None,
                canonical,
                seen_end_stream: false,
            })),
        }
    }

    pub(crate) fn cx(&self) -> Option<&Context> {
        self.inner.as_deref().map(|i| &i.cx)
    }

    pub(crate) fn set_http_status(&mut self, status: StatusCode) {
        if let Some(inner) = self.inner.as_deref_mut() {
            inner.http_status = Some(status);
            inner.inspector = BodyInspector::for_response(inner.protocol, inner.is_unary, status);
        }
    }

    pub(crate) fn inspect_headers(&mut self, headers: &http::HeaderMap) {
        if let Some(inner) = self.inner.as_deref_mut()
            && let Some(res) = parse_grpc_status_headers(headers)
        {
            inner.observed_grpc = Some(res);
        }
    }

    fn inspect_buf<D: Buf>(&mut self, data: &D) {
        let Some(inner) = self.inner.as_deref_mut() else {
            return;
        };
        if matches!(inner.inspector, BodyInspector::None) {
            return;
        }
        let total = data.remaining();
        if total == 0 {
            return;
        }
        let first = data.chunk();
        if first.len() >= total {
            inner.inspector.feed(first);
            return;
        }
        // Segmented Buf: inspect all segments via `chunks_vectored` without
        // advancing or mutating `data`.
        let mut stack_slices = [IoSlice::new(&[]); 16];
        let count = data.chunks_vectored(&mut stack_slices);
        let covered: usize = stack_slices[..count].iter().map(|s| s.len()).sum();
        if covered >= total {
            for slice in &stack_slices[..count] {
                inner.inspector.feed(slice);
            }
            return;
        }
        let mut cap = 64;
        loop {
            let mut vec_slices = vec![IoSlice::new(&[]); cap];
            let n = data.chunks_vectored(&mut vec_slices);
            let sum: usize = vec_slices[..n].iter().map(|s| s.len()).sum();
            if sum >= total || n < cap || cap >= MAX_VECTORED_CHUNKS {
                for slice in &vec_slices[..n] {
                    inner.inspector.feed(slice);
                }
                break;
            }
            cap = (cap * 2).min(MAX_VECTORED_CHUNKS);
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

    fn finish_panic(&mut self) {
        if let Some(inner) = self.inner.take() {
            inner.finish_panic();
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

/// Stack-local guard placed around inner `poll` / `poll_frame` calls so a
/// panic is finalized *during* unwinding, even if an outer `catch_unwind`
/// catches the panic before the future or body is dropped.
struct PollPanicGuard<'a> {
    slot: &'a mut Option<RpcState>,
    disarmed: bool,
}

impl<'a> PollPanicGuard<'a> {
    fn new(slot: &'a mut Option<RpcState>) -> Self {
        Self {
            slot,
            disarmed: false,
        }
    }

    fn disarm(mut self) {
        self.disarmed = true;
    }
}

impl Drop for PollPanicGuard<'_> {
    fn drop(&mut self) {
        if !self.disarmed
            && std::thread::panicking()
            && let Some(mut state) = self.slot.take()
        {
            state.finish_panic();
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
        let poll_result = {
            let otel_cx = this.state.as_ref().and_then(RpcState::cx).cloned();
            let panic_guard = PollPanicGuard::new(this.state);
            let res = if let Some(otel_cx) = otel_cx {
                let _guard = otel_cx.attach();
                this.inner.as_mut().poll_frame(cx)
            } else {
                this.inner.as_mut().poll_frame(cx)
            };
            panic_guard.disarm();
            res
        };

        let Poll::Ready(item) = poll_result else {
            return Poll::Pending;
        };

        match &item {
            Some(Ok(frame)) => {
                if let Some(state) = this.state.as_mut() {
                    if let Some(data) = frame.data_ref() {
                        state.inspect_buf(data);
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
            FutureState::Passthrough => this.inner.poll(cx),
            FutureState::Instrumented(slot) => {
                let otel_cx = slot.as_ref().and_then(RpcState::cx).cloned();
                let panic_guard = PollPanicGuard::new(slot);
                let res = if let Some(otel_cx) = otel_cx {
                    let _guard = otel_cx.attach();
                    this.inner.poll(cx)
                } else {
                    this.inner.poll(cx)
                };
                panic_guard.disarm();
                res
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
