//! `reqwest-middleware` client instrumentation for [`libo11y`].
//!
//! [`O11yMiddleware`] binds explicitly to a [`libo11y::Sdk`] handle without
//! relying on process globals, injects W3C Trace Context and Baggage headers
//! via `sdk.propagator()`, emits OpenTelemetry HTTP semantic conventions 1.41.0
//! client spans, and records `http.client.request.duration` histograms through
//! the SDK's exemplar-aware meter.
//!
//! ```
//! use libo11y::{Environment, Sdk};
//! use libo11y_reqwest::O11yMiddleware;
//! use reqwest_middleware::ClientBuilder;
//!
//! let sdk = Sdk::builder()
//!     .service_name("checkout")
//!     .environment(Environment::Test)
//!     .without_otel_env()
//!     .build()?;
//!
//! let client = ClientBuilder::new(reqwest::Client::new())
//!     .with(O11yMiddleware::new(&sdk).with_ignore_paths(["/healthz"]))
//!     .build();
//! # let _ = client;
//! # Ok::<(), libo11y::Error>(())
//! ```

use std::fmt;
use std::sync::Arc;
use std::time::Instant;

use http::Extensions;
use libo11y::Sdk;
use libo11y_http::{
    HTTP_DURATION_BOUNDARIES, HeaderInjector, normalize_method, path_match, redact_query,
    span_method, strip_ipv6_brackets,
};
use opentelemetry::context::FutureExt as _;
use opentelemetry::metrics::Histogram;
use opentelemetry::propagation::TextMapPropagator as _;
use opentelemetry::trace::{SpanBuilder, SpanKind, Status, TraceContextExt as _, Tracer as _};
use opentelemetry::{Context as OtelContext, KeyValue};
use reqwest::{Request, Response, Url};
use reqwest_middleware::{Error as MiddlewareError, Middleware, Next, Result as MiddlewareResult};

/// Instrumentation scope name for tracers and meters created by
/// `libo11y-reqwest`.
pub const SCOPE_NAME: &str = "libo11y-reqwest";

type RequestFilter = Arc<dyn Fn(&Request) -> bool + Send + Sync>;

#[derive(Clone)]
struct MiddlewareConfig {
    sdk: Sdk,
    duration: Histogram<f64>,
    filters: Vec<RequestFilter>,
}

impl MiddlewareConfig {
    fn allowed(&self, req: &Request) -> bool {
        self.filters.iter().all(|filter| filter(req))
    }
}

/// [`reqwest_middleware::Middleware`] that instruments outbound `reqwest`
/// requests with [`libo11y`] traces, W3C propagation, and exemplar-linked
/// `http.client.request.duration` metrics.
#[derive(Clone)]
pub struct O11yMiddleware {
    config: Arc<MiddlewareConfig>,
}

impl fmt::Debug for O11yMiddleware {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("O11yMiddleware")
            .field("filters", &self.config.filters.len())
            .finish_non_exhaustive()
    }
}

impl O11yMiddleware {
    /// Creates a new `reqwest-middleware` instrumentation bound explicitly to
    /// `sdk`.
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
            config: Arc::new(MiddlewareConfig {
                sdk: sdk.clone(),
                duration,
                filters: Vec::new(),
            }),
        }
    }

    /// Excludes outbound requests whose URL path matches any of `patterns` in
    /// Go's `path.Match` glob syntax (for example `"/healthz"` or
    /// `"/debug/*"`). Malformed patterns never match.
    #[must_use]
    pub fn with_ignore_paths<I, S>(mut self, patterns: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let patterns: Vec<String> = patterns.into_iter().map(Into::into).collect();
        Arc::make_mut(&mut self.config)
            .filters
            .push(Arc::new(move |req: &Request| {
                let path = req.url().path();
                !patterns.iter().any(|pat| path_match(pat, path))
            }));
        self
    }

    /// Adds a predicate that must return `true` for an outbound request to be
    /// instrumented. Repeatable; all filters must pass.
    #[must_use]
    pub fn with_filter<F>(mut self, predicate: F) -> Self
    where
        F: Fn(&Request) -> bool + Send + Sync + 'static,
    {
        Arc::make_mut(&mut self.config)
            .filters
            .push(Arc::new(predicate));
        self
    }
}

