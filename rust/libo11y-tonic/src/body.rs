//! Instrumented response future and HTTP/2 body wrappers that keep the
//! OpenTelemetry span context active across polling and capture `grpc-status`
//! from headers or response trailers.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use http::{Response, StatusCode};
use http_body::{Body, Frame, SizeHint};
use opentelemetry::metrics::Histogram;
use opentelemetry::trace::{Status as SpanStatus, TraceContextExt as _};
use opentelemetry::{Context, KeyValue};
use pin_project_lite::pin_project;

use crate::error::status_from_error;
use crate::semconv::{
    CODE_CANCELLED, CODE_INTERNAL, CODE_UNIMPLEMENTED, ERROR_TYPE, GrpcStatus, RPC_METHOD,
    RPC_METHOD_OTHER, RPC_RESPONSE_STATUS_CODE, is_client_error, is_server_error,
};

/// Which side of the RPC this call represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CallRole {
    Server,
    Client,
}

impl CallRole {
    const fn is_error(self, code: i32) -> bool {
        match self {
            Self::Server => is_server_error(code),
            Self::Client => is_client_error(code),
        }
    }
}

struct RpcStateInner {
    cx: Context,
    duration: Histogram<f64>,
    metric_attrs: Vec<KeyValue>,
    start: Instant,
    role: CallRole,
    observed_status: Option<GrpcStatus>,
    http_status: Option<StatusCode>,
    seen_end_stream: bool,
}

impl RpcStateInner {
    fn finish(mut self, status: GrpcStatus) {
        let code_str = status.canonical_name();
        let is_err = self.role.is_error(status.code);

        let status_kv = KeyValue::new(RPC_RESPONSE_STATUS_CODE, code_str.clone());
        let span = self.cx.span();
        if self.role == CallRole::Server {
            if status.code == CODE_UNIMPLEMENTED {
                // The path named no method the server routes, so it is the
                // caller's text: a scanner's random paths must not each
                // become a span name and a metric series.
                span.update_name(RPC_METHOD_OTHER);
                self.metric_attrs.retain(|kv| kv.key.as_str() != RPC_METHOD);
                self.metric_attrs
                    .push(KeyValue::new(RPC_METHOD, RPC_METHOD_OTHER));
            }
            // A server span gets `rpc.method` only now, once the status says
            // whether the method exists: the SDK appends a repeated key
            // rather than replacing it.
            if let Some(method) = self
                .metric_attrs
                .iter()
                .find(|kv| kv.key.as_str() == RPC_METHOD)
            {
                span.set_attribute(method.clone());
            }
        }
        span.set_attribute(status_kv.clone());
        self.metric_attrs.push(status_kv);

        if is_err {
            let err_desc = status
                .message
                .unwrap_or_else(|| code_str.clone().into_owned());
            span.set_status(SpanStatus::error(err_desc));
            let err_kv = KeyValue::new(ERROR_TYPE, code_str);
            span.set_attribute(err_kv.clone());
            self.metric_attrs.push(err_kv);
        }

        let elapsed = self.start.elapsed().as_secs_f64();
        // Attach the span context before recording so libo11y's exemplar
        // filter observes the active sampled span.
        {
            let _guard = self.cx.clone().attach();
            self.duration.record(elapsed, &self.metric_attrs);
        }
        span.end();
    }

    fn finish_panic(self) {
        self.finish(GrpcStatus::with_message(CODE_INTERNAL, "panic"));
    }

    fn finish_on_drop(mut self) {
        if std::thread::panicking() {
            self.finish_panic();
            return;
        }
        if let Some(status) = self.observed_status.take() {
            self.finish(status);
            return;
        }
        if self.seen_end_stream {
            let status = self
                .http_status
                .map_or_else(missing_status, GrpcStatus::from_http_status);
            self.finish(status);
            return;
        }
        self.finish(GrpcStatus::new(CODE_CANCELLED));
    }
}

