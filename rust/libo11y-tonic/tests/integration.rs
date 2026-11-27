//! Integration tests for `libo11y-tonic`: real loopback HTTP/2 tonic server
//! and client calls plus Tower service edge cases.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};

use bytes::{Buf as _, BufMut as _, Bytes};
use http::header::HeaderValue;
use http::uri::PathAndQuery;
use http::{HeaderMap, Request, Response, StatusCode};
use http_body::{Body as HttpBody, Frame};
use http_body_util::BodyExt as _;
use libo11y_test::Recorder;
use opentelemetry::baggage::BaggageExt as _;
use opentelemetry::trace::{
    FutureExt as _, Span as _, SpanId, SpanKind, Status as SpanStatus, TraceContextExt as _,
    Tracer as _,
};
use opentelemetry::{Context, KeyValue, Value};
use opentelemetry_sdk::trace::SpanData;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tonic::body::Body as TonicBody;
use tonic::client::Grpc;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::server::{Grpc as ServerGrpc, NamedService, ServerStreamingService, UnaryService};
use tonic::transport::{Channel, Endpoint, Server};
use tonic::{Code, Request as TonicRequest, Response as TonicResponse, Status};
use tower::{ServiceBuilder, ServiceExt as _};
use tower_service::Service;

use libo11y_tonic::{ClientLayer, ServerLayer};

const ECHO_PATH: &str = "/test.v1.EchoService/Echo";
const ECHO_METHOD: &str = "test.v1.EchoService/Echo";
const STREAM_PATH: &str = "/test.v1.EchoService/Watch";
const STREAM_METHOD: &str = "test.v1.EchoService/Watch";
const HEALTH_PATH: &str = "/grpc.health.v1.Health/Check";
const HEALTH_METHOD: &str = "grpc.health.v1.Health/Check";

/// Minimal UTF-8 string codec for driving real tonic HTTP/2 RPCs without codegen.
#[derive(Debug, Default, Clone, Copy)]
struct StringCodec;

#[derive(Debug, Default, Clone, Copy)]
struct StringEncoder;

#[derive(Debug, Default, Clone, Copy)]
struct StringDecoder;

impl Encoder for StringEncoder {
    type Item = String;
    type Error = Status;

    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        dst.put_slice(item.as_bytes());
        Ok(())
    }
}

impl Decoder for StringDecoder {
    type Item = String;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        let len = src.remaining();
        let mut buf = vec![0u8; len];
        src.copy_to_slice(&mut buf);
        String::from_utf8(buf)
            .map(Some)
            .map_err(|err| Status::internal(err.to_string()))
    }
}

impl Codec for StringCodec {
    type Encode = String;
    type Decode = String;
    type Encoder = StringEncoder;
    type Decoder = StringDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        StringEncoder
    }

    fn decoder(&mut self) -> Self::Decoder {
        StringDecoder
    }
}

/// Captured server-side OpenTelemetry context per RPC.
#[derive(Clone, Default)]
struct CapturedContexts(Arc<Mutex<Vec<Context>>>);

impl CapturedContexts {
    fn push(&self, cx: Context) {
        self.0.lock().expect("lock").push(cx);
    }

    fn all(&self) -> Vec<Context> {
        self.0.lock().expect("lock").clone()
    }
}

#[derive(Clone)]
struct EchoSvc {
    captured: CapturedContexts,
    subscriber: Arc<dyn tracing::Subscriber + Send + Sync>,
}

impl NamedService for EchoSvc {
    const NAME: &'static str = "test.v1.EchoService";
}

