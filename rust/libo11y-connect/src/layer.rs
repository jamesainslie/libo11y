//! Tower [`Layer`] / [`Service`] and [`connectrpc::client::ClientTransport`]
//! wrappers for Connect RPC servers and clients.

use std::fmt;
use std::sync::Arc;
use std::task::{Context as TaskContext, Poll};
use std::time::Instant;

use connectrpc::Protocol;
use connectrpc::client::{BoxFuture, ClientBody, ClientTransport};
use http::{Method, Request, Response};
use http_body::Body;
use libo11y::{Propagator, Sdk, start_record};
use opentelemetry::metrics::Histogram;
use opentelemetry::propagation::TextMapPropagator as _;
use opentelemetry::trace::{Link, SpanKind, TraceContextExt as _, Tracer as _};
use opentelemetry::{Context, KeyValue};
use tower_layer::Layer;
use tower_service::Service;

use crate::body::{CallRole, CanonicalState, InstrumentedBody, ResponseFuture, RpcState};
use crate::interceptor::context_with_only_baggage;
use crate::semconv::{
    CLIENT_CALL_DURATION, DURATION_BUCKETS, HEALTH_PROCEDURE_PREFIX, HeaderExtractor,
    HeaderInjector, RPC_METHOD, RPC_SYSTEM_NAME, SCOPE_NAME, SERVER_ADDRESS, SERVER_CALL_DURATION,
    SERVER_PORT, parse_procedure, parse_server_address, rpc_system,
};

/// Predicate deciding whether a Connect procedure path (such as
/// `"/test.v1.EchoService/Echo"`) should be instrumented.
pub type MethodFilter = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// Tower [`Layer`] that instruments inbound Connect, gRPC, and gRPC-Web RPCs
/// served by a `connectrpc::ConnectRpcService` (or any HTTP Tower service).
#[derive(Clone)]
pub struct ServerLayer {
    config: Arc<ServerConfig>,
}

struct ServerConfig {
    sdk: Sdk,
    propagator: Propagator,
    duration: Histogram<f64>,
    public_endpoint: bool,
    canonical_line: bool,
    filters: Vec<MethodFilter>,
}

impl Clone for ServerConfig {
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

impl fmt::Debug for ServerLayer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerLayer")
            .field("public_endpoint", &self.config.public_endpoint)
            .field("canonical_line", &self.config.canonical_line)
            .field("filters", &self.config.filters.len())
            .finish_non_exhaustive()
    }
}

impl ServerLayer {
    /// Creates a new Connect server Tower layer bound to `sdk`.
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
                canonical_line: false,
                filters: Vec::new(),
            }),
        }
    }

    /// Marks the server as internet-facing: inbound trace context is linked on
    /// a fresh root span rather than adopted as parent, while inbound baggage
    /// is still adopted.
    #[must_use]
    pub fn with_public_endpoint(mut self) -> Self {
        self.config_mut().public_endpoint = true;
        self
    }

    /// Excludes `grpc.health.v1.Health` procedures from tracing, metrics, and
    /// canonical log lines.
    #[must_use]
    pub fn with_ignore_health_checks(self) -> Self {
        self.with_filter(|path| !path.starts_with(HEALTH_PROCEDURE_PREFIX))
    }

    /// Emits one wide-event `o11y.request.summary` canonical log line per RPC,
    /// enriched with any attributes the handler attaches to
    /// [`libo11y::record_from_context`].
    #[must_use]
    pub fn with_canonical_line(mut self) -> Self {
        self.config_mut().canonical_line = true;
        self
    }

    /// Adds a filter predicate receiving the procedure path (for example
    /// `"/test.v1.EchoService/Echo"`).
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

impl ServerConfig {
    fn should_record(&self, procedure: &str) -> bool {
        self.filters.iter().all(|allow| allow(procedure))
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
            .field("canonical_line", &self.config.canonical_line)
            .finish_non_exhaustive()
    }
}

