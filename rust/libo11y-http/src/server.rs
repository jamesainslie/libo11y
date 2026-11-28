//! Tower HTTP server instrumentation layer ([`ServerLayer`]) and service
//! ([`ServerService`]).

use std::fmt;
use std::future::Future;
use std::marker::PhantomData;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use http::header::USER_AGENT;
use http::request::Parts;
use http::{Request, Response};
use libo11y::{Record, Sdk, start_record};
use libo11y_spec::{Outcome, attr, event};
use opentelemetry::baggage::BaggageExt as _;
use opentelemetry::metrics::Histogram;
use opentelemetry::propagation::TextMapPropagator as _;
use opentelemetry::trace::{
    Link, SpanBuilder, SpanKind, Status, TraceContextExt as _, Tracer as _,
};
use opentelemetry::{Context as OtelContext, KeyValue};
use pin_project_lite::pin_project;
use tower_layer::Layer;
use tower_service::Service;

use crate::carrier::HeaderExtractor;
use crate::method::{default_span_name, normalize_method, route_only};
use crate::path_match::path_match;
use crate::url::{
    extract_scheme, extract_server_address_port, percent_decode_or_raw, redact_query,
};
use crate::{HTTP_DURATION_BOUNDARIES, SCOPE_NAME};

type RequestFilter = Arc<dyn Fn(&Parts) -> bool + Send + Sync>;
type RouteExtractor = Arc<dyn Fn(&Parts) -> Option<String> + Send + Sync>;

/// Shared configuration cloned cheaply into each [`ServerService`].
#[derive(Clone)]
struct ServerConfig {
    sdk: Sdk,
    duration: Histogram<f64>,
    public_endpoint: bool,
    canonical_line: bool,
    operation_name: Option<String>,
    filters: Vec<RequestFilter>,
    route_extractor: Option<RouteExtractor>,
}

impl ServerConfig {
    fn allowed(&self, parts: &Parts) -> bool {
        self.filters.iter().all(|filter| filter(parts))
    }

    fn extract_route(&self, parts: &Parts) -> Option<String> {
        if let Some(extractor) = &self.route_extractor
            && let Some(route) = extractor(parts)
            && !route.is_empty()
        {
            return Some(route);
        }
        #[cfg(feature = "axum")]
        if let Some(matched) = parts.extensions.get::<axum::extract::MatchedPath>() {
            let route = matched.as_str();
            if !route.is_empty() {
                return Some(route.to_owned());
            }
        }
        None
    }
}

/// Tower [`Layer`] that instruments HTTP servers with OpenTelemetry traces,
/// `http.server.request.duration` histograms (with exemplars), W3C context
/// extraction, panic recording, and optional `o11y.request.summary` canonical
/// log lines.
#[derive(Clone)]
pub struct ServerLayer {
    config: Arc<ServerConfig>,
}

impl fmt::Debug for ServerLayer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerLayer")
            .field("public_endpoint", &self.config.public_endpoint)
            .field("canonical_line", &self.config.canonical_line)
            .field("operation_name", &self.config.operation_name)
            .field("filters", &self.config.filters.len())
            .field(
                "has_route_extractor",
                &self.config.route_extractor.is_some(),
            )
            .finish_non_exhaustive()
    }
}

impl ServerLayer {
    /// Creates a new server instrumentation layer bound explicitly to `sdk`.
    #[must_use]
    pub fn new(sdk: &Sdk) -> Self {
        let duration = sdk
            .meter(SCOPE_NAME)
            .f64_histogram("http.server.request.duration")
            .with_unit("s")
            .with_description("Duration of HTTP server requests.")
            .with_boundaries(HTTP_DURATION_BOUNDARIES.to_vec())
            .build();
        Self {
            config: Arc::new(ServerConfig {
                sdk: sdk.clone(),
                duration,
                public_endpoint: false,
                canonical_line: false,
                operation_name: None,
                filters: Vec::new(),
                route_extractor: None,
            }),
        }
    }

