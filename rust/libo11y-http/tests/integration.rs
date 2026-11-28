//! Integration tests for `libo11y-http` verifying full Go `o11yhttp` parity,
//! OpenTelemetry HTTP semantic conventions 1.41.0, W3C propagation, canonical
//! log lines, panic handling, correlation triangles, and optional `axum`
//! `MatchedPath` extraction.

use std::convert::Infallible;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex};

use http::header::{HOST, USER_AGENT};
use http::{Method, Request, Response, StatusCode};
use libo11y::record_from_context;
use libo11y_http::{ClientLayer, ServerLayer};
use libo11y_spec::{Outcome, attr, event};
use libo11y_test::Recorder;
use opentelemetry::baggage::BaggageExt as _;
use opentelemetry::context::FutureExt as _;
use opentelemetry::trace::{SpanKind, Status, TraceContextExt as _, Tracer as _};
use opentelemetry::{Context as OtelContext, KeyValue, Value};
use tower::{Layer as _, Service, ServiceExt as _, service_fn};
use tracing::instrument::WithSubscriber as _;

fn span_attr(span: &libo11y::opentelemetry_sdk::trace::SpanData, key: &str) -> Option<String> {
    span.attributes
        .iter()
        .find(|kv| kv.key.as_str() == key)
        .map(|kv| match &kv.value {
            Value::String(s) => s.as_str().to_owned(),
            other => other.to_string(),
        })
}