impl Service<Request<TonicBody>> for EchoSvc {
    type Response = Response<TonicBody>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: Request<TonicBody>) -> Self::Future {
        let captured = self.captured.clone();
        let subscriber = Arc::clone(&self.subscriber);
        match req.uri().path() {
            ECHO_PATH => {
                struct Handler {
                    captured: CapturedContexts,
                    subscriber: Arc<dyn tracing::Subscriber + Send + Sync>,
                }
                impl UnaryService<String> for Handler {
                    type Response = String;
                    type Future =
                        Pin<Box<dyn Future<Output = Result<TonicResponse<String>, Status>> + Send>>;

                    fn call(&mut self, request: TonicRequest<String>) -> Self::Future {
                        let captured = self.captured.clone();
                        let subscriber = Arc::clone(&self.subscriber);
                        let value = request.into_inner();
                        Box::pin(async move {
                            captured.push(Context::current());
                            tracing::subscriber::with_default(subscriber, || {
                                tracing::info!(rpc.echo = %value, "echo handled");
                            });
                            match value.as_str() {
                                "not-found" => Err(Status::not_found("missing item")),
                                "internal" => Err(Status::internal("db failure")),
                                _ => Ok(TonicResponse::new(value)),
                            }
                        })
                    }
                }
                let mut grpc = ServerGrpc::new(StringCodec);
                Box::pin(async move {
                    Ok(grpc
                        .unary(
                            Handler {
                                captured,
                                subscriber,
                            },
                            req,
                        )
                        .await)
                })
            }
            STREAM_PATH => {
                struct StreamHandler {
                    captured: CapturedContexts,
                }
                struct VecStream {
                    items: Vec<Result<String, Status>>,
                    captured: CapturedContexts,
                }
                impl tokio_stream::Stream for VecStream {
                    type Item = Result<String, Status>;
                    fn poll_next(
                        mut self: Pin<&mut Self>,
                        _cx: &mut TaskContext<'_>,
                    ) -> Poll<Option<Self::Item>> {
                        if self.items.is_empty() {
                            return Poll::Ready(None);
                        }
                        self.captured.push(Context::current());
                        Poll::Ready(Some(self.items.remove(0)))
                    }
                }
                impl ServerStreamingService<String> for StreamHandler {
                    type Response = String;
                    type ResponseStream = VecStream;
                    type Future = Pin<
                        Box<
                            dyn Future<Output = Result<TonicResponse<Self::ResponseStream>, Status>>
                                + Send,
                        >,
                    >;

                    fn call(&mut self, request: TonicRequest<String>) -> Self::Future {
                        let captured = self.captured.clone();
                        let val = request.into_inner();
                        Box::pin(async move {
                            let items = match val.as_str() {
                                "stream-internal" => vec![
                                    Ok("chunk-1".to_owned()),
                                    Err(Status::internal("stream broke")),
                                ],
                                _ => vec![Ok("chunk-1".to_owned()), Ok("chunk-2".to_owned())],
                            };
                            Ok(TonicResponse::new(VecStream { items, captured }))
                        })
                    }
                }
                let mut grpc = ServerGrpc::new(StringCodec);
                Box::pin(
                    async move { Ok(grpc.server_streaming(StreamHandler { captured }, req).await) },
                )
            }
            _ => Box::pin(async { Ok(Status::unimplemented("unknown method").into_http()) }),
        }
    }
}

#[derive(Clone)]
struct HealthSvc {
    captured: CapturedContexts,
}

impl NamedService for HealthSvc {
    const NAME: &'static str = "grpc.health.v1.Health";
}

impl Service<Request<TonicBody>> for HealthSvc {
    type Response = Response<TonicBody>;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut TaskContext<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, req: Request<TonicBody>) -> Self::Future {
        struct Handler(CapturedContexts);
        impl UnaryService<String> for Handler {
            type Response = String;
            type Future =
                Pin<Box<dyn Future<Output = Result<TonicResponse<String>, Status>> + Send>>;
            fn call(&mut self, _request: TonicRequest<String>) -> Self::Future {
                let captured = self.0.clone();
                Box::pin(async move {
                    captured.push(Context::current());
                    Ok(TonicResponse::new("SERVING".to_owned()))
                })
            }
        }
        let captured = self.captured.clone();
        let mut grpc = ServerGrpc::new(StringCodec);
        Box::pin(async move { Ok(grpc.unary(Handler(captured), req).await) })
    }
}