/// The status of a call whose stream ended with no `grpc-status` and no
/// response head to map: nothing says it succeeded.
fn missing_status() -> GrpcStatus {
    GrpcStatus::from_http_status(StatusCode::OK)
}

/// Per-RPC telemetry state carried from request start through response body
/// completion (or drop / panic). Dropping an unfinished `RpcState` finalizes
/// the span and records the duration metric automatically, including on
/// synchronous panics inside `Service::call`.
pub(crate) struct RpcState {
    inner: Option<RpcStateInner>,
}

impl RpcState {
    pub(crate) fn new(
        cx: Context,
        duration: Histogram<f64>,
        metric_attrs: Vec<KeyValue>,
        start: Instant,
        role: CallRole,
    ) -> Self {
        Self {
            inner: Some(RpcStateInner {
                cx,
                duration,
                metric_attrs,
                start,
                role,
                observed_status: None,
                http_status: None,
                seen_end_stream: false,
            }),
        }
    }

    fn cx(&self) -> Option<&Context> {
        self.inner.as_ref().map(|i| &i.cx)
    }

    fn set_http_status(&mut self, status: StatusCode) {
        if let Some(inner) = self.inner.as_mut() {
            inner.http_status = Some(status);
        }
    }

    fn set_observed_status(&mut self, status: GrpcStatus) {
        if let Some(inner) = self.inner.as_mut() {
            inner.observed_status = Some(status);
        }
    }

    fn finish_from_stream_end(&mut self) {
        if let Some(mut inner) = self.inner.take() {
            inner.seen_end_stream = true;
            let status = inner
                .observed_status
                .take()
                .or_else(|| inner.http_status.map(GrpcStatus::from_http_status))
                .unwrap_or_else(missing_status);
            inner.finish(status);
        }
    }

    /// Finishes the call as failed by `err`, with the status it stands for.
    fn finish_error<E: fmt::Display + 'static>(&mut self, err: &E) {
        if let Some(inner) = self.inner.take() {
            inner.finish(status_from_error(err));
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
    /// HTTP/2 response body wrapper that polls the inner body inside the RPC's
    /// OpenTelemetry context and records `grpc-status` from response trailers
    /// when the stream finishes.
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
    B::Error: fmt::Display + 'static,
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
                if let Some(state) = this.state.as_mut()
                    && let Some(trailers) = frame.trailers_ref()
                    && let Some(status) = GrpcStatus::from_headers(trailers)
                {
                    state.set_observed_status(status);
                }
                if this.inner.is_end_stream()
                    && let Some(mut state) = this.state.take()
                {
                    state.finish_from_stream_end();
                }
            }
            Some(Err(err)) => {
                if let Some(mut state) = this.state.take() {
                    state.finish_error(err);
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
    /// Filtered-out RPC: propagate context without creating a span or metric.
    Passthrough(Context),
    /// Instrumented RPC: active span and metric state.
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
    pub(crate) fn passthrough(inner: F, cx: Context) -> Self {
        Self {
            inner,
            state: FutureState::Passthrough(cx),
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
    E: fmt::Display + 'static,
{
    type Output = Result<Response<InstrumentedBody<ResBody>>, E>;

    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        let this = self.project();

        let poll_result = match this.state {
            FutureState::Passthrough(otel_cx) => {
                let _guard = otel_cx.clone().attach();
                this.inner.poll(cx)
            }
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
            FutureState::Passthrough(_) => {
                Poll::Ready(result.map(|resp| resp.map(InstrumentedBody::passthrough)))
            }
            FutureState::Instrumented(slot) => match result {
                Ok(response) => {
                    let Some(mut state) = slot.take() else {
                        return Poll::Ready(Ok(response.map(InstrumentedBody::passthrough)));
                    };
                    state.set_http_status(response.status());
                    if let Some(header_status) = GrpcStatus::from_headers(response.headers()) {
                        state.set_observed_status(header_status);
                    }
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
                        state.finish_error(&err);
                    }
                    Poll::Ready(Err(err))
                }
            },
        }
    }
}