#[tokio::test]
async fn server_span_semconv_route_naming_and_query_redaction() {
    let rec = Recorder::start("http-server-semconv");
    let layer = ServerLayer::new(rec.sdk())
        .with_operation_name("fallback-op")
        .with_route_extractor(|parts| {
            parts
                .uri
                .path()
                .starts_with("/users/")
                .then(|| "/users/{id}".to_owned())
        });

    let mut svc = layer.layer(service_fn(|_req: Request<()>| async {
        Ok::<_, Infallible>(
            Response::builder()
                .status(StatusCode::CREATED)
                .body(())
                .unwrap(),
        )
    }));

    let req = Request::builder()
        .method(Method::GET)
        .uri("https://api.example.com:8443/users/42?page=1&api_key=supersecret")
        .header(USER_AGENT, "libo11y-test-agent/1.0")
        .body(())
        .unwrap();

    let resp = svc.ready().await.unwrap().call(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    let span = &spans[0];
    assert_eq!(span.name.as_ref(), "GET /users/{id}");
    assert_eq!(span.span_kind, SpanKind::Server);
    assert_eq!(span.status, Status::Unset);
    assert_eq!(
        span_attr(span, "http.request.method").as_deref(),
        Some("GET")
    );
    assert_eq!(span_attr(span, "http.request.method_original"), None);
    assert_eq!(
        span_attr(span, "http.route").as_deref(),
        Some("/users/{id}")
    );
    assert_eq!(span_attr(span, "url.scheme").as_deref(), Some("https"));
    assert_eq!(span_attr(span, "url.path").as_deref(), Some("/users/42"));
    assert_eq!(
        span_attr(span, "url.query").as_deref(),
        Some("page=1&api_key=REDACTED")
    );
    assert_eq!(
        span_attr(span, "user_agent.original").as_deref(),
        Some("libo11y-test-agent/1.0")
    );
    assert_eq!(
        span_attr(span, "server.address").as_deref(),
        Some("api.example.com")
    );
    assert_eq!(span_attr(span, "server.port").as_deref(), Some("8443"));
    assert_eq!(
        span_attr(span, "http.response.status_code").as_deref(),
        Some("201")
    );
    assert_eq!(span_attr(span, "error.type"), None);

    assert!(
        rec.metric_names()
            .contains(&"http.server.request.duration".to_owned())
    );
    rec.assert_conforms();
}

#[tokio::test]
async fn server_5xx_sets_error_type_and_status_while_4xx_leaves_span_unset() {
    let rec = Recorder::start("http-server-status");
    let layer = ServerLayer::new(rec.sdk());

    let mut svc = layer.layer(service_fn(|req: Request<()>| async move {
        let status = if req.uri().path() == "/missing" {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        };
        Ok::<_, Infallible>(Response::builder().status(status).body(()).unwrap())
    }));

    let req404 = Request::builder()
        .uri("/missing")
        .header(HOST, "svc.local")
        .body(())
        .unwrap();
    let _ = svc.ready().await.unwrap().call(req404).await.unwrap();

    let req503 = Request::builder()
        .uri("/boom")
        .header(HOST, "svc.local")
        .body(())
        .unwrap();
    let _ = svc.ready().await.unwrap().call(req503).await.unwrap();

    let spans = rec.spans();
    assert_eq!(spans.len(), 2);

    assert_eq!(spans[0].status, Status::Unset);
    assert_eq!(
        span_attr(&spans[0], "http.response.status_code").as_deref(),
        Some("404")
    );
    assert_eq!(span_attr(&spans[0], "error.type"), None);

    assert!(matches!(spans[1].status, Status::Error { .. }));
    assert_eq!(
        span_attr(&spans[1], "http.response.status_code").as_deref(),
        Some("503")
    );
    assert_eq!(span_attr(&spans[1], "error.type").as_deref(), Some("503"));
}

#[tokio::test]
async fn server_normalizes_unknown_and_lowercase_methods() {
    let rec = Recorder::start("http-server-methods");
    let layer = ServerLayer::new(rec.sdk())
        .with_canonical_line()
        .with_route_extractor(|_| Some("/items/{id}".to_owned()));

    let mut svc = layer.layer(service_fn(|_req: Request<()>| async {
        Ok::<_, Infallible>(Response::new(()))
    }));

    let custom = Request::builder()
        .method(Method::from_bytes(b"XQZ123").unwrap())
        .uri("/items/7")
        .body(())
        .unwrap();
    let _ = svc.ready().await.unwrap().call(custom).await.unwrap();

    let lower = Request::builder()
        .method(Method::from_bytes(b"get").unwrap())
        .uri("/items/8")
        .body(())
        .unwrap();
    let _ = svc.ready().await.unwrap().call(lower).await.unwrap();

    let spans = rec.spans();
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[0].name.as_ref(), "HTTP /items/{id}");
    assert_eq!(
        span_attr(&spans[0], "http.request.method").as_deref(),
        Some("_OTHER")
    );
    assert_eq!(
        span_attr(&spans[0], "http.request.method_original").as_deref(),
        Some("XQZ123")
    );

    assert_eq!(spans[1].name.as_ref(), "GET /items/{id}");
    assert_eq!(
        span_attr(&spans[1], "http.request.method").as_deref(),
        Some("GET")
    );
    assert_eq!(
        span_attr(&spans[1], "http.request.method_original").as_deref(),
        Some("get")
    );

    let logs = rec.logs();
    assert_eq!(logs.len(), 2);
    assert_eq!(
        logs[0].attr_str("http.request.method").as_deref(),
        Some("_OTHER")
    );
    assert_eq!(
        logs[0].attr_str("http.request.method_original").as_deref(),
        Some("XQZ123")
    );
    assert_eq!(
        logs[1].attr_str("http.request.method").as_deref(),
        Some("GET")
    );
    assert_eq!(
        logs[1].attr_str("http.request.method_original").as_deref(),
        Some("get")
    );
    rec.assert_conforms();
}

