//! Integration tests for `libo11y-connect`: Connect unary (JSON & proto),
//! server streaming, gRPC-Web, canonical log lines (`o11y.request.summary`),
//! W3C propagation, health check filtering, public endpoint linking, outer
//! span nesting, and Tower `ServerLayer` / `ClientLayer`.

use std::sync::{Arc, Mutex};

use buffa_types::google::protobuf::{StringValue, StringValueView};
use connectrpc::client::{
    CallOptions, ClientConfig, HttpClient, ServiceTransport, call_server_stream, call_unary,
};
use connectrpc::{
    ConnectError, ConnectRpcService, ErrorCode, Protocol, RequestContext, Response, Router, Server,
    Spec, StreamType, handler_fn, streaming_handler_fn,
};
use futures_util::stream;
use libo11y::record_from_context;
use libo11y_spec::{Outcome, attr, event};
use libo11y_test::{CapturedLog, Recorder};
use opentelemetry::baggage::BaggageExt as _;
use opentelemetry::trace::{
    FutureExt as _, Span as _, SpanId, SpanKind, Status as SpanStatus, TraceContextExt as _,
    Tracer as _,
};
use opentelemetry::{Context, KeyValue, Value};
use opentelemetry_sdk::trace::SpanData;
use tower::ServiceBuilder;

use libo11y_connect::{ClientLayer, ServerInterceptor, ServerLayer};

const ECHO_PROC: &str = "/test.v1.EchoService/Echo";
const ECHO_METHOD: &str = "test.v1.EchoService/Echo";
const STREAM_PROC: &str = "/test.v1.EchoService/EchoStream";
const STREAM_METHOD: &str = "test.v1.EchoService/EchoStream";
const HEALTH_PROC: &str = "/grpc.health.v1.Health/Check";

const ECHO_CLIENT_SPEC: Spec = Spec::client(ECHO_PROC, StreamType::Unary);
const STREAM_CLIENT_SPEC: Spec = Spec::client(STREAM_PROC, StreamType::ServerStream);
const HEALTH_CLIENT_SPEC: Spec = Spec::client(HEALTH_PROC, StreamType::Unary);

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