struct LoopbackServer {
    addr: std::net::SocketAddr,
    captured: CapturedContexts,
    shutdown_tx: Option<oneshot::Sender<()>>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl LoopbackServer {
    async fn start(rec: &Recorder, server_layer: ServerLayer) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        let incoming = tokio_stream::wrappers::TcpListenerStream::new(listener);
        let captured = CapturedContexts::default();
        let subscriber: Arc<dyn tracing::Subscriber + Send + Sync> =
            Arc::new(rec.sdk().subscriber());

        let echo = EchoSvc {
            captured: captured.clone(),
            subscriber,
        };
        let health = HealthSvc {
            captured: captured.clone(),
        };

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            let _ = Server::builder()
                .layer(server_layer)
                .add_service(echo)
                .add_service(health)
                .serve_with_incoming_shutdown(incoming, async {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        Self {
            addr,
            captured,
            shutdown_tx: Some(shutdown_tx),
            handle: Some(handle),
        }
    }

    async fn channel(&self) -> Channel {
        Endpoint::from_shared(format!("http://{}", self.addr))
            .expect("endpoint")
            .connect()
            .await
            .expect("connect")
    }

    fn origin(&self) -> http::Uri {
        format!("http://{}", self.addr).parse().expect("origin")
    }

    async fn stop(&mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
    }
}

fn span_attr(span: &SpanData, key: &str) -> Option<String> {
    span.attributes
        .iter()
        .find(|kv| kv.key.as_str() == key)
        .map(|kv| match &kv.value {
            Value::String(s) => s.as_str().to_owned(),
            other => other.to_string(),
        })
}

fn find_span(spans: &[SpanData], kind: &SpanKind, name: &str) -> Option<SpanData> {
    spans
        .iter()
        .find(|s| s.span_kind == *kind && s.name.as_ref() == name)
        .cloned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unary_roundtrip_propagates_context_records_metrics_and_triangle() {
    let rec = Recorder::start("tonic-roundtrip");
    let mut srv = LoopbackServer::start(&rec, ServerLayer::new(rec.sdk())).await;

    let channel = srv.channel().await;
    let svc = ServiceBuilder::new()
        .layer(ClientLayer::new(rec.sdk()))
        .service(channel);
    let mut client = Grpc::with_origin(svc, srv.origin());
    client.ready().await.expect("ready");

    let caller_span = rec.sdk().tracer("caller").start("caller.op");
    let caller_sc = caller_span.span_context().clone();
    let caller_cx = Context::new()
        .with_span(caller_span)
        .with_baggage([KeyValue::new("tenant", "acme")]);

    let resp = async {
        client
            .unary(
                TonicRequest::new("hello".to_owned()),
                PathAndQuery::from_static(ECHO_PATH),
                StringCodec,
            )
            .await
    }
    .with_context(caller_cx.clone())
    .await
    .expect("unary ok");
    assert_eq!(resp.into_inner(), "hello");
    caller_cx.span().end();

    srv.stop().await;

    let server_cxs = srv.captured.all();
    assert_eq!(server_cxs.len(), 1);
    assert_eq!(
        server_cxs[0]
            .baggage()
            .get("tenant")
            .map(ToString::to_string)
            .as_deref(),
        Some("acme")
    );

    let spans = rec.spans();
    let client_span = find_span(&spans, &SpanKind::Client, ECHO_METHOD).expect("client span");
    let server_span = find_span(&spans, &SpanKind::Server, ECHO_METHOD).expect("server span");

    // Trace hierarchy: caller -> client -> server.
    assert_eq!(client_span.span_context.trace_id(), caller_sc.trace_id());
    assert_eq!(client_span.parent_span_id, caller_sc.span_id());
    assert_eq!(server_span.span_context.trace_id(), caller_sc.trace_id());
    assert_eq!(
        server_span.parent_span_id,
        client_span.span_context.span_id()
    );

    // Semconv 1.41.0 attributes.
    for span in [&client_span, &server_span] {
        assert_eq!(span_attr(span, "rpc.system.name").as_deref(), Some("grpc"));
        assert_eq!(span_attr(span, "rpc.method").as_deref(), Some(ECHO_METHOD));
        assert_eq!(
            span_attr(span, "rpc.response.status_code").as_deref(),
            Some("OK")
        );
        assert_eq!(span_attr(span, "error.type"), None);
        assert_eq!(span.status, SpanStatus::Unset);
    }
    assert_eq!(
        span_attr(&client_span, "server.address").as_deref(),
        Some("127.0.0.1")
    );
    assert_eq!(
        span_attr(&client_span, "server.port").as_deref(),
        Some(srv.addr.port().to_string().as_str())
    );

    // Duration histograms & exemplars on both sides.
    let metric_names = rec.metric_names();
    assert!(
        metric_names.contains(&"rpc.server.call.duration".to_owned()),
        "{metric_names:?}"
    );
    assert!(
        metric_names.contains(&"rpc.client.call.duration".to_owned()),
        "{metric_names:?}"
    );

    let server_ex = rec.exemplars("rpc.server.call.duration");
    assert!(!server_ex.is_empty(), "missing server duration exemplar");
    assert_eq!(
        server_ex[0].trace_id,
        server_span.span_context.trace_id().to_string()
    );
    assert_eq!(
        server_ex[0].span_id,
        server_span.span_context.span_id().to_string()
    );

    let client_ex = rec.exemplars("rpc.client.call.duration");
    assert!(!client_ex.is_empty(), "missing client duration exemplar");
    assert_eq!(
        client_ex[0].trace_id,
        client_span.span_context.trace_id().to_string()
    );
    assert_eq!(
        client_ex[0].span_id,
        client_span.span_context.span_id().to_string()
    );

    rec.assert_conforms();
    rec.assert_correlated();
    rec.assert_triangle("rpc.server.call.duration");
    rec.assert_triangle("rpc.client.call.duration");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn error_status_rules_distinguish_client_fault_and_server_fault() {
    let rec = Recorder::start("tonic-errors");
    let mut srv = LoopbackServer::start(&rec, ServerLayer::new(rec.sdk())).await;

    let channel = srv.channel().await;
    let svc = ServiceBuilder::new()
        .layer(ClientLayer::new(rec.sdk()))
        .service(channel);
    let mut client = Grpc::with_origin(svc, srv.origin());
    client.ready().await.expect("ready");

    // Client-fault code: NOT_FOUND -> server span stays Unset, client span is Error.
    let err = client
        .unary(
            TonicRequest::new("not-found".to_owned()),
            PathAndQuery::from_static(ECHO_PATH),
            StringCodec,
        )
        .await
        .expect_err("not found");
    assert_eq!(err.code(), Code::NotFound);

    // Server-fault code: INTERNAL -> both server and client spans are Error.
    client.ready().await.expect("ready");
    let err = client
        .unary(
            TonicRequest::new("internal".to_owned()),
            PathAndQuery::from_static(ECHO_PATH),
            StringCodec,
        )
        .await
        .expect_err("internal");
    assert_eq!(err.code(), Code::Internal);

    srv.stop().await;

    let spans = rec.spans();
    let server_spans: Vec<_> = spans
        .iter()
        .filter(|s| s.span_kind == SpanKind::Server)
        .collect();
    let client_spans: Vec<_> = spans
        .iter()
        .filter(|s| s.span_kind == SpanKind::Client)
        .collect();
    assert_eq!(server_spans.len(), 2);
    assert_eq!(client_spans.len(), 2);

    // NOT_FOUND
    let srv_nf = server_spans
        .iter()
        .find(|s| span_attr(s, "rpc.response.status_code").as_deref() == Some("NOT_FOUND"))
        .expect("server NOT_FOUND");
    assert_eq!(srv_nf.status, SpanStatus::Unset);
    assert_eq!(span_attr(srv_nf, "error.type"), None);

    let cli_nf = client_spans
        .iter()
        .find(|s| span_attr(s, "rpc.response.status_code").as_deref() == Some("NOT_FOUND"))
        .expect("client NOT_FOUND");
    assert!(matches!(cli_nf.status, SpanStatus::Error { .. }));
    assert_eq!(
        span_attr(cli_nf, "error.type").as_deref(),
        Some("NOT_FOUND")
    );

    // INTERNAL
    let srv_int = server_spans
        .iter()
        .find(|s| span_attr(s, "rpc.response.status_code").as_deref() == Some("INTERNAL"))
        .expect("server INTERNAL");
    assert!(matches!(srv_int.status, SpanStatus::Error { .. }));
    assert_eq!(
        span_attr(srv_int, "error.type").as_deref(),
        Some("INTERNAL")
    );

    let cli_int = client_spans
        .iter()
        .find(|s| span_attr(s, "rpc.response.status_code").as_deref() == Some("INTERNAL"))
        .expect("client INTERNAL");
    assert!(matches!(cli_int.status, SpanStatus::Error { .. }));
    assert_eq!(
        span_attr(cli_int, "error.type").as_deref(),
        Some("INTERNAL")
    );

    rec.assert_conforms();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn server_streaming_captures_trailer_grpc_status_and_keeps_context_active() {
    let rec = Recorder::start("tonic-stream");
    let mut srv = LoopbackServer::start(&rec, ServerLayer::new(rec.sdk())).await;

    let channel = srv.channel().await;
    let svc = ServiceBuilder::new()
        .layer(ClientLayer::new(rec.sdk()))
        .service(channel);
    let mut client = Grpc::with_origin(svc, srv.origin());

    // Successful stream (grpc-status: 0 in HTTP/2 trailers).
    client.ready().await.expect("ready");
    let mut stream = client
        .server_streaming(
            TonicRequest::new("ok".to_owned()),
            PathAndQuery::from_static(STREAM_PATH),
            StringCodec,
        )
        .await
        .expect("stream start")
        .into_inner();
    let mut got = Vec::new();
    while let Some(msg) = stream.message().await.expect("chunk") {
        got.push(msg);
    }
    assert_eq!(got, vec!["chunk-1", "chunk-2"]);

    // Mid-stream error (grpc-status: 13 in HTTP/2 trailers after chunk-1).
    client.ready().await.expect("ready");
    let mut err_stream = client
        .server_streaming(
            TonicRequest::new("stream-internal".to_owned()),
            PathAndQuery::from_static(STREAM_PATH),
            StringCodec,
        )
        .await
        .expect("stream start")
        .into_inner();
    assert_eq!(
        err_stream.message().await.expect("first chunk").as_deref(),
        Some("chunk-1")
    );
    let err = err_stream.message().await.expect_err("mid-stream error");
    assert_eq!(err.code(), Code::Internal);

    srv.stop().await;

    let spans = rec.spans();
    let ok_srv = spans
        .iter()
        .find(|s| {
            s.span_kind == SpanKind::Server
                && s.name.as_ref() == STREAM_METHOD
                && span_attr(s, "rpc.response.status_code").as_deref() == Some("OK")
        })
        .expect("server stream OK span");
    assert_eq!(ok_srv.status, SpanStatus::Unset);

    let err_srv = spans
        .iter()
        .find(|s| {
            s.span_kind == SpanKind::Server
                && s.name.as_ref() == STREAM_METHOD
                && span_attr(s, "rpc.response.status_code").as_deref() == Some("INTERNAL")
        })
        .expect("server stream INTERNAL span");
    assert!(matches!(err_srv.status, SpanStatus::Error { .. }));

    let err_cli = spans
        .iter()
        .find(|s| {
            s.span_kind == SpanKind::Client
                && s.name.as_ref() == STREAM_METHOD
                && span_attr(s, "rpc.response.status_code").as_deref() == Some("INTERNAL")
        })
        .expect("client stream INTERNAL span");
    assert!(matches!(err_cli.status, SpanStatus::Error { .. }));

    // Every stream poll saw a valid server span in Context::current().
    let server_cxs = srv.captured.all();
    assert!(server_cxs.len() >= 3);
    for cx in &server_cxs {
        assert!(cx.span().span_context().is_valid());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ignore_health_checks_skips_spans_and_metrics_while_preserving_propagation() {
    for (ignore_server, ignore_client) in
        [(false, false), (true, false), (false, true), (true, true)]
    {
        let rec = Recorder::start("tonic-health");
        let mut srv_layer = ServerLayer::new(rec.sdk());
        if ignore_server {
            srv_layer = srv_layer.with_ignore_health_checks();
        }
        let mut srv = LoopbackServer::start(&rec, srv_layer).await;

        let mut cli_layer = ClientLayer::new(rec.sdk());
        if ignore_client {
            cli_layer = cli_layer.with_ignore_health_checks();
        }
        let svc = ServiceBuilder::new()
            .layer(cli_layer)
            .service(srv.channel().await);
        let mut client = Grpc::with_origin(svc, srv.origin());
        client.ready().await.expect("ready");

        let caller_span = rec.sdk().tracer("caller").start("probe");
        let caller_tid = caller_span.span_context().trace_id();
        let caller_cx = Context::new().with_span(caller_span);

        let resp = async {
            client
                .unary(
                    TonicRequest::new(String::new()),
                    PathAndQuery::from_static(HEALTH_PATH),
                    StringCodec,
                )
                .await
        }
        .with_context(caller_cx.clone())
        .await
        .expect("health ok");
        assert_eq!(resp.into_inner(), "SERVING");
        caller_cx.span().end();

        srv.stop().await;

        // Propagation always reaches the server regardless of filtering.
        let cxs = srv.captured.all();
        assert_eq!(cxs.len(), 1);
        assert_eq!(
            cxs[0].span().span_context().trace_id(),
            caller_tid,
            "ignore_server={ignore_server}, ignore_client={ignore_client}"
        );

        let spans = rec.spans();
        let names = rec.metric_names();
        assert_eq!(
            find_span(&spans, &SpanKind::Server, HEALTH_METHOD).is_some(),
            !ignore_server,
            "server span presence for ignore_server={ignore_server}"
        );
        assert_eq!(
            find_span(&spans, &SpanKind::Client, HEALTH_METHOD).is_some(),
            !ignore_client,
            "client span presence for ignore_client={ignore_client}"
        );
        assert_eq!(
            names.contains(&"rpc.server.call.duration".to_owned()),
            !ignore_server
        );
        assert_eq!(
            names.contains(&"rpc.client.call.duration".to_owned()),
            !ignore_client
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn public_endpoint_links_remote_context_and_adopts_baggage() {
    let rec = Recorder::start("tonic-public");
    let mut srv =
        LoopbackServer::start(&rec, ServerLayer::new(rec.sdk()).with_public_endpoint()).await;

    let svc = ServiceBuilder::new()
        .layer(ClientLayer::new(rec.sdk()))
        .service(srv.channel().await);
    let mut client = Grpc::with_origin(svc, srv.origin());
    client.ready().await.expect("ready");

    let caller_span = rec.sdk().tracer("caller").start("edge");
    let caller_cx = Context::new()
        .with_span(caller_span)
        .with_baggage([KeyValue::new("tenant", "acme")]);

    async {
        client
            .unary(
                TonicRequest::new("hi".to_owned()),
                PathAndQuery::from_static(ECHO_PATH),
                StringCodec,
            )
            .await
    }
    .with_context(caller_cx.clone())
    .await
    .expect("ok");
    caller_cx.span().end();

    srv.stop().await;

    let spans = rec.spans();
    let client_span = find_span(&spans, &SpanKind::Client, ECHO_METHOD).expect("client");
    let server_span = find_span(&spans, &SpanKind::Server, ECHO_METHOD).expect("server");

    // New root trace on server, not parented to caller/client.
    assert_eq!(server_span.parent_span_id, SpanId::INVALID);
    assert_ne!(
        server_span.span_context.trace_id(),
        client_span.span_context.trace_id()
    );
    // Single link pointing to the client span.
    let links = &server_span.links.links;
    assert_eq!(links.len(), 1);
    assert_eq!(
        links[0].span_context.trace_id(),
        client_span.span_context.trace_id()
    );
    assert_eq!(
        links[0].span_context.span_id(),
        client_span.span_context.span_id()
    );
    // Inbound baggage is still adopted.
    let server_cxs = srv.captured.all();
    assert_eq!(
        server_cxs[0]
            .baggage()
            .get("tenant")
            .map(ToString::to_string)
            .as_deref(),
        Some("acme")
    );
}

/// Custom body yielding one data frame followed by a `grpc-status` trailer frame.
struct TrailerBody {
    data: Option<Bytes>,
    trailers: Option<HeaderMap>,
}

impl HttpBody for TrailerBody {
    type Data = Bytes;
    type Error = Infallible;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        _cx: &mut TaskContext<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        if let Some(data) = self.data.take() {
            return Poll::Ready(Some(Ok(Frame::data(data))));
        }
        if let Some(trailers) = self.trailers.take() {
            return Poll::Ready(Some(Ok(Frame::trailers(trailers))));
        }
        Poll::Ready(None)
    }

    fn is_end_stream(&self) -> bool {
        self.data.is_none() && self.trailers.is_none()
    }
}

#[tokio::test]
async fn tower_service_handles_trailers_and_custom_filters() {
    let rec = Recorder::start("tonic-tower-trailers");

    // Trailer-delivered grpc-status (DEADLINE_EXCEEDED = 4) and custom filters.
    let svc = ServiceBuilder::new()
        .layer(
            ServerLayer::new(rec.sdk())
                .with_filter(|path| !path.starts_with("/skip."))
                .with_filter(|path| !path.ends_with("/Quiet")),
        )
        .service_fn(|req: Request<()>| async move {
            let mut trailers = HeaderMap::new();
            let code = if req.uri().path() == "/pkg.Svc/Slow" {
                "4"
            } else {
                "0"
            };
            trailers.insert("grpc-status", HeaderValue::from_static(code));
            Ok::<_, std::io::Error>(Response::new(TrailerBody {
                data: Some(Bytes::from_static(b"payload")),
                trailers: Some(trailers),
            }))
        });

    let resp = svc
        .clone()
        .oneshot(
            Request::builder()
                .uri("/pkg.Svc/Slow")
                .body(())
                .expect("req"),
        )
        .await
        .expect("ok");
    let _ = resp.into_body().collect().await.expect("collect");

    // Filtered out by first filter and second filter.
    let r1 = svc
        .clone()
        .oneshot(
            Request::builder()
                .uri("/skip.Svc/Call")
                .body(())
                .expect("req"),
        )
        .await
        .expect("ok");
    let _ = r1.into_body().collect().await.expect("collect");
    let r2 = svc
        .oneshot(
            Request::builder()
                .uri("/pkg.Svc/Quiet")
                .body(())
                .expect("req"),
        )
        .await
        .expect("ok");
    let _ = r2.into_body().collect().await.expect("collect");

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].name.as_ref(), "pkg.Svc/Slow");
    assert_eq!(
        span_attr(&spans[0], "rpc.response.status_code").as_deref(),
        Some("DEADLINE_EXCEEDED")
    );
    assert_eq!(
        span_attr(&spans[0], "error.type").as_deref(),
        Some("DEADLINE_EXCEEDED")
    );
    assert!(matches!(spans[0].status, SpanStatus::Error { .. }));
}

#[tokio::test]
async fn tower_service_handles_transport_errors_and_panics() {
    let rec = Recorder::start("tonic-tower-errors");

    // Transport error on client side records UNKNOWN and Error status.
    let err_client = ServiceBuilder::new()
        .layer(ClientLayer::new(rec.sdk()).with_server_address("rpc.internal", Some(50051)))
        .service_fn(|_req: Request<()>| async move {
            Err::<Response<http_body_util::Empty<Bytes>>, _>(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                "connection refused",
            ))
        });

    let _ = err_client
        .oneshot(
            Request::builder()
                .uri("/pkg.Svc/Down")
                .body(())
                .expect("req"),
        )
        .await
        .expect_err("transport error");

    let down_span = find_span(&rec.spans(), &SpanKind::Client, "pkg.Svc/Down").expect("down span");
    assert!(matches!(down_span.status, SpanStatus::Error { .. }));
    assert_eq!(
        span_attr(&down_span, "rpc.response.status_code").as_deref(),
        Some("UNKNOWN")
    );
    assert_eq!(
        span_attr(&down_span, "server.address").as_deref(),
        Some("rpc.internal")
    );
    assert_eq!(
        span_attr(&down_span, "server.port").as_deref(),
        Some("50051")
    );

    // Panicking handler marks server span Error with INTERNAL and keeps propagating.
    let panic_svc = ServiceBuilder::new()
        .layer(ServerLayer::new(rec.sdk()))
        .service_fn(|_req: Request<()>| async move {
            panic!("handler exploded");
            #[allow(unreachable_code)]
            Ok::<Response<http_body_util::Empty<Bytes>>, Infallible>(Response::new(
                http_body_util::Empty::new(),
            ))
        });

    let join = tokio::spawn(async move {
        let _ = panic_svc
            .oneshot(
                Request::builder()
                    .uri("/pkg.Svc/Boom")
                    .body(())
                    .expect("req"),
            )
            .await;
    })
    .await;
    assert!(join.is_err(), "panic must propagate");

    let boom_span = find_span(&rec.spans(), &SpanKind::Server, "pkg.Svc/Boom").expect("boom span");
    assert!(matches!(boom_span.status, SpanStatus::Error { .. }));
    assert_eq!(
        span_attr(&boom_span, "rpc.response.status_code").as_deref(),
        Some("INTERNAL")
    );
    assert_eq!(
        span_attr(&boom_span, "error.type").as_deref(),
        Some("INTERNAL")
    );
    assert_eq!(StatusCode::OK.as_u16(), 200);
}

#[test]
fn outer_catch_unwind_still_records_panic_and_fallback_port_does_not_mix_with_request_host() {
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::task::Waker;

    let rec = Recorder::start("tonic-review-regressions");

    // 1. Panic inside poll caught by an outer catch_unwind before future drop.
    let mut panic_svc = ServiceBuilder::new()
        .layer(ServerLayer::new(rec.sdk()))
        .service_fn(|_req: Request<()>| async move {
            panic!("caught externally");
            #[allow(unreachable_code)]
            Ok::<Response<http_body_util::Empty<Bytes>>, Infallible>(Response::new(
                http_body_util::Empty::new(),
            ))
        });

    let mut fut = Box::pin(
        panic_svc.call(
            Request::builder()
                .uri("/pkg.Svc/Caught")
                .body(())
                .expect("req"),
        ),
    );
    let waker = Waker::noop();
    let mut task_cx = TaskContext::from_waker(waker);
    let caught = catch_unwind(AssertUnwindSafe(|| fut.as_mut().poll(&mut task_cx)));
    assert!(caught.is_err(), "inner poll must panic");
    // Dropping the future AFTER catch_unwind (when !thread::panicking()) must
    // still have recorded INTERNAL/panic, not CANCELLED.
    drop(fut);

    let span = find_span(&rec.spans(), &SpanKind::Server, "pkg.Svc/Caught").expect("caught span");
    assert!(matches!(span.status, SpanStatus::Error { .. }));
    assert_eq!(
        span_attr(&span, "rpc.response.status_code").as_deref(),
        Some("INTERNAL")
    );
    assert_eq!(span_attr(&span, "error.type").as_deref(), Some("INTERNAL"));

    // 2. Fallback port from with_server_address must not mix with an explicit request host.
    let mut client = ServiceBuilder::new()
        .layer(ClientLayer::new(rec.sdk()).with_server_address("fallback.local", Some(50051)))
        .service_fn(|_req: Request<()>| async move {
            Ok::<_, Infallible>(Response::new(http_body_util::Empty::<Bytes>::new()))
        });
    let mut host_fut = Box::pin(
        client.call(
            Request::builder()
                .uri("http://explicit.host/pkg.Svc/Ping")
                .body(())
                .expect("req"),
        ),
    );
    let _ = host_fut.as_mut().poll(&mut task_cx);
    drop(host_fut);

    let ping = find_span(&rec.spans(), &SpanKind::Client, "pkg.Svc/Ping").expect("ping span");
    assert_eq!(
        span_attr(&ping, "server.address").as_deref(),
        Some("explicit.host")
    );
    assert_eq!(span_attr(&ping, "server.port"), None);
}