#[tokio::test]
async fn server_public_endpoint_starts_new_root_links_remote_and_preserves_baggage() {
    const INBOUND_TRACE: &str = "0af7651916cd43dd8448eb211c80319c";
    const INBOUND_SPAN: &str = "b7ad6b7169203331";

    let rec = Recorder::start("http-public-endpoint");
    let captured_baggage = Arc::new(Mutex::new(None::<String>));
    let bag_clone = Arc::clone(&captured_baggage);

    let layer = ServerLayer::new(rec.sdk()).with_public_endpoint();
    let mut svc = layer.layer(service_fn(move |_req: Request<()>| {
        let bag_clone = Arc::clone(&bag_clone);
        async move {
            let cx = OtelContext::current();
            let val = cx.baggage().get("tenant").map(ToString::to_string);
            *bag_clone.lock().unwrap() = val;
            Ok::<_, Infallible>(Response::new(()))
        }
    }));

    let req = Request::builder()
        .uri("/public")
        .header(
            "traceparent",
            format!("00-{INBOUND_TRACE}-{INBOUND_SPAN}-01"),
        )
        .header("baggage", "tenant=acme")
        .body(())
        .unwrap();

    let _ = svc.ready().await.unwrap().call(req).await.unwrap();

    assert_eq!(captured_baggage.lock().unwrap().as_deref(), Some("acme"));

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    let span = &spans[0];
    // Must be a new root, not continuing the untrusted caller's trace.
    assert_ne!(span.span_context.trace_id().to_string(), INBOUND_TRACE);
    assert_eq!(span.parent_span_id, opentelemetry::trace::SpanId::INVALID);

    // Must carry exactly one link pointing to the remote inbound SpanContext with no attributes.
    assert_eq!(span.links.links.len(), 1);
    let link = &span.links.links[0];
    assert_eq!(link.span_context.trace_id().to_string(), INBOUND_TRACE);
    assert_eq!(link.span_context.span_id().to_string(), INBOUND_SPAN);
    assert!(link.span_context.is_remote());
    assert!(link.attributes.is_empty());
}

#[tokio::test]
async fn server_ignore_paths_and_filters_exclude_matching_requests() {
    let rec = Recorder::start("http-server-filters");
    let layer = ServerLayer::new(rec.sdk())
        .with_canonical_line()
        .with_ignore_paths(["/healthz", "/debug/*", "[malformed"])
        .with_filter(|parts| !parts.headers.contains_key("x-skip"))
        .with_filter(|parts| parts.method != Method::OPTIONS);

    let mut svc = layer.layer(service_fn(|_req: Request<()>| async {
        Ok::<_, Infallible>(Response::new(()))
    }));

    let requests = [
        Request::builder().uri("/healthz").body(()).unwrap(),
        Request::builder().uri("/debug/vars").body(()).unwrap(),
        Request::builder()
            .uri("/work")
            .header("x-skip", "1")
            .body(())
            .unwrap(),
        Request::builder()
            .method(Method::OPTIONS)
            .uri("/work")
            .body(())
            .unwrap(),
        Request::builder().uri("/work").body(()).unwrap(),
    ];

    for req in requests {
        let _ = svc.ready().await.unwrap().call(req).await.unwrap();
    }

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(span_attr(&spans[0], "url.path").as_deref(), Some("/work"));
    assert_eq!(rec.logs().len(), 1);
}

#[tokio::test]
async fn server_ignore_paths_match_the_percent_decoded_path() {
    let rec = Recorder::start("http-server-ignore-decoded");
    let layer = ServerLayer::new(rec.sdk()).with_ignore_paths(["/healthz", "/debug/*"]);
    let mut svc = layer.layer(service_fn(|_req: Request<()>| async {
        Ok::<_, Infallible>(Response::new(String::new()))
    }));

    for uri in ["/%68ealthz", "/debug/%76ars", "/bad%zz", "/work"] {
        let req = Request::builder().uri(uri).body(()).unwrap();
        let _ = svc.ready().await.unwrap().call(req).await.unwrap();
    }

    let spans = rec.spans();
    let paths: Vec<_> = spans.iter().map(|s| span_attr(s, "url.path")).collect();
    assert_eq!(
        paths,
        [Some("/bad%zz".to_owned()), Some("/work".to_owned())],
        "encoded ignored paths must be excluded, an invalid escape falls back to the raw path"
    );
}