impl<S, ReqBody, ResBody> Service<Request<ReqBody>> for ServerService<S>
where
    S: Service<Request<ReqBody>, Response = Response<ResBody>>,
    ResBody: Body,
    S::Error: fmt::Display,
{
    type Response = Response<InstrumentedBody<ResBody>>;
    type Error = S::Error;
    type Future = ResponseFuture<S::Future>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<ReqBody>) -> Self::Future {
        let procedure = req.uri().path().to_owned();
        if !self.config.should_record(&procedure) {
            return ResponseFuture::passthrough(self.inner.call(req));
        }

        let (protocol, is_unary) = detect_request_protocol(&req);
        let system = rpc_system(protocol);
        let (span_name, rpc_method) = parse_procedure(&procedure);
        let (server_addr, server_port) = parse_server_address(Some(req.uri()), req.headers());

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

        let tracer = self.config.sdk.tracer(SCOPE_NAME);
        let mut builder = tracer
            .span_builder(span_name.to_owned())
            .with_kind(SpanKind::Server)
            .with_attributes(span_attrs);

        let current = Context::current();
        let parent_cx = if current.span().span_context().is_valid() {
            current
        } else {
            let extracted = self
                .config
                .propagator
                .extract_with_context(&Context::new(), &HeaderExtractor(req.headers()));
            if self.config.public_endpoint {
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
        let canonical = if self.config.canonical_line {
            let (rec_cx, record) = start_record(&cx);
            cx = rec_cx;
            Some(CanonicalState {
                sdk: self.config.sdk.clone(),
                record,
                procedure: procedure.clone(),
                http_method: req.method().as_str().to_owned(),
            })
        } else {
            None
        };

        let state = RpcState::new(
            cx.clone(),
            self.config.duration.clone(),
            base_attrs,
            Instant::now(),
            CallRole::Server,
            protocol,
            is_unary,
            canonical,
        );

        let fut = {
            let _guard = cx.attach();
            self.inner.call(req)
        };
        ResponseFuture::instrumented(fut, state)
    }
}

/// Tower [`Layer`] and [`ClientTransport`] wrapper builder that instruments
/// outbound Connect, gRPC, and gRPC-Web RPCs with OpenTelemetry spans, W3C
/// context injection, and `rpc.client.call.duration` metrics carrying
/// exemplars.
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
    /// Creates a new Connect client instrumentation layer bound to `sdk`.
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

    /// Excludes `grpc.health.v1.Health` procedures from tracing and metrics.
    #[must_use]
    pub fn with_ignore_health_checks(self) -> Self {
        self.with_filter(|path| !path.starts_with(HEALTH_PROCEDURE_PREFIX))
    }

    /// Adds a filter predicate receiving the procedure path (for example
    /// `"/test.v1.EchoService/Echo"`).
    #[must_use]
    pub fn with_filter<F>(mut self, predicate: F) -> Self
    where
        F: Fn(&str) -> bool + Send + Sync + 'static,
    {
        self.config_mut().filters.push(Arc::new(predicate));
        self
    }

    /// Sets fallback `server.address` and `server.port` attributes when an
    /// outgoing request URI carries no authority.
    #[must_use]
    pub fn with_server_address(mut self, address: impl Into<String>, port: Option<u16>) -> Self {
        let cfg = self.config_mut();
        cfg.default_server_address = Some(address.into());
        cfg.default_server_port = port.map(i64::from);
        self
    }

    /// Wraps any [`connectrpc::client::ClientTransport`] (such as
    /// `connectrpc::client::HttpClient` or `SharedHttp2Connection`) directly
    /// for use with generated Connect clients and `connectrpc::client::call_*`.
    #[must_use]
    pub fn wrap_transport<T>(&self, transport: T) -> InstrumentedTransport<T> {
        InstrumentedTransport {
            inner: transport,
            config: Arc::clone(&self.config),
        }
    }

    fn config_mut(&mut self) -> &mut ClientConfig {
        Arc::make_mut(&mut self.config)
    }
}

impl ClientConfig {
    fn should_record(&self, procedure: &str) -> bool {
        self.filters.iter().all(|allow| allow(procedure))
    }

