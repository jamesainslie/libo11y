//! Tower HTTP server instrumentation layer ([`ServerLayer`]) and service
//! ([`ServerService`]).

use std::borrow::Cow;
use std::fmt;
use std::future::Future;
use std::marker::PhantomData;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use http::header::{CONTENT_TYPE, HeaderName, HeaderValue, USER_AGENT};
use http::request::Parts;
use http::{Request, Response};
use http_body::{Body, Frame, SizeHint};
use libo11y::{Record, Sdk, start_record};
use libo11y_spec::{Outcome, attr, event};
use opentelemetry::baggage::BaggageExt as _;
use opentelemetry::metrics::Histogram;
use opentelemetry::propagation::TextMapPropagator as _;
use opentelemetry::trace::{
    Link, SpanBuilder, SpanContext, SpanKind, Status, TraceContextExt as _, Tracer as _,
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
    server_timing: bool,
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
            .field("server_timing", &self.config.server_timing)
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
                server_timing: false,
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

    /// Adds `Server-Timing: traceparent;desc="00-<trace-id>-<span-id>-<flags>"`
    /// to HTML responses, naming the server span so a browser page
    /// instrumented with `@libo11y/web` can adopt it as the parent of its
    /// `app_load` span.
    ///
    /// An existing `Server-Timing` value set by the handler is kept, and the
    /// `traceparent` entry is appended as an additional header value after it.
    /// Only responses that declare a `Content-Type` whose media type (before
    /// any parameters, trimmed and compared case-insensitively) is `text/html`
    /// receive the header. Unlike Go's `net/http`, Rust has no automatic
    /// content sniffing, so a response with no `Content-Type` header gets no
    /// entry. Unsampled spans still get an entry carrying their trace flags;
    /// requests excluded by [`Self::with_filter`] or
    /// [`Self::with_ignore_paths`], or with no valid span context, get none.
    #[must_use]
    pub fn with_server_timing(mut self) -> Self {
        Arc::make_mut(&mut self.config).server_timing = true;
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
    ResBody: Body,
{
    type Response = Response<ServerBody<ResBody>>;
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
                state.finish(Ending::Panic);
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
    /// The response status, once the head is ready.
    status: Option<u16>,
    finished: bool,
}

/// How an instrumented request ended.
#[derive(Debug, Clone, Copy)]
enum Ending {
    /// The response completed: its body reached the end of the stream, or
    /// was dropped after the head was ready.
    Complete,
    /// The service future failed before producing a response; carries the
    /// error's type name.
    ServiceError(&'static str),
    /// The response body yielded an error; carries the error's type name.
    BodyError(&'static str),
    /// The service or the response body panicked.
    Panic,
    /// The request future was dropped before the response head was ready.
    Canceled,
}

/// `error.type` for a panic in the service or the response body.
const PANIC: &str = "panic";

/// `error.type` for a request whose future was dropped before the head.
const CANCELED: &str = "canceled";

/// Canonical-line status for a canceled request that never got a response,
/// after nginx's 499 Client Closed Request.
const CLIENT_CLOSED_REQUEST: i64 = 499;

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
            status: None,
            finished: false,
        }
    }
    /// Records what the response head tells: the status code and, when
    /// enabled for an HTML response, the `Server-Timing` traceparent header.
    fn record_head<B>(&mut self, resp: &mut Response<B>) {
        let status = resp.status().as_u16();
        self.status = Some(status);
        let span = self.cx.span();
        span.set_attribute(KeyValue::new(
            "http.response.status_code",
            i64::from(status),
        ));
        if self.config.server_timing
            && let Some(ct) = resp
                .headers()
                .get(CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
            && is_html(ct)
            && let Some(entry) = server_timing_entry(span.span_context())
            && let Ok(value) = HeaderValue::from_str(&entry)
        {
            resp.headers_mut()
                .append(HeaderName::from_static("server-timing"), value);
        }
    }

    /// Ends the span, records the duration and emits the canonical line,
    /// exactly once per request.
    fn finish(&mut self, ending: Ending) {
        if self.finished {
            return;
        }
        self.finished = true;

        let (error_type, description): (Option<Cow<'static, str>>, &'static str) = match ending {
            Ending::Complete => (
                self.status
                    .filter(|code| *code >= 500)
                    .map(|code| Cow::Owned(code.to_string())),
                "",
            ),
            Ending::ServiceError(kind) | Ending::BodyError(kind) => {
                (Some(Cow::Borrowed(kind)), kind)
            }
            Ending::Panic => (Some(Cow::Borrowed(PANIC)), PANIC),
            Ending::Canceled => (Some(Cow::Borrowed(CANCELED)), CANCELED),
        };

        let span = self.cx.span();
        if let Some(kind) = &error_type {
            span.set_attribute(KeyValue::new("error.type", kind.clone()));
            span.set_status(Status::error(description));
        }

        let status = self.status.map(i64::from);
        let canonical_status = status.unwrap_or(match ending {
            Ending::Canceled => CLIENT_CLOSED_REQUEST,
            Ending::Complete | Ending::ServiceError(_) | Ending::BodyError(_) | Ending::Panic => {
                500
            }
        });
        let outcome = if error_type.is_some() {
            Outcome::Failure
        } else {
            Outcome::Success
        };
        let elapsed = self.start.elapsed().as_secs_f64();
        {
            let _guard = self.cx.clone().attach();
            self.record_duration(elapsed, status, error_type.as_deref());
            self.emit_canonical(canonical_status, outcome, elapsed);
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
            let ending = if std::thread::panicking() {
                Ending::Panic
            } else if self.status.is_some() {
                Ending::Complete
            } else {
                Ending::Canceled
            };
            self.finish(ending);
        }
    }
}

pin_project! {
    /// Response body returned by [`ServerService`].
    ///
    /// For an instrumented request it carries the server span: the span ends,
    /// `http.server.request.duration` is recorded and the canonical line is
    /// emitted once, when the body reaches the end of the stream, yields an
    /// error, panics, or is dropped. A body that is already at the end of the
    /// stream when the response head is ready finishes the request at the
    /// head. Frames are polled inside the span's context.
    pub struct ServerBody<B> {
        #[pin]
        inner: B,
        state: Option<RequestState>,
    }
}

impl<B: fmt::Debug> fmt::Debug for ServerBody<B> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerBody")
            .field("inner", &self.inner)
            .field("instrumented", &self.state.is_some())
            .finish()
    }
}

