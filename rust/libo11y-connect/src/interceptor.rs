//! Native [`connectrpc::Interceptor`] server instrumentation matching
//! `go/o11yconnect`.

use std::fmt;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use connectrpc::interceptor::{
    Interceptor, Next, NextStream, PayloadStream, StreamRequest, StreamResponse, UnaryRequest,
    UnaryResponse,
};
use connectrpc::{ConnectError, ErrorCode, IdempotencyLevel, Payload, Protocol, RequestContext};
use futures_core::Stream;
use http::header::CONTENT_TYPE;
use libo11y::{Propagator, Record, Sdk, start_record};
use opentelemetry::baggage::{Baggage, BaggageExt as _};
use opentelemetry::metrics::Histogram;
use opentelemetry::propagation::TextMapPropagator as _;
use opentelemetry::trace::{
    FutureExt as _, Link, SpanKind, Status as SpanStatus, TraceContextExt as _, Tracer as _,
};
use opentelemetry::{Context, KeyValue};

use crate::canonical::{CanonicalSummary, emit_canonical_line};
use crate::layer::MethodFilter;
use crate::semconv::{
    DURATION_BUCKETS, ERROR_TYPE, HEALTH_PROCEDURE_PREFIX, HTTP_RESPONSE_STATUS_CODE,
    HeaderExtractor, RPC_METHOD, RPC_RESPONSE_STATUS_CODE, RPC_SYSTEM_NAME, SCOPE_NAME,
    SERVER_ADDRESS, SERVER_CALL_DURATION, SERVER_PORT, STATUS_CODE_OK, canonical_code,
    http_status_for_code, is_server_fault, parse_procedure, parse_server_address, rpc_system,
};

/// Native [`connectrpc::Interceptor`] that traces and measures inbound Connect,
/// gRPC, and gRPC-Web RPCs handled by a `connectrpc::ConnectRpcService`.
///
/// Plugs directly into `ConnectRpcService::new(router).with_interceptor(...)`.
/// Supports unary and streaming RPCs, W3C Trace Context and Baggage extraction,
/// `with_public_endpoint()`, `with_ignore_health_checks()`, `with_filter(...)`,
/// and `with_canonical_line()` (emitting `o11y.request.summary`).
#[derive(Clone)]
pub struct ServerInterceptor {
    config: Arc<InterceptorConfig>,
}

struct InterceptorConfig {
    sdk: Sdk,
    propagator: Propagator,
    duration: Histogram<f64>,
    public_endpoint: bool,
    canonical_line: bool,
    filters: Vec<MethodFilter>,
}

impl Clone for InterceptorConfig {
    fn clone(&self) -> Self {
        Self {
            sdk: self.sdk.clone(),
            propagator: self.propagator.clone(),
            duration: self.duration.clone(),
            public_endpoint: self.public_endpoint,
            canonical_line: self.canonical_line,
            filters: self.filters.clone(),
        }
    }
}

impl fmt::Debug for ServerInterceptor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerInterceptor")
            .field("public_endpoint", &self.config.public_endpoint)
            .field("canonical_line", &self.config.canonical_line)
            .field("filters", &self.config.filters.len())
            .finish_non_exhaustive()
    }
}

impl ServerInterceptor {
    /// Creates a new Connect server interceptor bound to `sdk`.
    #[must_use]
    pub fn new(sdk: &Sdk) -> Self {
        let meter = sdk.meter(SCOPE_NAME);
        let duration = meter
            .f64_histogram(SERVER_CALL_DURATION)
            .with_unit("s")
            .with_description("Measures the duration of inbound RPC.")
            .with_boundaries(DURATION_BUCKETS.to_vec())
            .build();
        Self {
            config: Arc::new(InterceptorConfig {
                sdk: sdk.clone(),
                propagator: sdk.propagator().clone(),
                duration,
                public_endpoint: false,
                canonical_line: false,
                filters: Vec::new(),
            }),
        }
    }

    /// Marks the server as internet-facing: inbound trace context is linked on
    /// a fresh root span rather than adopted as parent, while inbound baggage
    /// is still adopted.
    ///
    /// When an outer HTTP layer (such as `libo11y-http`) has already started a
    /// span in [`opentelemetry::Context::current`], this interceptor nests its
    /// RPC span under that outer span and lets the outer layer decide trust,
    /// matching Go's `o11yconnect`.
    #[must_use]
    pub fn with_public_endpoint(mut self) -> Self {
        self.config_mut().public_endpoint = true;
        self
    }

    /// Excludes `grpc.health.v1.Health` procedures from tracing, metrics, and
    /// canonical log lines.
    #[must_use]
    pub fn with_ignore_health_checks(self) -> Self {
        self.with_filter(|procedure| !procedure.starts_with(HEALTH_PROCEDURE_PREFIX))
    }

    /// Emits one wide-event `o11y.request.summary` canonical log line per RPC
    /// (including on handler panic), enriched with any attributes the handler
    /// attaches to [`libo11y::record_from_context`].
    #[must_use]
    pub fn with_canonical_line(mut self) -> Self {
        self.config_mut().canonical_line = true;
        self
    }