#[tokio::test]
async fn client_ignore_paths_match_the_percent_decoded_path() {
    let rec = Recorder::start("http-client-ignore-decoded");
    let mut client_svc = ClientLayer::new(rec.sdk())
        .with_ignore_paths(["/healthz"])
        .layer(service_fn(|_req: Request<()>| async {
            Ok::<_, Infallible>(Response::new(()))
        }));

    for uri in ["http://example.com/%68ealthz", "http://example.com/ok"] {
        let req = Request::builder().uri(uri).body(()).unwrap();
        let _ = client_svc.ready().await.unwrap().call(req).await.unwrap();
    }

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(
        span_attr(&spans[0], "url.full").as_deref(),
        Some("http://example.com/ok")
    );
}

#[tokio::test]
async fn server_canonical_line_enriches_record_and_passes_triangle_and_conformance() {
    let rec = Recorder::start("http-canonical-line");
    let layer = ServerLayer::new(rec.sdk())
        .with_canonical_line()
        .with_route_extractor(|_| Some("GET /orders/{id}".to_owned()));

    let mut svc = layer.layer(service_fn(|_req: Request<()>| async {
        let record = record_from_context(&OtelContext::current());
        record.set("order.id", "42");
        record.add("order.items", 3);
        tracing::info!(order.id = "42", "handled order");
        Ok::<_, Infallible>(Response::new(()))
    }));

    let req = Request::builder().uri("/orders/42").body(()).unwrap();
    let _ = svc
        .ready()
        .await
        .unwrap()
        .call(req)
        .with_subscriber(rec.sdk().subscriber())
        .await
        .unwrap();

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].name.as_ref(), "GET /orders/{id}");
    assert_eq!(
        span_attr(&spans[0], "http.route").as_deref(),
        Some("/orders/{id}")
    );

    let logs = rec.logs();
    let summary = logs
        .iter()
        .find(|l| l.event_name() == Some(event::REQUEST_SUMMARY))
        .expect("o11y.request.summary event emitted");
    assert_eq!(
        summary.attr_str("http.request.method").as_deref(),
        Some("GET")
    );
    assert_eq!(
        summary.attr_str("http.response.status_code").as_deref(),
        Some("200")
    );
    assert_eq!(
        summary.attr_str(attr::OUTCOME).as_deref(),
        Some(Outcome::Success.as_str())
    );
    assert!(summary.attr(attr::DURATION).is_some());
    assert_eq!(
        summary.attr_str("http.route").as_deref(),
        Some("/orders/{id}")
    );
    assert_eq!(summary.attr_str("order.id").as_deref(), Some("42"));
    assert_eq!(summary.attr_str("order.items").as_deref(), Some("3"));

    rec.assert_conforms();
    rec.assert_correlated();
    rec.assert_triangle("http.server.request.duration");
}

#[tokio::test]
async fn server_records_panic_during_poll_and_call_and_resumes_unwind() {
    for canonical in [false, true] {
        let rec = Recorder::start("http-panic-poll");
        let mut layer = ServerLayer::new(rec.sdk());
        if canonical {
            layer = layer.with_canonical_line();
        }
        let mut svc = layer.layer(service_fn(|_req: Request<()>| async {
            panic!("handler exploded");
            #[allow(unreachable_code)]
            Ok::<_, Infallible>(Response::new(()))
        }));

        let fut = svc
            .ready()
            .await
            .unwrap()
            .call(Request::builder().uri("/boom").body(()).unwrap());
        let res = futures_catch_unwind(fut).await;
        assert!(res.is_err(), "panic must propagate");

        let spans = rec.spans();
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].status, Status::error("panic"));
        assert_eq!(span_attr(&spans[0], "error.type").as_deref(), Some("panic"));

        if canonical {
            let logs = rec.logs();
            assert_eq!(logs.len(), 1);
            assert_eq!(logs[0].event_name(), Some(event::REQUEST_SUMMARY));
            assert_eq!(
                logs[0].attr_str("http.response.status_code").as_deref(),
                Some("500")
            );
            assert_eq!(
                logs[0].attr_str(attr::OUTCOME).as_deref(),
                Some(Outcome::Failure.as_str())
            );
            rec.assert_conforms();
            rec.assert_correlated();
        }
    }

    // Synchronous panic inside `Service::call` before returning a future.
    let rec = Recorder::start("http-panic-sync");
    let layer = ServerLayer::new(rec.sdk()).with_canonical_line();
    let mut svc = layer.layer(service_fn(
        |_req: Request<()>| -> std::future::Ready<Result<Response<()>, Infallible>> {
            panic!("sync call panic");
        },
    ));
    let caught = std::panic::catch_unwind(AssertUnwindSafe(|| {
        drop(svc.call(Request::builder().uri("/sync-boom").body(()).unwrap()));
    }));
    assert!(caught.is_err(), "sync panic must propagate");
    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].status, Status::error("panic"));
    assert_eq!(rec.logs().len(), 1);
    assert_eq!(
        rec.logs()[0].attr_str(attr::OUTCOME).as_deref(),
        Some(Outcome::Failure.as_str())
    );
}