fn build_router(rec: &Recorder, captured: CapturedContexts) -> Router {
    let subscriber: Arc<dyn tracing::Subscriber + Send + Sync> = Arc::new(rec.sdk().subscriber());

    let echo_captured = captured.clone();
    let echo_sub = Arc::clone(&subscriber);
    let echo = handler_fn(move |_ctx: RequestContext, req: StringValue| {
        let captured = echo_captured.clone();
        let subscriber = Arc::clone(&echo_sub);
        async move {
            let cx = Context::current();
            captured.push(cx.clone());
            tracing::subscriber::with_default(subscriber, || {
                tracing::info!(echo.value = %req.value, "echo handled");
            });
            match req.value.as_str() {
                "not-found" => Err(ConnectError::not_found("no such thing")),
                "internal" => Err(ConnectError::internal("broken")),
                "record" => {
                    record_from_context(&cx).set("echo.items", 3_i64);
                    Ok(Response::new(req))
                }
                "panic" => panic!("echo panicked"),
                _ => Ok(Response::new(req)),
            }
        }
    });

    let stream_captured = captured.clone();
    let stream_sub = Arc::clone(&subscriber);
    let echo_stream = streaming_handler_fn(move |_ctx: RequestContext, req: StringValue| {
        let captured = stream_captured.clone();
        let subscriber = Arc::clone(&stream_sub);
        async move {
            let cx = Context::current();
            captured.push(cx);
            tracing::subscriber::with_default(subscriber, || {
                tracing::info!(echo.value = %req.value, "stream handled");
            });
            let items: Vec<Result<StringValue, ConnectError>> = match req.value.as_str() {
                "internal" => vec![Err(ConnectError::internal("stream broken"))],
                _ => vec![Ok(req)],
            };
            Ok(Response::new(
                Box::pin(stream::iter(items)) as connectrpc::ServiceStream<StringValue>
            ))
        }
    });

    let health_captured = captured;
    let health = handler_fn(move |_ctx: RequestContext, req: StringValue| {
        let captured = health_captured.clone();
        async move {
            captured.push(Context::current());
            Ok(Response::new(req))
        }
    });

    Router::new()
        .route("test.v1.EchoService", "Echo", echo)
        .route_server_stream("test.v1.EchoService", "EchoStream", echo_stream)
        .route("grpc.health.v1.Health", "Check", health)
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

fn summaries(rec: &Recorder) -> Vec<CapturedLog> {
    rec.logs()
        .into_iter()
        .filter(|l| l.event_name() == Some(event::REQUEST_SUMMARY))
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unary_connect_json_and_proto_record_spans_metrics_propagation_and_triangle() {
    for use_json in [true, false] {
        let rec = Recorder::start("connect-unary");
        let captured = CapturedContexts::default();
        let router = build_router(&rec, captured.clone());
        let service =
            ConnectRpcService::new(router).with_interceptor(ServerInterceptor::new(rec.sdk()));
        let transport = ClientLayer::new(rec.sdk()).wrap_transport(ServiceTransport::new(service));

        let base_uri: http::Uri = "http://echo.internal:8080".parse().expect("uri");
        let config = if use_json {
            ClientConfig::new(base_uri).json()
        } else {
            ClientConfig::new(base_uri).proto()
        };

        let caller_span = rec.sdk().tracer("caller").start("caller");
        let caller_sc = caller_span.span_context().clone();
        let caller_cx = Context::new()
            .with_span(caller_span)
            .with_baggage([KeyValue::new("tenant", "acme")]);

        let resp = async {
            call_unary::<_, StringValue, StringValueView>(
                &transport,
                &config,
                ECHO_CLIENT_SPEC,
                StringValue::from("hi"),
                CallOptions::default(),
            )
            .await
        }
        .with_context(caller_cx.clone())
        .await
        .expect("unary ok");
        assert_eq!(resp.view().value, "hi");
        caller_cx.span().end();

        // Baggage arrived in server handler.
        let cxs = captured.all();
        assert_eq!(cxs.len(), 1);
        assert_eq!(
            cxs[0]
                .baggage()
                .get("tenant")
                .map(ToString::to_string)
                .as_deref(),
            Some("acme")
        );

        let spans = rec.spans();
        let client_span = find_span(&spans, &SpanKind::Client, ECHO_METHOD).expect("client span");
        let server_span = find_span(&spans, &SpanKind::Server, ECHO_METHOD).expect("server span");

        assert_eq!(client_span.span_context.trace_id(), caller_sc.trace_id());
        assert_eq!(client_span.parent_span_id, caller_sc.span_id());
        assert_eq!(server_span.span_context.trace_id(), caller_sc.trace_id());
        assert_eq!(
            server_span.parent_span_id,
            client_span.span_context.span_id()
        );

        for span in [&client_span, &server_span] {
            assert_eq!(
                span_attr(span, "rpc.system.name").as_deref(),
                Some("connectrpc")
            );
            assert_eq!(span_attr(span, "rpc.method").as_deref(), Some(ECHO_METHOD));
            assert_eq!(
                span_attr(span, "rpc.response.status_code").as_deref(),
                Some("OK")
            );
            assert_eq!(
                span_attr(span, "http.response.status_code").as_deref(),
                Some("200")
            );
            assert_eq!(span_attr(span, "error.type"), None);
            assert_eq!(span.status, SpanStatus::Unset);
        }
        assert_eq!(
            span_attr(&client_span, "server.address").as_deref(),
            Some("echo.internal")
        );
        assert_eq!(
            span_attr(&client_span, "server.port").as_deref(),
            Some("8080")
        );

        let names = rec.metric_names();
        assert!(names.contains(&"rpc.server.call.duration".to_owned()));
        assert!(names.contains(&"rpc.client.call.duration".to_owned()));

        let srv_ex = rec.exemplars("rpc.server.call.duration");
        assert!(!srv_ex.is_empty());
        assert_eq!(
            srv_ex[0].span_id,
            server_span.span_context.span_id().to_string()
        );

        rec.assert_conforms();
        rec.assert_correlated();
        rec.assert_triangle("rpc.server.call.duration");
        rec.assert_triangle("rpc.client.call.duration");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canonical_line_summarizes_unary_errors_enrichment_stream_and_grpc_web() {
    let cases = [
        ("hi", "200", "OK", Outcome::Success, false),
        ("not-found", "404", "NOT_FOUND", Outcome::Success, false),
        ("internal", "500", "INTERNAL", Outcome::Failure, true),
    ];

    for (input, want_http, want_rpc, want_outcome, want_server_err) in cases {
        let rec = Recorder::start("connect-canonical");
        let router = build_router(&rec, CapturedContexts::default());
        let service = ConnectRpcService::new(router)
            .with_interceptor(ServerInterceptor::new(rec.sdk()).with_canonical_line());
        let transport = ClientLayer::new(rec.sdk()).wrap_transport(ServiceTransport::new(service));
        let config = ClientConfig::new("http://localhost:8080".parse().expect("uri")).json();

        let _ = call_unary::<_, StringValue, StringValueView>(
            &transport,
            &config,
            ECHO_CLIENT_SPEC,
            StringValue::from(input),
            CallOptions::default(),
        )
        .await;

        let got = summaries(&rec);
        assert_eq!(got.len(), 1, "input={input}");
        let line = &got[0];
        assert_eq!(
            line.attr_str("http.request.method").as_deref(),
            Some("POST")
        );
        assert_eq!(
            line.attr_str("http.response.status_code").as_deref(),
            Some(want_http)
        );
        assert_eq!(
            line.attr_str(attr::OUTCOME).as_deref(),
            Some(want_outcome.as_str())
        );
        assert!(line.attr(attr::DURATION).is_some());
        assert_eq!(
            line.attr_str("rpc.system.name").as_deref(),
            Some("connectrpc")
        );
        assert_eq!(line.attr_str("rpc.method").as_deref(), Some(ECHO_METHOD));
        assert_eq!(
            line.attr_str("rpc.response.status_code").as_deref(),
            Some(want_rpc)
        );

        let server = find_span(&rec.spans(), &SpanKind::Server, ECHO_METHOD).expect("server span");
        let client = find_span(&rec.spans(), &SpanKind::Client, ECHO_METHOD).expect("client span");
        assert_eq!(
            line.span_id().as_deref(),
            Some(server.span_context.span_id().to_string().as_str())
        );
        assert_eq!(
            matches!(server.status, SpanStatus::Error { .. }),
            want_server_err,
            "server span status for {input}"
        );
        assert_eq!(
            span_attr(&client, "rpc.response.status_code").as_deref(),
            Some(want_rpc)
        );
        assert_eq!(
            matches!(client.status, SpanStatus::Error { .. }),
            input != "hi",
            "client span status for {input}"
        );

        rec.assert_conforms();
        rec.assert_correlated();
    }

    // Handler Record enrichment reaches o11y.request.summary.
    let rec = Recorder::start("connect-record");
    let router = build_router(&rec, CapturedContexts::default());
    let service = ConnectRpcService::new(router)
        .with_interceptor(ServerInterceptor::new(rec.sdk()).with_canonical_line());
    let transport = ServiceTransport::new(service);
    let config = ClientConfig::new("http://localhost:8080".parse().expect("uri")).json();

    let _ = call_unary::<_, StringValue, StringValueView>(
        &transport,
        &config,
        ECHO_CLIENT_SPEC,
        StringValue::from("record"),
        CallOptions::default(),
    )
    .await
    .expect("ok");

    let got = summaries(&rec);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].attr_str("echo.items").as_deref(), Some("3"));
    rec.assert_conforms();
    rec.assert_correlated();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn canonical_line_covers_server_streaming_and_grpc_web() {
    // Server streaming error reports HTTP 200 and INTERNAL / failure on canonical line.
    {
        let rec = Recorder::start("connect-stream");
        let router = build_router(&rec, CapturedContexts::default());
        let service = ConnectRpcService::new(router)
            .with_interceptor(ServerInterceptor::new(rec.sdk()).with_canonical_line());
        let transport = ClientLayer::new(rec.sdk()).wrap_transport(ServiceTransport::new(service));
        let config = ClientConfig::new("http://localhost:8080".parse().expect("uri")).json();

        let mut stream = call_server_stream::<_, StringValue, StringValueView>(
            &transport,
            &config,
            STREAM_CLIENT_SPEC,
            StringValue::from("internal"),
            CallOptions::default(),
        )
        .await
        .expect("stream start");
        let err = stream
            .message::<StringValue>()
            .await
            .expect_err("stream internal");
        assert_eq!(err.code, ErrorCode::Internal);

        let got = summaries(&rec);
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].attr_str("http.response.status_code").as_deref(),
            Some("200")
        );
        assert_eq!(
            got[0].attr_str("rpc.response.status_code").as_deref(),
            Some("INTERNAL")
        );
        assert_eq!(
            got[0].attr_str(attr::OUTCOME).as_deref(),
            Some(Outcome::Failure.as_str())
        );
        assert_eq!(
            got[0].attr_str("rpc.method").as_deref(),
            Some(STREAM_METHOD)
        );
        rec.assert_conforms();
        rec.assert_correlated();
    }

    // gRPC-Web unary error reports rpc.system.name="grpc", HTTP 200, NOT_FOUND, outcome="success".
    {
        let rec = Recorder::start("connect-grpc-web");
        let router = build_router(&rec, CapturedContexts::default());
        let service = ConnectRpcService::new(router)
            .with_interceptor(ServerInterceptor::new(rec.sdk()).with_canonical_line());
        let transport = ClientLayer::new(rec.sdk()).wrap_transport(ServiceTransport::new(service));
        let config = ClientConfig::new("http://localhost:8080".parse().expect("uri"))
            .with_protocol(Protocol::GrpcWeb);

        let err = call_unary::<_, StringValue, StringValueView>(
            &transport,
            &config,
            ECHO_CLIENT_SPEC,
            StringValue::from("not-found"),
            CallOptions::default(),
        )
        .await
        .expect_err("not found");
        assert_eq!(err.code, ErrorCode::NotFound);

        let got = summaries(&rec);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].attr_str("rpc.system.name").as_deref(), Some("grpc"));
        assert_eq!(
            got[0].attr_str("http.response.status_code").as_deref(),
            Some("200")
        );
        assert_eq!(
            got[0].attr_str("rpc.response.status_code").as_deref(),
            Some("NOT_FOUND")
        );
        assert_eq!(
            got[0].attr_str(attr::OUTCOME).as_deref(),
            Some(Outcome::Success.as_str())
        );
        let client_span = find_span(&rec.spans(), &SpanKind::Client, ECHO_METHOD).expect("client");
        assert_eq!(
            span_attr(&client_span, "rpc.system.name").as_deref(),
            Some("grpc")
        );
        assert_eq!(
            span_attr(&client_span, "rpc.response.status_code").as_deref(),
            Some("NOT_FOUND")
        );
        rec.assert_conforms();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panic_marks_server_span_error_and_emits_failure_canonical_line() {
    let rec = Recorder::start("connect-panic");
    let router = build_router(&rec, CapturedContexts::default());
    let service = ConnectRpcService::new(router)
        .with_interceptor(ServerInterceptor::new(rec.sdk()).with_canonical_line());
    let transport = ServiceTransport::new(service);
    let config = ClientConfig::new("http://localhost:8080".parse().expect("uri")).json();

    let join = tokio::spawn(async move {
        let _ = call_unary::<_, StringValue, StringValueView>(
            &transport,
            &config,
            ECHO_CLIENT_SPEC,
            StringValue::from("panic"),
            CallOptions::default(),
        )
        .await;
    })
    .await;
    assert!(join.is_err(), "panic must propagate");

    let got = summaries(&rec);
    assert_eq!(got.len(), 1);
    assert_eq!(
        got[0].attr_str("http.response.status_code").as_deref(),
        Some("500")
    );
    assert_eq!(
        got[0].attr_str("rpc.response.status_code").as_deref(),
        Some("INTERNAL")
    );
    assert_eq!(
        got[0].attr_str(attr::OUTCOME).as_deref(),
        Some(Outcome::Failure.as_str())
    );

    let server = find_span(&rec.spans(), &SpanKind::Server, ECHO_METHOD).expect("server span");
    assert!(matches!(server.status, SpanStatus::Error { .. }));
    assert_eq!(
        got[0].span_id().as_deref(),
        Some(server.span_context.span_id().to_string().as_str())
    );
    rec.assert_conforms();
    rec.assert_correlated();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ignore_health_checks_skips_spans_metrics_and_summaries() {
    let rec = Recorder::start("connect-health");
    let router = build_router(&rec, CapturedContexts::default());
    let service = ConnectRpcService::new(router).with_interceptor(
        ServerInterceptor::new(rec.sdk())
            .with_ignore_health_checks()
            .with_canonical_line(),
    );
    let transport = ClientLayer::new(rec.sdk())
        .with_ignore_health_checks()
        .wrap_transport(ServiceTransport::new(service));
    let config = ClientConfig::new("http://localhost:8080".parse().expect("uri")).json();

    let _ = call_unary::<_, StringValue, StringValueView>(
        &transport,
        &config,
        HEALTH_CLIENT_SPEC,
        StringValue::from("probe"),
        CallOptions::default(),
    )
    .await
    .expect("health ok");

    assert!(rec.spans().is_empty());
    assert!(summaries(&rec).is_empty());
    assert!(
        !rec.metric_names()
            .contains(&"rpc.server.call.duration".to_owned())
    );
    assert!(
        !rec.metric_names()
            .contains(&"rpc.client.call.duration".to_owned())
    );

    // Regular RPC still recorded.
    let _ = call_unary::<_, StringValue, StringValueView>(
        &transport,
        &config,
        ECHO_CLIENT_SPEC,
        StringValue::from("hi"),
        CallOptions::default(),
    )
    .await
    .expect("echo ok");
    assert_eq!(rec.spans().len(), 2);
    assert_eq!(summaries(&rec).len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn public_endpoint_links_and_outer_span_decides_trust() {
    // 1. Public endpoint starts new root trace with one link to client span and adopts baggage.
    // Run over loopback TCP so the server does not inherit the client's in-thread Context.
    {
        let rec = Recorder::start("connect-public");
        let captured = CapturedContexts::default();
        let router = build_router(&rec, captured.clone());
        let service = ConnectRpcService::new(router)
            .with_interceptor(ServerInterceptor::new(rec.sdk()).with_public_endpoint());
        let bound = Server::bind("127.0.0.1:0").await.expect("bind");
        let addr = bound.local_addr().expect("local_addr");
        let srv_handle = tokio::spawn(async move {
            let _ = bound.serve_with_service(service).await;
        });

        let transport = ClientLayer::new(rec.sdk()).wrap_transport(HttpClient::plaintext());
        let config = ClientConfig::new(format!("http://{addr}").parse().expect("uri")).json();

        let caller_span = rec.sdk().tracer("caller").start("edge");
        let caller_cx = Context::new()
            .with_span(caller_span)
            .with_baggage([KeyValue::new("tenant", "acme")]);

        let _ = async {
            call_unary::<_, StringValue, StringValueView>(
                &transport,
                &config,
                ECHO_CLIENT_SPEC,
                StringValue::from("hi"),
                CallOptions::default(),
            )
            .await
        }
        .with_context(caller_cx.clone())
        .await
        .expect("ok");
        caller_cx.span().end();
        srv_handle.abort();

        let spans = rec.spans();
        let client = find_span(&spans, &SpanKind::Client, ECHO_METHOD).expect("client");
        let server = find_span(&spans, &SpanKind::Server, ECHO_METHOD).expect("server");
        assert_eq!(server.parent_span_id, SpanId::INVALID);
        assert_ne!(
            server.span_context.trace_id(),
            client.span_context.trace_id()
        );
        assert_eq!(server.links.links.len(), 1);
        assert_eq!(
            server.links.links[0].span_context.span_id(),
            client.span_context.span_id()
        );
        assert_eq!(
            captured.all()[0]
                .baggage()
                .get("tenant")
                .map(ToString::to_string)
                .as_deref(),
            Some("acme")
        );
    }

    // 3. Behind an outer span (simulating HTTP middleware), outer layer decides trust.
    {
        let rec = Recorder::start("connect-outer-span");
        let router = build_router(&rec, CapturedContexts::default());
        let service = ConnectRpcService::new(router)
            .with_interceptor(ServerInterceptor::new(rec.sdk()).with_public_endpoint());
        let transport = ServiceTransport::new(service);
        let config = ClientConfig::new("http://localhost:8080".parse().expect("uri")).json();

        let outer_span = rec.sdk().tracer("http").start("POST /rpc");
        let outer_sc = outer_span.span_context().clone();
        let outer_cx = Context::new().with_span(outer_span);

        let _ = async {
            call_unary::<_, StringValue, StringValueView>(
                &transport,
                &config,
                ECHO_CLIENT_SPEC,
                StringValue::from("hi"),
                CallOptions::default(),
            )
            .await
        }
        .with_context(outer_cx.clone())
        .await
        .expect("ok");
        outer_cx.span().end();

        let rpc = find_span(&rec.spans(), &SpanKind::Server, ECHO_METHOD).expect("rpc span");
        assert_eq!(rpc.span_context.trace_id(), outer_sc.trace_id());
        assert_eq!(rpc.parent_span_id, outer_sc.span_id());
        assert!(rpc.links.links.is_empty());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tower_server_layer_and_client_layer_work_over_real_tcp_and_service_transport() {
    // 1. Tower ServerLayer + ClientLayer over ServiceTransport (in-process).
    {
        let rec = Recorder::start("connect-tower-layers");
        let router = build_router(&rec, CapturedContexts::default());
        let inner = ConnectRpcService::new(router);
        let stacked = ServiceBuilder::new()
            .layer(ClientLayer::new(rec.sdk()))
            .layer(ServerLayer::new(rec.sdk()).with_canonical_line())
            .service(inner);
        let transport = ServiceTransport::new(stacked);
        let config = ClientConfig::new("http://api.local:9000".parse().expect("uri")).json();

        let resp = call_unary::<_, StringValue, StringValueView>(
            &transport,
            &config,
            ECHO_CLIENT_SPEC,
            StringValue::from("record"),
            CallOptions::default(),
        )
        .await
        .expect("ok");
        assert_eq!(resp.view().value, "record");

        let got = summaries(&rec);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].attr_str("echo.items").as_deref(), Some("3"));
        assert_eq!(
            got[0].attr_str("rpc.response.status_code").as_deref(),
            Some("OK")
        );

        let spans = rec.spans();
        assert!(find_span(&spans, &SpanKind::Client, ECHO_METHOD).is_some());
        assert!(find_span(&spans, &SpanKind::Server, ECHO_METHOD).is_some());
        rec.assert_conforms();
        rec.assert_correlated();
        rec.assert_triangle("rpc.server.call.duration");
        rec.assert_triangle("rpc.client.call.duration");
    }

    // 2. Real loopback TCP Connect server + HttpClient wrapped by ClientLayer::wrap_transport.
    {
        let rec = Recorder::start("connect-tcp");
        let router = build_router(&rec, CapturedContexts::default());
        let service = ConnectRpcService::new(router)
            .with_interceptor(ServerInterceptor::new(rec.sdk()).with_canonical_line());
        let bound = Server::bind("127.0.0.1:0").await.expect("bind");
        let addr = bound.local_addr().expect("local_addr");
        let srv_handle = tokio::spawn(async move {
            let _ = bound.serve_with_service(service).await;
        });

        let http = ClientLayer::new(rec.sdk()).wrap_transport(HttpClient::plaintext());
        let config = ClientConfig::new(format!("http://{addr}").parse().expect("uri")).json();

        let resp = call_unary::<_, StringValue, StringValueView>(
            &http,
            &config,
            ECHO_CLIENT_SPEC,
            StringValue::from("hello-tcp"),
            CallOptions::default(),
        )
        .await
        .expect("tcp ok");
        assert_eq!(resp.view().value, "hello-tcp");

        srv_handle.abort();

        let spans = rec.spans();
        let client = find_span(&spans, &SpanKind::Client, ECHO_METHOD).expect("client");
        let server = find_span(&spans, &SpanKind::Server, ECHO_METHOD).expect("server");
        assert_eq!(server.parent_span_id, client.span_context.span_id());
        assert_eq!(summaries(&rec).len(), 1);
        rec.assert_conforms();
        rec.assert_correlated();
        rec.assert_triangle("rpc.server.call.duration");
        rec.assert_triangle("rpc.client.call.duration");
    }
}