    /// Adds a filter predicate receiving the procedure path (for example
    /// `"/test.v1.EchoService/Echo"`).
    ///
    /// When multiple filters are registered, an RPC is instrumented only when
    /// every filter returns `true`.
    #[must_use]
    pub fn with_filter<F>(mut self, predicate: F) -> Self
    where
        F: Fn(&str) -> bool + Send + Sync + 'static,
    {
        self.config_mut().filters.push(Arc::new(predicate));
        self
    }

    fn config_mut(&mut self) -> &mut InterceptorConfig {
        Arc::make_mut(&mut self.config)
    }
}

impl InterceptorConfig {
    fn should_record(&self, procedure: &str) -> bool {
        self.filters.iter().all(|allow| allow(procedure))
    }
}

struct ActiveCall {
    sdk: Sdk,
    cx: Context,
    duration: Histogram<f64>,
    metric_attrs: Vec<KeyValue>,
    start: Instant,
    procedure: String,
    protocol: Option<Protocol>,
    http_method: &'static str,
    is_unary: bool,
    record: Option<Record>,
    stream_error: Option<(ErrorCode, Option<String>)>,
}

impl ActiveCall {
    fn finish(
        mut self,
        error: Option<(ErrorCode, Option<String>)>,
        http_status_override: Option<u16>,
        panicked: bool,
    ) {
        let http_status: u16 = if panicked {
            500
        } else if let Some(code) = error.as_ref().map(|(c, _)| *c) {
            if self.is_unary && matches!(self.protocol, Some(Protocol::Connect) | None) {
                http_status_override.unwrap_or_else(|| http_status_for_code(code))
            } else {
                200
            }
        } else {
            http_status_override.unwrap_or(200)
        };

        let span = self.cx.span();
        span.set_attribute(KeyValue::new(
            HTTP_RESPONSE_STATUS_CODE,
            i64::from(http_status),
        ));

        let (rpc_code, is_err, err_desc) = if panicked {
            ("INTERNAL", true, Some("panic".to_owned()))
        } else if let Some((code, msg)) = error.as_ref() {
            let name = canonical_code(*code);
            (
                name,
                is_server_fault(*code),
                msg.clone().or_else(|| Some(name.to_owned())),
            )
        } else {
            (STATUS_CODE_OK, false, None)
        };

        let status_kv = KeyValue::new(RPC_RESPONSE_STATUS_CODE, rpc_code);
        span.set_attribute(status_kv.clone());
        self.metric_attrs.push(status_kv);

        if panicked || error.is_some() {
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
            if let Some(record) = self.record.take() {
                emit_canonical_line(
                    &self.cx,
                    &self.sdk,
                    &record,
                    &CanonicalSummary {
                        procedure: &self.procedure,
                        protocol: self.protocol,
                        http_method: self.http_method,
                        http_status: Some(http_status),
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
}

struct CallGuard {
    active: Option<ActiveCall>,
}

impl CallGuard {
    fn new(active: ActiveCall) -> Self {
        Self {
            active: Some(active),
        }
    }

    fn cx(&self) -> Option<&Context> {
        self.active.as_ref().map(|a| &a.cx)
    }

    fn finish_ok(&mut self) {
        if let Some(active) = self.active.take() {
            let err = active.stream_error.clone();
            active.finish(err, None, false);
        }
    }

    fn finish_err(&mut self, err: &ConnectError) {
        if let Some(active) = self.active.take() {
            active.finish(
                Some((err.code, err.message.clone())),
                Some(err.http_status().as_u16()),
                false,
            );
        }
    }
}

impl Drop for CallGuard {
    fn drop(&mut self) {
        if let Some(active) = self.active.take() {
            if std::thread::panicking() {
                active.finish(
                    Some((ErrorCode::Internal, Some("panic".to_owned()))),
                    Some(500),
                    true,
                );
            } else {
                let err = active
                    .stream_error
                    .clone()
                    .or(Some((ErrorCode::Canceled, None)));
                active.finish(err, None, false);
            }
        }
    }
}

fn begin_call(
    config: &InterceptorConfig,
    req_ctx: &RequestContext,
    is_unary: bool,
) -> Option<CallGuard> {
    let procedure = req_ctx
        .path()
        .or_else(|| req_ctx.spec().map(|s| s.procedure))
        .unwrap_or_default();
    if !config.should_record(procedure) {
        return None;
    }

    let protocol = req_ctx.protocol();
    let system = rpc_system(protocol);
    let (span_name, rpc_method) = parse_procedure(procedure);
    let (server_addr, server_port) = parse_server_address(None, req_ctx.headers());

    let mut base_attrs = Vec::with_capacity(4);
    base_attrs.push(KeyValue::new(RPC_SYSTEM_NAME, system));
    if let Some(method) = rpc_method {
        base_attrs.push(KeyValue::new(RPC_METHOD, method.to_owned()));
    }

    let mut span_attrs = base_attrs.clone();
    if let Some(addr) = server_addr {
        span_attrs.push(KeyValue::new(SERVER_ADDRESS, addr));
    }
    if let Some(port) = server_port {
        span_attrs.push(KeyValue::new(SERVER_PORT, port));
    }

    let tracer = config.sdk.tracer(SCOPE_NAME);
    let mut builder = tracer
        .span_builder(span_name.to_owned())
        .with_kind(SpanKind::Server)
        .with_attributes(span_attrs);

    // Match Go's otelconnect: if an outer layer (e.g. libo11y-http) has
    // already started a span on the current context, nest under it and let
    // the outer layer make the trust decision.
    let current = Context::current();
    let parent_cx = if current.span().span_context().is_valid() {
        current
    } else {
        let extracted = config
            .propagator
            .extract_with_context(&Context::new(), &HeaderExtractor(req_ctx.headers()));
        if config.public_endpoint {
            let remote_sc = extracted.span().span_context().clone();
            if remote_sc.is_valid() {
                builder = builder.with_links(vec![Link::new(remote_sc, Vec::new(), 0)]);
            }
            context_with_only_baggage(&extracted)
        } else {
            extracted
        }
    };

    let span = tracer.build_with_context(builder, &parent_cx);
    let mut cx = parent_cx.with_span(span);
    let record = if config.canonical_line {
        let (rec_cx, rec) = start_record(&cx);
        cx = rec_cx;
        Some(rec)
    } else {
        None
    };

    let http_method = infer_http_method(req_ctx, is_unary);

    Some(CallGuard::new(ActiveCall {
        sdk: config.sdk.clone(),
        cx,
        duration: config.duration.clone(),
        metric_attrs: base_attrs,
        start: Instant::now(),
        procedure: procedure.to_owned(),
        protocol,
        http_method,
        is_unary,
        record,
        stream_error: None,
    }))
}

fn infer_http_method(req_ctx: &RequestContext, is_unary: bool) -> &'static str {
    if let Some(method) = req_ctx.extensions().get::<http::Method>() {
        return if *method == http::Method::GET {
            "GET"
        } else {
            "POST"
        };
    }
    if is_unary
        && matches!(req_ctx.protocol(), Some(Protocol::Connect))
        && !req_ctx.headers().contains_key(CONTENT_TYPE)
        && req_ctx
            .spec()
            .is_some_and(|s| s.idempotency_level == IdempotencyLevel::NoSideEffects)
    {
        return "GET";
    }
    "POST"
}

struct InstrumentedPayloadStream {
    inner: PayloadStream,
    guard: CallGuard,
}

impl Stream for InstrumentedPayloadStream {
    type Item = Result<Payload, ConnectError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();
        let poll_res = if let Some(otel_cx) = this.guard.cx() {
            let _guard = otel_cx.clone().attach();
            this.inner.as_mut().poll_next(cx)
        } else {
            this.inner.as_mut().poll_next(cx)
        };

        let Poll::Ready(item) = poll_res else {
            return Poll::Pending;
        };

        match &item {
            Some(Err(err)) => {
                this.guard.finish_err(err);
            }
            Some(Ok(_)) => {}
            None => {
                this.guard.finish_ok();
            }
        }
        Poll::Ready(item)
    }
}

#[connectrpc::async_trait]
impl Interceptor for ServerInterceptor {
    async fn intercept_unary(
        &self,
        req: UnaryRequest,
        next: Next<'_>,
    ) -> Result<UnaryResponse, ConnectError> {
        let Some(mut guard) = begin_call(&self.config, &req.ctx, true) else {
            return next.run(req).await;
        };
        let cx = guard.cx().cloned().unwrap_or_else(Context::new);
        let result = next.run(req).with_context(cx).await;
        match &result {
            Ok(_) => guard.finish_ok(),
            Err(err) => guard.finish_err(err),
        }
        result
    }

    async fn intercept_streaming(
        &self,
        req: StreamRequest,
        inbound: PayloadStream,
        next: NextStream<'_>,
    ) -> Result<StreamResponse, ConnectError> {
        let Some(mut guard) = begin_call(&self.config, &req.ctx, false) else {
            return next.run(req, inbound).await;
        };
        let cx = guard.cx().cloned().unwrap_or_else(Context::new);
        let result = next.run(req, inbound).with_context(cx).await;
        match result {
            Ok(resp) => Ok(resp.map_body(|stream| -> PayloadStream {
                Box::pin(InstrumentedPayloadStream {
                    inner: stream,
                    guard,
                })
            })),
            Err(err) => {
                guard.finish_err(&err);
                Err(err)
            }
        }
    }
}

pub(crate) fn context_with_only_baggage(extracted: &Context) -> Context {
    let baggage: Baggage = extracted
        .baggage()
        .iter()
        .map(|(k, (v, m))| (k.clone(), (v.clone(), m.clone())))
        .collect();
    Context::new().with_baggage(baggage)
}