#[tokio::test]
async fn filtered_panic_leaves_outer_span_untouched() {
    let rec = Recorder::start("http-filtered-panic");
    let layer = ServerLayer::new(rec.sdk())
        .with_canonical_line()
        .with_ignore_paths(["/healthz"]);
    let mut svc = layer.layer(service_fn(|_req: Request<()>| async {
        panic!("probe boom");
        #[allow(unreachable_code)]
        Ok::<_, Infallible>(Response::new(()))
    }));

    let outer = rec.sdk().tracer("outer").start("outer");
    let outer_cx = OtelContext::current_with_span(outer);
    let fut = async move {
        svc.ready()
            .await
            .unwrap()
            .call(Request::builder().uri("/healthz").body(()).unwrap())
            .await
    }
    .with_context(outer_cx.clone());
    let _ = futures_catch_unwind(fut).await;
    outer_cx.span().end();

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].name.as_ref(), "outer");
    assert_eq!(spans[0].status, Status::Unset);
    assert!(rec.logs().is_empty());
}

#[tokio::test]
async fn client_to_server_propagates_trace_and_baggage_and_satisfies_triangles() {
    let rec = Recorder::start("http-client-server");
    let observed_baggage = Arc::new(Mutex::new(None::<String>));
    let bag_clone = Arc::clone(&observed_baggage);

    let server_svc = ServerLayer::new(rec.sdk())
        .with_canonical_line()
        .with_route_extractor(|_| Some("/widgets/{id}".to_owned()))
        .layer(service_fn(move |_req: Request<()>| {
            let bag_clone = Arc::clone(&bag_clone);
            async move {
                let cx = OtelContext::current();
                *bag_clone.lock().unwrap() = cx.baggage().get("tenant").map(ToString::to_string);
                Ok::<_, Infallible>(Response::builder().status(StatusCode::OK).body(()).unwrap())
            }
        }));

    let mut client_svc = ClientLayer::new(rec.sdk())
        .with_ignore_paths(["/healthz"])
        .layer(server_svc);

    let parent_span = rec.sdk().tracer("caller").start("caller-op");
    let parent_cx =
        OtelContext::current_with_span(parent_span).with_baggage([KeyValue::new("tenant", "acme")]);

    let req = Request::builder()
        .method(Method::POST)
        .uri("https://user:pass@widgets.internal:8443/widgets/9?api_key=secret&kind=cog")
        .body(())
        .unwrap();

    let resp = async {
        let r = client_svc.ready().await.unwrap().call(req).await.unwrap();
        tracing::info!("outbound completed");
        r
    }
    .with_context(parent_cx.clone())
    .with_subscriber(rec.sdk().subscriber())
    .await;
    parent_cx.span().end();

    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(observed_baggage.lock().unwrap().as_deref(), Some("acme"));

    let spans = rec.spans();
    let client_span = spans
        .iter()
        .find(|s| s.span_kind == SpanKind::Client)
        .expect("client span");
    let server_span = spans
        .iter()
        .find(|s| s.span_kind == SpanKind::Server)
        .expect("server span");

    assert_eq!(client_span.name.as_ref(), "POST");
    assert_eq!(
        span_attr(client_span, "url.full").as_deref(),
        Some("https://widgets.internal:8443/widgets/9?api_key=REDACTED&kind=cog")
    );
    assert_eq!(
        span_attr(client_span, "server.address").as_deref(),
        Some("widgets.internal")
    );
    assert_eq!(
        span_attr(client_span, "server.port").as_deref(),
        Some("8443")
    );
    assert_eq!(
        span_attr(client_span, "http.response.status_code").as_deref(),
        Some("200")
    );

    assert_eq!(
        server_span.span_context.trace_id(),
        client_span.span_context.trace_id()
    );
    assert_eq!(
        server_span.parent_span_id,
        client_span.span_context.span_id()
    );

    rec.assert_conforms();
    rec.assert_correlated();
    rec.assert_triangle("http.server.request.duration");
    rec.assert_triangle("http.client.request.duration");
}

