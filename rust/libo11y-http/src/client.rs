//! Tower HTTP client instrumentation layer ([`ClientLayer`]) and service
//! ([`ClientService`]).

use std::fmt;
use std::future::Future;
use std::marker::PhantomData;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use http::request::Parts;
use http::{Request, Response};
use libo11y::Sdk;
use opentelemetry::metrics::Histogram;
use opentelemetry::propagation::TextMapPropagator as _;
use opentelemetry::trace::{SpanBuilder, SpanKind, Status, TraceContextExt as _, Tracer as _};
use opentelemetry::{Context as OtelContext, KeyValue};
use pin_project_lite::pin_project;
use tower_layer::Layer;
use tower_service::Service;

use crate::carrier::HeaderInjector;
use crate::method::{normalize_method, span_method};
use crate::path_match::path_match;
use crate::url::{extract_scheme, extract_server_address_port, sanitize_url_full};
use crate::{HTTP_DURATION_BOUNDARIES, SCOPE_NAME};

type RequestFilter = Arc<dyn Fn(&Parts) -> bool + Send + Sync>;

/// Shared configuration cloned cheaply into each [`ClientService`].
#[derive(Clone)]
struct ClientConfig {
    sdk: Sdk,
    duration: Histogram<f64>,
    filters: Vec<RequestFilter>,
}

impl ClientConfig {
    fn allowed(&self, parts: &Parts) -> bool {
        self.filters.iter().all(|filter| filter(parts))
    }
}

/// Tower [`Layer`] that instruments outbound HTTP clients with W3C trace
/// context and baggage injection, `SpanKind::Client` spans, and
/// `http.client.request.duration` histograms (with exemplars).
#[derive(Clone)]
pub struct ClientLayer {
    config: Arc<ClientConfig>,
}

impl fmt::Debug for ClientLayer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientLayer")
            .field("filters", &self.config.filters.len())
            .finish_non_exhaustive()
    }
}

impl ClientLayer {
    /// Creates a new client instrumentation layer bound explicitly to `sdk`.
    #[must_use]
    pub fn new(sdk: &Sdk) -> Self {
        let duration = sdk
            .meter(SCOPE_NAME)
            .f64_histogram("http.client.request.duration")
            .with_unit("s")
            .with_description("Duration of HTTP client requests.")
            .with_boundaries(HTTP_DURATION_BOUNDARIES.to_vec())
            .build();
        Self {
            config: Arc::new(ClientConfig {
                sdk: sdk.clone(),
                duration,
                filters: Vec::new(),
            }),
        }
    }

    /// Excludes outbound requests whose URL path matches any of `patterns` in
    /// Go's `path.Match` glob syntax. Malformed patterns never match.
    #[must_use]
    pub fn with_ignore_paths<I, S>(mut self, patterns: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let patterns: Vec<String> = patterns.into_iter().map(Into::into).collect();
        Arc::make_mut(&mut self.config)
            .filters
            .push(Arc::new(move |parts: &Parts| {
                let path = parts.uri.path();
                !patterns.iter().any(|pat| path_match(pat, path))
            }));
        self
    }

    /// Adds a predicate that must return `true` for an outbound request to be
    /// instrumented. Repeatable; all filters must pass.
    #[must_use]
    pub fn with_filter<F>(mut self, predicate: F) -> Self
    where
        F: Fn(&Parts) -> bool + Send + Sync + 'static,
    {
        Arc::make_mut(&mut self.config)
            .filters
            .push(Arc::new(predicate));
        self
    }
}

impl<S> Layer<S> for ClientLayer {
    type Service = ClientService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ClientService {
            inner,
            config: Arc::clone(&self.config),
        }
    }
}

/// Tower [`Service`] produced by [`ClientLayer`].
#[derive(Clone)]
pub struct ClientService<S> {
    inner: S,
    config: Arc<ClientConfig>,
}

impl<S: fmt::Debug> fmt::Debug for ClientService<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientService")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for ClientService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
{
    type Response = Response<ResBody>;
    type Error = S::Error;
    type Future = ClientFuture<S::Future, ResBody, S::Error>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let (mut parts, body) = req.into_parts();
        if !self.config.allowed(&parts) {
            return ClientFuture::passthrough(self.inner.call(Request::from_parts(parts, body)));
        }

        let start = Instant::now();
        let raw_method = parts.method.as_str().to_owned();
        let (method_normalized, method_exact) = normalize_method(&raw_method);
        let span_name = span_method(method_normalized).to_owned();
        let url_full = sanitize_url_full(&parts.uri);
        let scheme = extract_scheme(&parts);
        let (server_address, server_port) = extract_server_address_port(&parts, &scheme);

        let mut attrs = Vec::with_capacity(5);
        attrs.push(KeyValue::new("http.request.method", method_normalized));
        if !method_exact {
            attrs.push(KeyValue::new("http.request.method_original", raw_method));
        }
        attrs.push(KeyValue::new("url.full", url_full));
        if let Some(addr) = &server_address {
            attrs.push(KeyValue::new("server.address", addr.clone()));
        }
        if let Some(port) = server_port {
            attrs.push(KeyValue::new("server.port", port));
        }

        let parent_cx = OtelContext::current();
        let span_builder = SpanBuilder::from_name(span_name)
            .with_kind(SpanKind::Client)
            .with_attributes(attrs);
        let span = self
            .config
            .sdk
            .tracer(SCOPE_NAME)
            .build_with_context(span_builder, &parent_cx);
        let active_cx = parent_cx.with_span(span);

        self.config
            .sdk
            .propagator()
            .inject_context(&active_cx, &mut HeaderInjector(&mut parts.headers));