#[async_trait::async_trait]
impl Middleware for O11yMiddleware {
    async fn handle(
        &self,
        mut req: Request,
        extensions: &mut Extensions,
        next: Next<'_>,
    ) -> MiddlewareResult<Response> {
        if !self.config.allowed(&req) {
            return next.run(req, extensions).await;
        }

        let start = Instant::now();
        let raw_method = req.method().as_str().to_owned();
        let (method_normalized, method_exact) = normalize_method(&raw_method);
        let span_name = span_method(method_normalized).to_owned();
        let url_full = sanitize_reqwest_url(req.url());
        let server_address = req
            .url()
            .host_str()
            .map(|h| strip_ipv6_brackets(h).to_owned())
            .filter(|h| !h.is_empty());
        let server_port = req.url().port_or_known_default().map(i64::from);

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
            .inject_context(&active_cx, &mut HeaderInjector(req.headers_mut()));

        let mut guard = SpanGuard {
            config: Arc::clone(&self.config),
            cx: active_cx.clone(),
            start,
            method_normalized,
            server_address,
            server_port,
            finished: false,
        };

        let result = next.run(req, extensions).with_context(active_cx).await;
        match &result {
            Ok(resp) => guard.finish_response(resp),
            Err(err) => guard.finish_error(err),
        }
        result
    }
}

struct SpanGuard {
    config: Arc<MiddlewareConfig>,
    cx: OtelContext,
    start: Instant,
    method_normalized: &'static str,
    server_address: Option<String>,
    server_port: Option<i64>,
    finished: bool,
}

impl SpanGuard {
    fn finish_response(&mut self, resp: &Response) {
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
            let _attached = self.cx.clone().attach();
            self.record_duration(elapsed, Some(status), error_type.as_deref());
        }
        span.end();
    }

    fn finish_error(&mut self, err: &MiddlewareError) {
        if self.finished {
            return;
        }
        self.finished = true;
        let error_type = classify_error(err);
        let span = self.cx.span();
        span.set_attribute(KeyValue::new("error.type", error_type));
        span.set_status(Status::error(error_type));

        let elapsed = self.start.elapsed().as_secs_f64();
        {
            let _attached = self.cx.clone().attach();
            self.record_duration(elapsed, None, Some(error_type));
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

impl Drop for SpanGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.finished = true;
            if std::thread::panicking() {
                let span = self.cx.span();
                span.set_attribute(KeyValue::new("error.type", "panic"));
                span.set_status(Status::error("panic"));
                let elapsed = self.start.elapsed().as_secs_f64();
                let _attached = self.cx.clone().attach();
                self.record_duration(elapsed, None, Some("panic"));
            }
            self.cx.span().end();
        }
    }
}

fn sanitize_reqwest_url(url: &Url) -> String {
    let mut clean = url.clone();
    let _ = clean.set_username("");
    let _ = clean.set_password(None);
    if let Some(query) = clean.query() {
        let redacted = redact_query(query);
        clean.set_query(Some(&redacted));
    }
    clean.into()
}

fn classify_error(err: &MiddlewareError) -> &'static str {
    match err {
        MiddlewareError::Middleware(_) => "middleware",
        MiddlewareError::Reqwest(inner) => {
            if inner.is_timeout() {
                "timeout"
            } else if inner.is_connect() {
                "connect"
            } else if inner.is_redirect() {
                "redirect"
            } else if inner.is_decode() {
                "decode"
            } else if inner.is_body() {
                "body"
            } else if inner.is_builder() {
                "builder"
            } else if inner.is_status() {
                "status"
            } else {
                "request"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_reqwest_url_strips_userinfo_and_redacts_query() {
        let url = Url::parse("https://alice:secret@example.com:8443/v1/items?page=1&token=tok")
            .expect("valid url");
        assert_eq!(
            sanitize_reqwest_url(&url),
            "https://example.com:8443/v1/items?page=1&token=REDACTED"
        );
    }
}