    /// Marks the server as internet-facing: inbound baggage is still adopted,
    /// but each request starts a new root trace with a span link (no link
    /// attributes) to any valid remote inbound span context.
    #[must_use]
    pub fn with_public_endpoint(mut self) -> Self {
        Arc::make_mut(&mut self.config).public_endpoint = true;
        self
    }

    /// Excludes requests whose URL path matches any of `patterns` in Go's
    /// `path.Match` glob syntax (for example `"/healthz"` or `"/debug/*"`).
    /// The path is percent-decoded before matching, as Go's `r.URL.Path` is,
    /// so `/%68ealthz` matches `"/healthz"`; a path with an invalid escape or
    /// invalid UTF-8 is matched raw. Malformed patterns never match.
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
                let path = percent_decode_or_raw(parts.uri.path());
                !patterns.iter().any(|pat| path_match(pat, &path))
            }));
        self
    }

    /// Adds a predicate that must return `true` for a request to be traced,
    /// measured, and summarized. Repeatable; all filters must pass.
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

    /// Emits one `o11y.request.summary` canonical log line per instrumented
    /// request (including on panic), enriched with any attributes the handler
    /// adds to the request's [`Record`] via [`libo11y::record_from_context`].
    #[must_use]
    pub fn with_canonical_line(mut self) -> Self {
        Arc::make_mut(&mut self.config).canonical_line = true;
        self
    }

    /// Configures a custom route template extractor. When it returns `Some`
    /// with a non-empty string, that route is used for span naming and
    /// `http.route`; otherwise, with the `axum` feature enabled,
    /// `axum::extract::MatchedPath` is checked automatically.
    #[must_use]
    pub fn with_route_extractor<F>(mut self, extractor: F) -> Self
    where
        F: Fn(&Parts) -> Option<String> + Send + Sync + 'static,
    {
        Arc::make_mut(&mut self.config).route_extractor = Some(Arc::new(extractor));
        self
    }

    /// Sets the fallback span name used when no route template matched.
    #[must_use]
    pub fn with_operation_name(mut self, name: impl Into<String>) -> Self {
        let name = name.into();
        Arc::make_mut(&mut self.config).operation_name =
            if name.is_empty() { None } else { Some(name) };
        self
    }
}

impl<S> Layer<S> for ServerLayer {
    type Service = ServerService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        ServerService {
            inner,
            config: Arc::clone(&self.config),
        }
    }
}

/// Tower [`Service`] produced by [`ServerLayer`].
#[derive(Clone)]
pub struct ServerService<S> {
    inner: S,
    config: Arc<ServerConfig>,
}

impl<S: fmt::Debug> fmt::Debug for ServerService<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerService")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for ServerService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
{
    type Response = Response<ResBody>;
    type Error = S::Error;
    type Future = ServerFuture<S::Future, ResBody, S::Error>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let (parts, body) = req.into_parts();
        if !self.config.allowed(&parts) {
            return ServerFuture::passthrough(self.inner.call(Request::from_parts(parts, body)));
        }

        let mut state = RequestState::start(&self.config, &parts);
        let req = Request::from_parts(parts, body);
        let call_result = {
            let _guard = state.cx.clone().attach();
            catch_unwind(AssertUnwindSafe(|| self.inner.call(req)))
        };
        match call_result {
            Ok(future) => ServerFuture::instrumented(future, state),
            Err(payload) => {
                state.finish_panic();
                resume_unwind(payload);
            }
        }
    }
}

struct RequestState {
    config: Arc<ServerConfig>,
    cx: OtelContext,
    start: Instant,
    method_normalized: &'static str,
    method_original: Option<String>,
    scheme: String,
    route: Option<String>,
    record: Option<Record>,
    finished: bool,
}