#[tokio::test]
async fn client_marks_4xx_as_error_and_honors_filters() {
    let rec = Recorder::start("http-client-errors");
    let mut client_svc = ClientLayer::new(rec.sdk())
        .with_ignore_paths(["/skip/*"])
        .with_filter(|parts| !parts.headers.contains_key("x-no-trace"))
        .layer(service_fn(|_req: Request<()>| async {
            Ok::<_, Infallible>(
                Response::builder()
                    .status(StatusCode::BAD_REQUEST)
                    .body(())
                    .unwrap(),
            )
        }));

    // Ignored by path.
    let _ = client_svc
        .ready()
        .await
        .unwrap()
        .call(
            Request::builder()
                .uri("http://example.com/skip/me")
                .body(())
                .unwrap(),
        )
        .await
        .unwrap();
    // Ignored by predicate.
    let _ = client_svc
        .ready()
        .await
        .unwrap()
        .call(
            Request::builder()
                .uri("http://example.com/ok")
                .header("x-no-trace", "1")
                .body(())
                .unwrap(),
        )
        .await
        .unwrap();
    // Instrumented 400.
    let _ = client_svc
        .ready()
        .await
        .unwrap()
        .call(
            Request::builder()
                .uri("http://example.com/bad")
                .body(())
                .unwrap(),
        )
        .await
        .unwrap();

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(
        span_attr(&spans[0], "http.response.status_code").as_deref(),
        Some("400")
    );
    assert_eq!(span_attr(&spans[0], "error.type").as_deref(), Some("400"));
    assert!(matches!(spans[0].status, Status::Error { .. }));
}

#[cfg(feature = "axum")]
#[tokio::test]
async fn axum_router_automatically_extracts_matched_path() {
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;

    let rec = Recorder::start("http-axum-matched-path");
    let app = Router::new()
        .route(
            "/users/{id}",
            get(|| async {
                let record = record_from_context(&OtelContext::current());
                record.set("user.found", true);
                "ok"
            }),
        )
        .layer(ServerLayer::new(rec.sdk()).with_canonical_line());

    let req = Request::builder()
        .method(Method::GET)
        .uri("/users/99")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].name.as_ref(), "GET /users/{id}");
    assert_eq!(
        span_attr(&spans[0], "http.route").as_deref(),
        Some("/users/{id}")
    );
    assert_eq!(
        span_attr(&spans[0], "url.path").as_deref(),
        Some("/users/99")
    );

    let logs = rec.logs();
    assert_eq!(logs.len(), 1);
    assert_eq!(
        logs[0].attr_str("http.route").as_deref(),
        Some("/users/{id}")
    );
    assert_eq!(logs[0].attr_str("user.found").as_deref(), Some("true"));

    rec.assert_conforms();
    rec.assert_correlated();
    rec.assert_triangle("http.server.request.duration");
}