    fn start_client_call<B>(&self, req: &mut Request<B>) -> Option<(Context, RpcState)> {
        let procedure = req.uri().path().to_owned();
        if !self.should_record(&procedure) {
            return None;
        }

        let parent_cx = Context::current();
        let (protocol, is_unary) = detect_request_protocol(req);
        let system = rpc_system(protocol);
        let (span_name, rpc_method) = parse_procedure(&procedure);
        let (parsed_addr, parsed_port) = parse_server_address(Some(req.uri()), req.headers());
        let (server_addr, server_port) = if parsed_addr.is_some() {
            (parsed_addr, parsed_port)
        } else {
            (
                self.default_server_address.clone(),
                self.default_server_port,
            )
        };

        let mut attrs = Vec::with_capacity(4);
        attrs.push(KeyValue::new(RPC_SYSTEM_NAME, system));
        if let Some(method) = rpc_method {
            attrs.push(KeyValue::new(RPC_METHOD, method.to_owned()));
        }
        if let Some(addr) = server_addr {
            attrs.push(KeyValue::new(SERVER_ADDRESS, addr));
        }
        if let Some(port) = server_port {
            attrs.push(KeyValue::new(SERVER_PORT, port));
        }

        let tracer = self.sdk.tracer(SCOPE_NAME);
        let builder = tracer
            .span_builder(span_name.to_owned())
            .with_kind(SpanKind::Client)
            .with_attributes(attrs.clone());
        let span = tracer.build_with_context(builder, &parent_cx);
        let cx = parent_cx.with_span(span);

        self.propagator
            .inject_context(&cx, &mut HeaderInjector(req.headers_mut()));

        let state = RpcState::new(
            cx.clone(),
            self.duration.clone(),
            attrs,
            Instant::now(),
            CallRole::Client,
            protocol,
            is_unary,
            None,
        );
        Some((cx, state))
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
    S::Error: fmt::Display,
{
    type Response = Response<InstrumentedBody<ResBody>>;
    type Error = S::Error;
    type Future = ResponseFuture<S::Future>;

    fn poll_ready(&mut self, cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<ReqBody>) -> Self::Future {
        let Some((cx, state)) = self.config.start_client_call(&mut req) else {
            return ResponseFuture::passthrough(self.inner.call(req));
        };
        let fut = {
            let _guard = cx.attach();
            self.inner.call(req)
        };
        ResponseFuture::instrumented(fut, state)
    }
}

/// [`connectrpc::client::ClientTransport`] wrapper created by
/// [`ClientLayer::wrap_transport`].
#[derive(Clone)]
pub struct InstrumentedTransport<T> {
    inner: T,
    config: Arc<ClientConfig>,
}

impl<T> fmt::Debug for InstrumentedTransport<T>
where
    T: fmt::Debug,
{
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("InstrumentedTransport")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}

impl<T> InstrumentedTransport<T> {
    /// Returns a reference to the wrapped transport.
    #[must_use]
    pub fn inner(&self) -> &T {
        &self.inner
    }

    /// Consumes the wrapper and returns the underlying transport.
    #[must_use]
    pub fn into_inner(self) -> T {
        self.inner
    }
}

impl<T> ClientTransport for InstrumentedTransport<T>
where
    T: ClientTransport,
    <T::ResponseBody as Body>::Error: fmt::Display,
{
    type ResponseBody = InstrumentedBody<T::ResponseBody>;
    type Error = T::Error;

    fn send(
        &self,
        mut request: Request<ClientBody>,
    ) -> BoxFuture<'static, Result<Response<Self::ResponseBody>, Self::Error>> {
        let Some((cx, state)) = self.config.start_client_call(&mut request) else {
            return Box::pin(ResponseFuture::passthrough(self.inner.send(request)));
        };

        let fut = {
            let _guard = cx.attach();
            self.inner.send(request)
        };
        Box::pin(ResponseFuture::instrumented(fut, state))
    }
}

/// Detects `(Option<Protocol>, is_unary)` from a Connect / gRPC / gRPC-Web HTTP
/// request.
fn detect_request_protocol<B>(req: &Request<B>) -> (Option<Protocol>, bool) {
    if let Some(detected) = Protocol::detect(req.headers()) {
        return (Some(detected.protocol), !detected.is_streaming);
    }
    if req.method() == Method::GET {
        return (Some(Protocol::Connect), true);
    }
    (Some(Protocol::Connect), true)
}