impl RequestState {
    fn start(config: &Arc<ServerConfig>, parts: &Parts) -> Self {
        let start = Instant::now();
        let raw_method = parts.method.as_str().to_owned();
        let (method_normalized, method_exact) = normalize_method(&raw_method);
        let method_original = if method_exact { None } else { Some(raw_method) };
        let route_pattern = config.extract_route(parts);
        let route_attr = route_pattern
            .as_deref()
            .map(route_only)
            .filter(|r| !r.is_empty())
            .map(str::to_owned);
        let span_name = default_span_name(
            method_original.as_deref().unwrap_or(method_normalized),
            route_pattern.as_deref(),
            config.operation_name.as_deref(),
        );

        let scheme = extract_scheme(parts);
        let attrs = build_server_start_attrs(
            parts,
            method_normalized,
            method_original.as_deref(),
            &scheme,
            route_attr.as_deref(),
        );

        let extracted_cx = config
            .sdk
            .propagator()
            .extract_with_context(&OtelContext::new(), &HeaderExtractor(&parts.headers));

        let mut span_builder = SpanBuilder::from_name(span_name)
            .with_kind(SpanKind::Server)
            .with_attributes(attrs);

        let parent_cx = if config.public_endpoint {
            let remote_sc = extracted_cx.span().span_context().clone();
            if remote_sc.is_valid() && remote_sc.is_remote() {
                span_builder = span_builder.with_links(vec![Link::new(remote_sc, Vec::new(), 0)]);
            }
            let bag = extracted_cx.baggage();
            if bag.is_empty() {
                OtelContext::new()
            } else {
                let copied: opentelemetry::baggage::Baggage = bag
                    .iter()
                    .map(|(k, (v, m))| (k.clone(), (v.clone(), m.clone())))
                    .collect();
                OtelContext::new().with_baggage(copied)
            }
        } else {
            extracted_cx
        };

        let tracer = config.sdk.tracer(SCOPE_NAME);
        let span = tracer.build_with_context(span_builder, &parent_cx);
        let active_cx = parent_cx.with_span(span);

        let (active_cx, record) = if config.canonical_line {
            let (rec_cx, rec) = start_record(&active_cx);
            (rec_cx, Some(rec))
        } else {
            (active_cx, None)
        };

        Self {
            config: Arc::clone(config),
            cx: active_cx,
            start,
            method_normalized,
            method_original,
            scheme,
            route: route_attr,
            record,
            finished: false,
        }
    }
    fn finish_response<ResBody>(&mut self, resp: &Response<ResBody>) {
        if self.finished {
            return;
        }
        self.finished = true;
        let status_u16 = resp.status().as_u16();
        let status = i64::from(status_u16);
        let error_type = (status_u16 >= 500).then(|| status_u16.to_string());

        let span = self.cx.span();
        span.set_attribute(KeyValue::new("http.response.status_code", status));
        if let Some(et) = &error_type {
            span.set_attribute(KeyValue::new("error.type", et.clone()));
            span.set_status(Status::error(""));
        }

        let elapsed = self.start.elapsed().as_secs_f64();
        let outcome = if status_u16 >= 500 {
            Outcome::Failure
        } else {
            Outcome::Success
        };
        {
            let _guard = self.cx.clone().attach();
            self.record_duration(elapsed, Some(status), error_type.as_deref());
            self.emit_canonical(status, outcome, elapsed);
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
            self.emit_canonical(500, Outcome::Failure, elapsed);
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
            self.emit_canonical(500, Outcome::Failure, elapsed);
        }
        span.end();
    }

    fn record_duration(&self, elapsed_secs: f64, status: Option<i64>, error_type: Option<&str>) {
        let mut attrs = Vec::with_capacity(5);
        attrs.push(KeyValue::new("http.request.method", self.method_normalized));
        attrs.push(KeyValue::new("url.scheme", self.scheme.clone()));
        if let Some(route) = &self.route {
            attrs.push(KeyValue::new("http.route", route.clone()));
        }
        if let Some(code) = status {
            attrs.push(KeyValue::new("http.response.status_code", code));
        }
        if let Some(et) = error_type {
            attrs.push(KeyValue::new("error.type", et.to_owned()));
        }
        self.config.duration.record(elapsed_secs, &attrs);
    }

