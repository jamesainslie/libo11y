//! Tower [`Layer`] and [`Service`] implementations for `tonic` gRPC servers
//! and clients.

use std::fmt;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use http::{Request, Response};
use http_body::Body;
use libo11y::{Propagator, Sdk};
use opentelemetry::baggage::{Baggage, BaggageExt as _};
use opentelemetry::metrics::Histogram;
use opentelemetry::propagation::TextMapPropagator as _;
use opentelemetry::trace::{Link, SpanKind, TraceContextExt as _, Tracer as _};
use opentelemetry::{Context, KeyValue};
use tower_layer::Layer;
use tower_service::Service;

use crate::body::{CallRole, InstrumentedBody, ResponseFuture, RpcState};
use crate::semconv::{
    CLIENT_CALL_DURATION, DURATION_BUCKETS, HEALTH_METHOD_PREFIX, HeaderExtractor, HeaderInjector,
    RPC_METHOD, RPC_SYSTEM_GRPC, RPC_SYSTEM_NAME, SCOPE_NAME, SERVER_ADDRESS, SERVER_CALL_DURATION,
    SERVER_PORT, parse_full_method, parse_server_address,
};

/// Predicate deciding whether an RPC method path (such as
/// `"/checkout.Cart/AddItem"`) should be traced and measured.
///
/// Returning `true` instruments the RPC; returning `false` skips span and
/// metric creation while preserving context propagation.
pub type MethodFilter = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Tower [`Layer`] that instruments inbound `tonic` gRPC requests with
/// OpenTelemetry spans, W3C context propagation, and `rpc.server.call.duration`
/// metrics carrying exemplars.
///
/// Plugs directly into `tonic::transport::Server::builder().layer(...)`.
#[derive(Clone)]
pub struct ServerLayer {
    config: Arc<ServerConfig>,
}

struct ServerConfig {
    sdk: Sdk,
    propagator: Propagator,
    duration: Histogram<f64>,
    public_endpoint: bool,
    filters: Vec<MethodFilter>,
}

impl fmt::Debug for ServerLayer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerLayer")
            .field("public_endpoint", &self.config.public_endpoint)
            .field("filters", &self.config.filters.len())
            .finish_non_exhaustive()
    }
}

impl ServerLayer {
    /// Creates a new gRPC server instrumentation layer bound to `sdk`.
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
            config: Arc::new(ServerConfig {
                sdk: sdk.clone(),
                propagator: sdk.propagator().clone(),
                duration,
                public_endpoint: false,
                filters: Vec::new(),
            }),
        }
    }

    /// Marks the server as internet-facing: inbound trace context is linked on
    /// a fresh root span rather than adopted as parent, while inbound baggage
    /// is still adopted into the RPC context.
    #[must_use]
    pub fn with_public_endpoint(mut self) -> Self {
        self.config_mut().public_endpoint = true;
        self
    }

    /// Excludes `grpc.health.v1.Health` probes from tracing and metrics.
    ///
    /// Context propagation is unaffected: inbound trace context and baggage
    /// are still extracted into the RPC's active context.
    #[must_use]
    pub fn with_ignore_health_checks(self) -> Self {
        self.with_filter(|path| !path.starts_with(HEALTH_METHOD_PREFIX))
    }

    /// Adds a filter predicate receiving the full method path (for example
    /// `"/checkout.Cart/AddItem"`).
    ///
    /// When multiple filters are registered, an RPC is instrumented only when
    /// every filter returns `true`. Propagation is unaffected when filtered.
    #[must_use]
    pub fn with_filter<F>(mut self, predicate: F) -> Self
    where
        F: Fn(&str) -> bool + Send + Sync + 'static,
    {
        self.config_mut().filters.push(Arc::new(predicate));
        self
    }

    fn config_mut(&mut self) -> &mut ServerConfig {
        Arc::make_mut(&mut self.config)
    }
}

impl Clone for ServerConfig {
    fn clone(&self) -> Self {
        Self {
            sdk: self.sdk.clone(),
            propagator: self.propagator.clone(),
            duration: self.duration.clone(),
            public_endpoint: self.public_endpoint,
            filters: self.filters.clone(),
        }
    }
}