#[cfg(feature = "axum")]
#[tokio::test]
async fn custom_route_extractor_takes_precedence_over_axum_matched_path() {
    use axum::Router;
    use axum::body::Body;
    use axum::routing::get;

    let rec = Recorder::start("http-axum-custom-extractor");
    let app = Router::new()
        .route("/users/{id}", get(|| async { "ok" }))
        .route("/items/{id}", get(|| async { "ok" }))
        .route_layer(ServerLayer::new(rec.sdk()).with_route_extractor(|parts| {
            parts
                .uri
                .path()
                .starts_with("/users/")
                .then(|| "/custom/route".to_owned())
        }));

    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/users/12")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // When the custom extractor returns None, axum's MatchedPath is used.
    let resp2 = app
        .oneshot(
            Request::builder()
                .uri("/items/34")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp2.status(), StatusCode::OK);

    let spans = rec.spans();
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[0].name.as_ref(), "GET /custom/route");
    assert_eq!(
        span_attr(&spans[0], "http.route").as_deref(),
        Some("/custom/route")
    );
    assert_eq!(spans[1].name.as_ref(), "GET /items/{id}");
    assert_eq!(
        span_attr(&spans[1], "http.route").as_deref(),
        Some("/items/{id}")
    );
}

#[tokio::test]
async fn server_and_client_record_service_errors_and_histogram_boundaries() {
    use libo11y::opentelemetry_proto::tonic::metrics::v1::metric::Data;

    #[derive(Debug)]
    struct DownstreamErr;

    let rec = Recorder::start("http-service-errors");
    let mut server_svc = ServerLayer::new(rec.sdk())
        .with_canonical_line()
        .with_operation_name("orders-op")
        .layer(service_fn(|_req: Request<()>| async {
            Err::<Response<()>, DownstreamErr>(DownstreamErr)
        }));

    let err = server_svc
        .ready()
        .await
        .unwrap()
        .call(Request::builder().uri("/err").body(()).unwrap())
        .await;
    assert!(err.is_err());

    let mut client_svc = ClientLayer::new(rec.sdk()).layer(service_fn(|_req: Request<()>| async {
        Err::<Response<()>, DownstreamErr>(DownstreamErr)
    }));
    let cerr = client_svc
        .ready()
        .await
        .unwrap()
        .call(
            Request::builder()
                .uri("http://example.com/err")
                .body(())
                .unwrap(),
        )
        .await;
    assert!(cerr.is_err());

    let spans = rec.spans();
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[0].name.as_ref(), "orders-op");
    assert!(matches!(spans[0].status, Status::Error { .. }));
    assert!(span_attr(&spans[0], "error.type").is_some());
    assert!(matches!(spans[1].status, Status::Error { .. }));
    assert!(span_attr(&spans[1], "error.type").is_some());

    // Canonical line recorded failure + 500 for server error.
    let logs = rec.logs();
    assert_eq!(logs.len(), 1);
    assert_eq!(
        logs[0].attr_str("http.response.status_code").as_deref(),
        Some("500")
    );
    assert_eq!(
        logs[0].attr_str(attr::OUTCOME).as_deref(),
        Some(Outcome::Failure.as_str())
    );

    // Verify explicit HTTP duration boundaries on exported histogram data points.
    let mut found_server_bounds = false;
    let mut found_client_bounds = false;
    for batch in rec.metrics() {
        for rm in batch.resource_metrics {
            for sm in rm.scope_metrics {
                for m in sm.metrics {
                    if let Some(Data::Histogram(hist)) = m.data {
                        for dp in hist.data_points {
                            if m.name == "http.server.request.duration" {
                                assert_eq!(
                                    dp.explicit_bounds,
                                    libo11y_http::HTTP_DURATION_BOUNDARIES
                                );
                                found_server_bounds = true;
                            }
                            if m.name == "http.client.request.duration" {
                                assert_eq!(
                                    dp.explicit_bounds,
                                    libo11y_http::HTTP_DURATION_BOUNDARIES
                                );
                                found_client_bounds = true;
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(
        found_server_bounds,
        "server duration histogram bounds missing"
    );
    assert!(
        found_client_bounds,
        "client duration histogram bounds missing"
    );
    rec.assert_conforms();
}

async fn futures_catch_unwind<F>(fut: F) -> Result<F::Output, Box<dyn std::any::Any + Send>>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    tokio::spawn(fut)
        .await
        .map_err(|join_err| join_err.into_panic())
}