    fn emit_canonical(&self, status: i64, outcome: Outcome, elapsed_secs: f64) {
        let Some(record) = &self.record else {
            return;
        };
        let mut attrs = Vec::with_capacity(6);
        attrs.push(KeyValue::new("http.request.method", self.method_normalized));
        if let Some(orig) = &self.method_original {
            attrs.push(KeyValue::new("http.request.method_original", orig.clone()));
        }
        attrs.push(KeyValue::new("http.response.status_code", status));
        attrs.push(KeyValue::new(attr::OUTCOME, outcome.as_str()));
        attrs.push(KeyValue::new(attr::DURATION, elapsed_secs));
        if let Some(route) = &self.route {
            attrs.push(KeyValue::new("http.route", route.clone()));
        }
        record.emit_event_in_context(&self.cx, &self.config.sdk, event::REQUEST_SUMMARY, attrs);
    }
}

fn build_server_start_attrs(
    parts: &Parts,
    method_normalized: &'static str,
    method_original: Option<&str>,
    scheme: &str,
    route: Option<&str>,
) -> Vec<KeyValue> {
    let mut attrs = Vec::with_capacity(9);
    attrs.push(KeyValue::new("http.request.method", method_normalized));
    if let Some(orig) = method_original {
        attrs.push(KeyValue::new(
            "http.request.method_original",
            orig.to_owned(),
        ));
    }
    attrs.push(KeyValue::new("url.scheme", scheme.to_owned()));
    attrs.push(KeyValue::new("url.path", parts.uri.path().to_owned()));
    if let Some(query) = parts.uri.query().filter(|q| !q.is_empty()) {
        attrs.push(KeyValue::new("url.query", redact_query(query)));
    }
    if let Some(route) = route {
        attrs.push(KeyValue::new("http.route", route.to_owned()));
    }
    if let Some(ua) = parts
        .headers
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
    {
        attrs.push(KeyValue::new("user_agent.original", ua.to_owned()));
    }
    let (server_address, server_port) = extract_server_address_port(parts, scheme);
    if let Some(addr) = server_address {
        attrs.push(KeyValue::new("server.address", addr));
    }
    if let Some(port) = server_port {
        attrs.push(KeyValue::new("server.port", port));
    }
    attrs
}

impl Drop for RequestState {
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
    /// Response future returned by [`ServerService`].
    pub struct ServerFuture<F, ResBody, E> {
        #[pin]
        inner: ServerFutureInner<F>,
        _marker: PhantomData<fn() -> Result<Response<ResBody>, E>>,
    }
}

pin_project! {
    #[project = ServerFutureProj]
    enum ServerFutureInner<F> {
        Passthrough {
            #[pin]
            future: F,
        },
        Instrumented {
            #[pin]
            future: F,
            state: Option<RequestState>,
        },
    }
}

impl<F, ResBody, E> ServerFuture<F, ResBody, E> {
    fn passthrough(future: F) -> Self {
        Self {
            inner: ServerFutureInner::Passthrough { future },
            _marker: PhantomData,
        }
    }

    fn instrumented(future: F, state: RequestState) -> Self {
        Self {
            inner: ServerFutureInner::Instrumented {
                future,
                state: Some(state),
            },
            _marker: PhantomData,
        }
    }
}

impl<F, ResBody, E> Future for ServerFuture<F, ResBody, E>
where
    F: Future<Output = Result<Response<ResBody>, E>>,
{
    type Output = Result<Response<ResBody>, E>;

    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        match self.project().inner.project() {
            ServerFutureProj::Passthrough { future } => future.poll(cx),
            ServerFutureProj::Instrumented { future, state } => {
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