impl ServerConfig {
    fn should_record(&self, full_method: &str) -> bool {
        self.filters.iter().all(|allow| allow(full_method))
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

impl<S> fmt::Debug for ServerService<S>
where
    S: fmt::Debug,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerService")
            .field("inner", &self.inner)
            .field("public_endpoint", &self.config.public_endpoint)
            .finish_non_exhaustive()
    }
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for ServerService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
    ResBody: Body,
    S::Error: fmt::Display + 'static,
{
    type Response = Response<InstrumentedBody<ResBody>>;
    type Error = S::Error;
    type Future = ResponseFuture<S::Future>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let extracted = self
            .config
            .propagator
            .extract_with_context(&Context::new(), &HeaderExtractor(req.headers()));

        let full_method = req.uri().path();
        if !self.config.should_record(full_method) {
            let fut = {
                let _guard = extracted.clone().attach();
                self.inner.call(req)
            };
            return ResponseFuture::passthrough(fut, extracted);
        }

        let (span_name, rpc_method) = parse_full_method(full_method);
        let (server_addr, server_port) = parse_server_address(req.uri(), req.headers());

        let mut base_attrs = Vec::with_capacity(4);
        base_attrs.push(KeyValue::new(RPC_SYSTEM_NAME, RPC_SYSTEM_GRPC));
        if let Some(method) = rpc_method {
            base_attrs.push(KeyValue::new(RPC_METHOD, method.to_owned()));
        }

        // `rpc.method` joins the server span when the call finishes, as
        // `_OTHER` if the method turns out not to exist.
        let mut span_attrs = vec![KeyValue::new(RPC_SYSTEM_NAME, RPC_SYSTEM_GRPC)];
        if let Some(addr) = server_addr {
            span_attrs.push(KeyValue::new(SERVER_ADDRESS, addr));
        }
        if let Some(port) = server_port {
            span_attrs.push(KeyValue::new(SERVER_PORT, port));
        }

        let tracer = self.config.sdk.tracer(SCOPE_NAME);
        let mut builder = tracer
            .span_builder(span_name.to_owned())
            .with_kind(SpanKind::Server)
            .with_attributes(span_attrs);

        let parent_cx = if self.config.public_endpoint {
            let remote_sc = extracted.span().span_context().clone();
            if remote_sc.is_valid() {
                builder = builder.with_links(vec![Link::new(remote_sc, Vec::new(), 0)]);
            }
            context_with_only_baggage(&extracted)
        } else {
            extracted
        };

        let span = tracer.build_with_context(builder, &parent_cx);
        let cx = parent_cx.with_span(span);
        let state = RpcState::new(
            cx.clone(),
            self.config.duration.clone(),
            base_attrs,
            Instant::now(),
            CallRole::Server,
        );

        let fut = {
            let _guard = cx.attach();
            self.inner.call(req)
        };
        ResponseFuture::instrumented(fut, state)
    }
}

/// Tower [`Layer`] that instruments outbound `tonic` gRPC requests with
/// OpenTelemetry spans, W3C context injection, and `rpc.client.call.duration`
/// metrics carrying exemplars.
///
/// Plugs directly into
/// `tower::ServiceBuilder::new().layer(ClientLayer::new(&sdk)).service(channel)`.
#[derive(Clone)]
pub struct ClientLayer {
    config: Arc<ClientConfig>,
}

struct ClientConfig {
    sdk: Sdk,
    propagator: Propagator,
    duration: Histogram<f64>,
    filters: Vec<MethodFilter>,
    default_server_address: Option<String>,
    default_server_port: Option<i64>,
}

impl fmt::Debug for ClientLayer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientLayer")
            .field("filters", &self.config.filters.len())
            .field(
                "default_server_address",
                &self.config.default_server_address,
            )
            .field("default_server_port", &self.config.default_server_port)
            .finish_non_exhaustive()
    }
}

impl ClientLayer {
    /// Creates a new gRPC client instrumentation layer bound to `sdk`.
    #[must_use]
    pub fn new(sdk: &Sdk) -> Self {
        let meter = sdk.meter(SCOPE_NAME);
        let duration = meter
            .f64_histogram(CLIENT_CALL_DURATION)
            .with_unit("s")
            .with_description("Measures the duration of outbound RPC.")
            .with_boundaries(DURATION_BUCKETS.to_vec())
            .build();
        Self {
            config: Arc::new(ClientConfig {
                sdk: sdk.clone(),
                propagator: sdk.propagator().clone(),
                duration,
                filters: Vec::new(),
                default_server_address: None,
                default_server_port: None,
            }),
        }
    }

    /// Excludes `grpc.health.v1.Health` probes from tracing and metrics.
    ///
    /// Context propagation is unaffected: the caller's active trace context
    /// and baggage are still injected into the outgoing headers.
    #[must_use]
    pub fn with_ignore_health_checks(self) -> Self {
        self.with_filter(|path| !path.starts_with(HEALTH_METHOD_PREFIX))
    }