impl<B> ServerBody<B> {
    const fn passthrough(inner: B) -> Self {
        Self { inner, state: None }
    }

    const fn instrumented(inner: B, state: RequestState) -> Self {
        Self {
            inner,
            state: Some(state),
        }
    }
}

impl<B: Body> Body for ServerBody<B> {
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let mut this = self.project();
        let Some(active_cx) = this.state.as_ref().map(|s| s.cx.clone()) else {
            return this.inner.poll_frame(cx);
        };
        let poll_result = {
            let _guard = active_cx.attach();
            catch_unwind(AssertUnwindSafe(|| this.inner.as_mut().poll_frame(cx)))
        };
        let item = match poll_result {
            Ok(Poll::Pending) => return Poll::Pending,
            Ok(Poll::Ready(item)) => item,
            Err(payload) => {
                if let Some(mut st) = this.state.take() {
                    st.finish(Ending::Panic);
                }
                resume_unwind(payload);
            }
        };
        let ending = match &item {
            Some(Ok(_)) if !this.inner.is_end_stream() => None,
            Some(Ok(_)) | None => Some(Ending::Complete),
            Some(Err(_)) => Some(Ending::BodyError(std::any::type_name::<B::Error>())),
        };
        if let Some(ending) = ending
            && let Some(mut st) = this.state.take()
        {
            st.finish(ending);
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

pin_project! {
    /// Response future returned by [`ServerService`].
    ///
    /// Dropping it before the response head is ready ends the server span
    /// with `error.type` `canceled` and records the duration.
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
    ResBody: Body,
{
    type Output = Result<Response<ServerBody<ResBody>>, E>;

    fn poll(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Self::Output> {
        match self.project().inner.project() {
            ServerFutureProj::Passthrough { future } => future
                .poll(cx)
                .map_ok(|resp| resp.map(ServerBody::passthrough)),
            ServerFutureProj::Instrumented { future, state } => {
                let Some(active_cx) = state.as_ref().map(|s| s.cx.clone()) else {
                    return future
                        .poll(cx)
                        .map_ok(|resp| resp.map(ServerBody::passthrough));
                };
                let poll_result = {
                    let _guard = active_cx.attach();
                    catch_unwind(AssertUnwindSafe(|| future.poll(cx)))
                };
                match poll_result {
                    Ok(Poll::Pending) => Poll::Pending,
                    Ok(Poll::Ready(Ok(mut resp))) => {
                        let Some(mut st) = state.take() else {
                            return Poll::Ready(Ok(resp.map(ServerBody::passthrough)));
                        };
                        st.record_head(&mut resp);
                        if resp.body().is_end_stream() {
                            st.finish(Ending::Complete);
                            Poll::Ready(Ok(resp.map(ServerBody::passthrough)))
                        } else {
                            Poll::Ready(Ok(resp.map(|body| ServerBody::instrumented(body, st))))
                        }
                    }
                    Ok(Poll::Ready(Err(err))) => {
                        if let Some(mut st) = state.take() {
                            st.finish(Ending::ServiceError(std::any::type_name::<E>()));
                        }
                        Poll::Ready(Err(err))
                    }
                    Err(payload) => {
                        if let Some(mut st) = state.take() {
                            st.finish(Ending::Panic);
                        }
                        resume_unwind(payload);
                    }
                }
            }
        }
    }
}

/// Formats the `Server-Timing` entry naming `sc`, or returns `None` when `sc`
/// is not valid. Unsampled contexts are valid and keep their flags.
fn server_timing_entry(sc: &SpanContext) -> Option<String> {
    if !sc.is_valid() {
        return None;
    }
    Some(format!(
        "traceparent;desc=\"00-{}-{}-{:02x}\"",
        sc.trace_id(),
        sc.span_id(),
        sc.trace_flags().to_u8()
    ))
}

/// Reports whether a `Content-Type` header value names `text/html`: the media
/// type before any parameters, trimmed and compared case-insensitively.
fn is_html(content_type: &str) -> bool {
    let media = content_type
        .split_once(';')
        .map_or(content_type, |(head, _)| head);
    media.trim().eq_ignore_ascii_case("text/html")
}

#[cfg(test)]
mod tests {
    use opentelemetry::trace::{SpanId, TraceFlags, TraceId, TraceState};

    use super::*;

    fn span_context(flags: TraceFlags) -> SpanContext {
        SpanContext::new(
            TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736").expect("valid trace id"),
            SpanId::from_hex("00f067aa0ba902b7").expect("valid span id"),
            flags,
            false,
            TraceState::default(),
        )
    }

    #[test]
    fn server_timing_entry_formats_valid_contexts_and_skips_invalid() {
        let cases = [
            (
                span_context(TraceFlags::SAMPLED),
                Some(
                    "traceparent;desc=\"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01\"",
                ),
            ),
            (
                span_context(TraceFlags::default()),
                Some(
                    "traceparent;desc=\"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00\"",
                ),
            ),
            (
                span_context(TraceFlags::new(0x03)),
                Some(
                    "traceparent;desc=\"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-03\"",
                ),
            ),
            (SpanContext::empty_context(), None),
        ];
        for (sc, want) in cases {
            assert_eq!(server_timing_entry(&sc).as_deref(), want);
        }
    }

    #[test]
    fn is_html_matches_text_html_media_type_only() {
        let cases = [
            ("text/html", true),
            ("text/html; charset=utf-8", true),
            ("Text/HTML; charset=utf-8", true),
            ("  text/html  ;q=1", true),
            ("application/xhtml+xml", false),
            ("text/htmlx", false),
            ("application/json", false),
            ("text/plain; charset=utf-8", false),
            ("", false),
        ];
        for (ct, want) in cases {
            assert_eq!(is_html(ct), want, "Content-Type {ct:?}");
        }
    }
}