        let mut state = ClientState {
            config: Arc::clone(&self.config),
            cx: active_cx,
            start,
            method_normalized,
            server_address,
            server_port,
            finished: false,
        };

        let req = Request::from_parts(parts, body);
        let call_result = {
            let _guard = state.cx.clone().attach();
            catch_unwind(AssertUnwindSafe(|| self.inner.call(req)))
        };
        match call_result {
            Ok(future) => ClientFuture::instrumented(future, state),
            Err(payload) => {
                state.finish_panic();
                resume_unwind(payload);
            }
        }
    }
}

struct ClientState {
    config: Arc<ClientConfig>,
    cx: OtelContext,
    start: Instant,
    method_normalized: &'static str,
    server_address: Option<String>,
    server_port: Option<i64>,
    finished: bool,
}

impl ClientState {
    fn finish_response<ResBody>(&mut self, resp: &Response<ResBody>) {
        if self.finished {
            return;
        }
        self.finished = true;
        let status_u16 = resp.status().as_u16();
        let status = i64::from(status_u16);
        let error_type = (status_u16 >= 400).then(|| status_u16.to_string());

        let span = self.cx.span();
        span.set_attribute(KeyValue::new("http.response.status_code", status));
        if let Some(et) = &error_type {
            span.set_attribute(KeyValue::new("error.type", et.clone()));
            span.set_status(Status::error(""));
        }

        let elapsed = self.start.elapsed().as_secs_f64();
        {
            let _guard = self.cx.clone().attach();
            self.record_duration(elapsed, Some(status), error_type.as_deref());
        }
        span.end();
    }

    fn finish_error(&mut self, error_type: &'static str) {
        if self.finished {
            return;
        }
        self.finished = true;
        let span = self.cx.span();
        span.set_attribute(KeyValue::new("error.type", error_type));
        span.set_status(Status::error(error_type));

        let elapsed = self.start.elapsed().as_secs_f64();
        {
            let _guard = self.cx.clone().attach();
            self.record_duration(elapsed, None, Some(error_type));
        }
        span.end();
    }

    fn finish_panic(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        let span = self.cx.span();
        span.set_attribute(KeyValue::new("error.type", "panic"));
        span.set_status(Status::error("panic"));

        let elapsed = self.start.elapsed().as_secs_f64();
        {
            let _guard = self.cx.clone().attach();
            self.record_duration(elapsed, None, Some("panic"));
        }
        span.end();
    }

    fn record_duration(&self, elapsed_secs: f64, status: Option<i64>, error_type: Option<&str>) {
        let mut attrs = Vec::with_capacity(5);
        attrs.push(KeyValue::new("http.request.method", self.method_normalized));
        if let Some(addr) = &self.server_address {
            attrs.push(KeyValue::new("server.address", addr.clone()));
        }
        if let Some(port) = self.server_port {
            attrs.push(KeyValue::new("server.port", port));
        }
        if let Some(code) = status {
            attrs.push(KeyValue::new("http.response.status_code", code));
        }
        if let Some(et) = error_type {
            attrs.push(KeyValue::new("error.type", et.to_owned()));
        }
        self.config.duration.record(elapsed_secs, &attrs);
    }
}

impl Drop for ClientState {
    fn drop(&mut self) {
        if !self.finished {
            if std::thread::panicking() {
                self.finish_panic();
            } else {
                self.finished = true;
                self.cx.span().end();
            }
        }
    }
}

pin_project! {
    /// Response future returned by [`ClientService`].
    pub struct ClientFuture<F, ResBody, E> {
        #[pin]
        inner: ClientFutureInner<F>,
        _marker: PhantomData<fn() -> Result<Response<ResBody>, E>>,
    }
}

pin_project! {
    #[project = ClientFutureProj]
    enum ClientFutureInner<F> {
        Passthrough {
            #[pin]
            future: F,
        },
        Instrumented {
            #[pin]
            future: F,
            state: Option<ClientState>,
        },
    }
}

impl<F, ResBody, E> ClientFuture<F, ResBody, E> {
    fn passthrough(future: F) -> Self {
        Self {
            inner: ClientFutureInner::Passthrough { future },
            _marker: PhantomData,
        }
    }

    fn instrumented(future: F, state: ClientState) -> Self {
        Self {
            inner: ClientFutureInner::Instrumented {
                future,
                state: Some(state),
            },
            _marker: PhantomData,
        }
    }
}

impl<F, ResBody, E> Future for ClientFuture<F, ResBody, E>
where
    F: Future<Output = Result<Response<ResBody>, E>>,
{
    type Output = Result<Response<ResBody>, E>;

    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        match self.project().inner.project() {
            ClientFutureProj::Passthrough { future } => future.poll(cx),
            ClientFutureProj::Instrumented { future, state } => {
                let Some(active_cx) = state.as_ref().map(|s| s.cx.clone()) else {
                    return future.poll(cx);
                };
                let poll_result = {
                    let _guard = active_cx.attach();
                    catch_unwind(AssertUnwindSafe(|| future.poll(cx)))
                };
                match poll_result {
                    Ok(Poll::Pending) => Poll::Pending,
                    Ok(Poll::Ready(Ok(resp))) => {
                        if let Some(mut st) = state.take() {
                            st.finish_response(&resp);
                        }
                        Poll::Ready(Ok(resp))
                    }
                    Ok(Poll::Ready(Err(err))) => {
                        if let Some(mut st) = state.take() {
                            st.finish_error(std::any::type_name::<E>());
                        }
                        Poll::Ready(Err(err))
                    }
                    Err(payload) => {
                        if let Some(mut st) = state.take() {
                            st.finish_panic();
                        }
                        resume_unwind(payload);
                    }
                }
            }
        }
    }
}