    /// Adds a filter predicate receiving the full method path (for example
    /// `"/checkout.Cart/AddItem"`).
    ///
    /// When multiple filters are registered, an RPC is instrumented only when
    /// every filter returns `true`. Propagation is unaffected when filtered.
    #[must_use]
    pub fn with_filter<F>(mut self, predicate: F) -> Self
    where
        F: Fn(&str) -> bool + Send + Sync + 'static,
    {
        self.config_mut().filters.push(Arc::new(predicate));
        self
    }

    /// Sets fallback `server.address` and `server.port` attributes when the
    /// outgoing `http::Request` URI has no authority (for example, when a
    /// `tonic::transport::Channel` receives relative paths).
    #[must_use]
    pub fn with_server_address(mut self, address: impl Into<String>, port: Option<u16>) -> Self {
        let cfg = self.config_mut();
        cfg.default_server_address = Some(address.into());
        cfg.default_server_port = port.map(i64::from);
        self
    }

    fn config_mut(&mut self) -> &mut ClientConfig {
        Arc::make_mut(&mut self.config)
    }
}

impl Clone for ClientConfig {
    fn clone(&self) -> Self {
        Self {
            sdk: self.sdk.clone(),
            propagator: self.propagator.clone(),
            duration: self.duration.clone(),
            filters: self.filters.clone(),
            default_server_address: self.default_server_address.clone(),
            default_server_port: self.default_server_port,
        }
    }
}

impl ClientConfig {
    fn should_record(&self, full_method: &str) -> bool {
        self.filters.iter().all(|allow| allow(full_method))
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
///
/// Implements `tonic::client::GrpcService` automatically via `tonic`'s blanket
/// implementation for compatible Tower services.
#[derive(Clone)]
pub struct ClientService<S> {
    inner: S,
    config: Arc<ClientConfig>,
}

impl<S> fmt::Debug for ClientService<S>
where
    S: fmt::Debug,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientService")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for ClientService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
    ResBody: Body,
    S::Error: fmt::Display + 'static,
{
    type Response = Response<InstrumentedBody<ResBody>>;
    type Error = S::Error;
    type Future = ResponseFuture<S::Future>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<ReqBody>) -> Self::Future {
        let parent_cx = Context::current();
        let full_method = req.uri().path().to_owned();

        if !self.config.should_record(&full_method) {
            self.config
                .propagator
                .inject_context(&parent_cx, &mut HeaderInjector(req.headers_mut()));
            let fut = {
                let _guard = parent_cx.clone().attach();
                self.inner.call(req)
            };
            return ResponseFuture::passthrough(fut, parent_cx);
        }

        let (span_name, rpc_method) = parse_full_method(&full_method);
        let (parsed_addr, parsed_port) = parse_server_address(req.uri(), req.headers());
        let (server_addr, server_port) = if parsed_addr.is_some() {
            (parsed_addr, parsed_port)
        } else {
            (
                self.config.default_server_address.clone(),
                self.config.default_server_port,
            )
        };

        let mut attrs = Vec::with_capacity(4);
        attrs.push(KeyValue::new(RPC_SYSTEM_NAME, RPC_SYSTEM_GRPC));
        if let Some(method) = rpc_method {
            attrs.push(KeyValue::new(RPC_METHOD, method.to_owned()));
        }
        if let Some(addr) = server_addr {
            attrs.push(KeyValue::new(SERVER_ADDRESS, addr));
        }
        if let Some(port) = server_port {
            attrs.push(KeyValue::new(SERVER_PORT, port));
        }

        let tracer = self.config.sdk.tracer(SCOPE_NAME);
        let builder = tracer
            .span_builder(span_name.to_owned())
            .with_kind(SpanKind::Client)
            .with_attributes(attrs.clone());
        let span = tracer.build_with_context(builder, &parent_cx);
        let cx = parent_cx.with_span(span);

        self.config
            .propagator
            .inject_context(&cx, &mut HeaderInjector(req.headers_mut()));

        let state = RpcState::new(
            cx.clone(),
            self.config.duration.clone(),
            attrs,
            Instant::now(),
            CallRole::Client,
        );

        let fut = {
            let _guard = cx.attach();
            self.inner.call(req)
        };
        ResponseFuture::instrumented(fut, state)
    }
}

/// Copies only the baggage from `extracted` onto a fresh root [`Context`],
/// dropping any remote span context so a new trace starts cleanly.
fn context_with_only_baggage(extracted: &Context) -> Context {
    let baggage: Baggage = extracted
        .baggage()
        .iter()
        .map(|(k, (v, m))| (k.clone(), (v.clone(), m.clone())))
        .collect();
    Context::new().with_baggage(baggage)
}
