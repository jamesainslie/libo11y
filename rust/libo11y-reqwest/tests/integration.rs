//! Integration tests for `libo11y-reqwest` against a local loopback HTTP
//! server, verifying W3C header propagation, semconv 1.41.0 client spans,
//! error status and transport failure handling, filtering, exemplars, and
//! specification conformance.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use libo11y_reqwest::O11yMiddleware;
use libo11y_test::Recorder;
use opentelemetry::baggage::BaggageExt as _;
use opentelemetry::context::FutureExt as _;
use opentelemetry::trace::{SpanKind, Status, TraceContextExt as _, Tracer as _};
use opentelemetry::{Context as OtelContext, KeyValue, Value};
use reqwest_middleware::ClientBuilder;
use tokio::net::TcpListener;
use tracing::instrument::WithSubscriber as _;

#[derive(Debug, Default, Clone)]
struct CapturedRequest {
    path: String,
    traceparent: Option<String>,
    baggage: Option<String>,
}

async fn start_loopback_server() -> (
    SocketAddr,
    Arc<Mutex<Vec<CapturedRequest>>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_clone = Arc::clone(&seen);

    let handle = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let seen_conn = Arc::clone(&seen_clone);
            tokio::spawn(async move {
                let io = TokioIo::new(stream);
                let _ = http1::Builder::new()
                    .serve_connection(
                        io,
                        service_fn(move |req: Request<Incoming>| {
                            let seen_req = Arc::clone(&seen_conn);
                            async move {
                                let path = req.uri().path().to_owned();
                                let traceparent = req
                                    .headers()
                                    .get("traceparent")
                                    .and_then(|v| v.to_str().ok())
                                    .map(str::to_owned);
                                let baggage = req
                                    .headers()
                                    .get("baggage")
                                    .and_then(|v| v.to_str().ok())
                                    .map(str::to_owned);
                                seen_req.lock().unwrap().push(CapturedRequest {
                                    path: path.clone(),
                                    traceparent,
                                    baggage,
                                });
                                let status = match path.as_str() {
                                    "/not-found" => StatusCode::NOT_FOUND,
                                    "/fail" => StatusCode::INTERNAL_SERVER_ERROR,
                                    _ => StatusCode::OK,
                                };
                                Ok::<_, Infallible>(
                                    Response::builder()
                                        .status(status)
                                        .body(Full::new(Bytes::from_static(b"ok")))
                                        .unwrap(),
                                )
                            }
                        }),
                    )
                    .await;
            });
        }
    });

    (addr, seen, handle)
}

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
async fn reqwest_propagates_w3c_headers_records_semconv_and_satisfies_triangle() {
    let (addr, seen, server_handle) = start_loopback_server().await;
    let rec = Recorder::start("reqwest-client-test");

    let client = ClientBuilder::new(reqwest::Client::new())
        .with(O11yMiddleware::new(rec.sdk()))
        .build();

    let parent_span = rec.sdk().tracer("app").start("checkout");
    let parent_cx =
        OtelContext::current_with_span(parent_span).with_baggage([KeyValue::new("tenant", "acme")]);

    let url = format!(
        "http://alice:hunter2@127.0.0.1:{}/orders/42?page=2&token=secret",
        addr.port()
    );
    let resp = async {
        tracing::info!(order.id = "42", "calling downstream");
        client.get(&url).send().await.expect("GET succeeded")
    }
    .with_context(parent_cx.clone())
    .with_subscriber(rec.sdk().subscriber())
    .await;
    parent_cx.span().end();

    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "/orders/42");
    let tp = requests[0]
        .traceparent
        .as_deref()
        .expect("traceparent header sent");
    assert_eq!(requests[0].baggage.as_deref(), Some("tenant=acme"));

    let spans = rec.spans();
    let client_span = spans
        .iter()
        .find(|s| s.span_kind == SpanKind::Client)
        .expect("client span recorded");

    let expected_trace_id = client_span.span_context.trace_id().to_string();
    let expected_span_id = client_span.span_context.span_id().to_string();
    assert!(
        tp.contains(&expected_trace_id) && tp.contains(&expected_span_id),
        "traceparent {tp:?} did not carry client span {expected_trace_id}/{expected_span_id}"
    );

    assert_eq!(client_span.name.as_ref(), "GET");
    assert_eq!(client_span.status, Status::Unset);
    assert_eq!(
        span_attr(client_span, "http.request.method").as_deref(),
        Some("GET")
    );
    assert_eq!(
        span_attr(client_span, "url.full"),
        Some(format!(
            "http://127.0.0.1:{}/orders/42?page=2&token=REDACTED",
            addr.port()
        ))
    );
    assert_eq!(
        span_attr(client_span, "server.address").as_deref(),
        Some("127.0.0.1")
    );
    assert_eq!(
        span_attr(client_span, "server.port"),
        Some(addr.port().to_string())
    );
    assert_eq!(
        span_attr(client_span, "http.response.status_code").as_deref(),
        Some("200")
    );
    assert_eq!(span_attr(client_span, "error.type"), None);

    let exemplars = rec.exemplars("http.client.request.duration");
    assert!(
        !exemplars.is_empty(),
        "http.client.request.duration must carry exemplars"
    );
    assert_eq!(exemplars[0].trace_id, expected_trace_id);

    rec.assert_conforms();
    rec.assert_correlated();
    rec.assert_triangle("http.client.request.duration");

    server_handle.abort();
}

#[tokio::test]
async fn reqwest_marks_error_statuses_and_honors_filters_and_ignore_paths() {
    let (addr, seen, server_handle) = start_loopback_server().await;
    let rec = Recorder::start("reqwest-errors-filters");

    let client = ClientBuilder::new(reqwest::Client::new())
        .with(
            O11yMiddleware::new(rec.sdk())
                .with_ignore_paths(["/healthz", "/debug/*"])
                .with_filter(|req| !req.headers().contains_key("x-skip")),
        )
        .build();

    let base = format!("http://127.0.0.1:{}", addr.port());

    // Filtered out by ignore_paths and custom filter.
    let _ = client.get(format!("{base}/healthz")).send().await.unwrap();
    let _ = client
        .get(format!("{base}/debug/pprof"))
        .send()
        .await
        .unwrap();
    let _ = client
        .get(format!("{base}/ok"))
        .header("x-skip", "1")
        .send()
        .await
        .unwrap();

    // Instrumented 404 and 500.
    let r404 = client
        .get(format!("{base}/not-found"))
        .send()
        .await
        .unwrap();
    assert_eq!(r404.status(), reqwest::StatusCode::NOT_FOUND);
    let r500 = client.get(format!("{base}/fail")).send().await.unwrap();
    assert_eq!(r500.status(), reqwest::StatusCode::INTERNAL_SERVER_ERROR);

    // Filtered requests still reached the server without traceparent.
    let reqs = seen.lock().unwrap();
    assert_eq!(reqs.len(), 5);
    assert_eq!(reqs[0].traceparent, None);
    assert_eq!(reqs[1].traceparent, None);
    assert_eq!(reqs[2].traceparent, None);
    assert!(reqs[3].traceparent.is_some());
    assert!(reqs[4].traceparent.is_some());

    let spans = rec.spans();
    assert_eq!(spans.len(), 2);
    assert_eq!(
        span_attr(&spans[0], "http.response.status_code").as_deref(),
        Some("404")
    );
    assert_eq!(span_attr(&spans[0], "error.type").as_deref(), Some("404"));
    assert!(matches!(spans[0].status, Status::Error { .. }));

    assert_eq!(
        span_attr(&spans[1], "http.response.status_code").as_deref(),
        Some("500")
    );
    assert_eq!(span_attr(&spans[1], "error.type").as_deref(), Some("500"));
    assert!(matches!(spans[1].status, Status::Error { .. }));

    rec.assert_conforms();
    server_handle.abort();
}

#[tokio::test]
async fn reqwest_ignore_paths_match_the_percent_decoded_path() {
    let (addr, seen, server_handle) = start_loopback_server().await;
    let rec = Recorder::start("reqwest-ignore-decoded");

    let client = ClientBuilder::new(reqwest::Client::new())
        .with(O11yMiddleware::new(rec.sdk()).with_ignore_paths(["/healthz"]))
        .build();
    let base = format!("http://127.0.0.1:{}", addr.port());

    let _ = client
        .get(format!("{base}/%68ealthz"))
        .send()
        .await
        .unwrap();
    let _ = client.get(format!("{base}/ok")).send().await.unwrap();

    assert_eq!(seen.lock().unwrap().len(), 2);
    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(span_attr(&spans[0], "url.full"), Some(format!("{base}/ok")));
    server_handle.abort();
}

#[tokio::test]
async fn reqwest_records_connect_errors_on_span_and_duration_metric() {
    // Bind and immediately drop a listener to pick an unused loopback port.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let closed_port = listener.local_addr().expect("addr").port();
    drop(listener);

    let rec = Recorder::start("reqwest-connect-err");
    let client = ClientBuilder::new(reqwest::Client::new())
        .with(O11yMiddleware::new(rec.sdk()))
        .build();

    let err = client
        .get(format!("http://127.0.0.1:{closed_port}/unreachable"))
        .send()
        .await
        .expect_err("connection refused");
    let _ = err;

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert!(matches!(spans[0].status, Status::Error { .. }));
    assert!(span_attr(&spans[0], "error.type").is_some());
    assert!(
        rec.metric_names()
            .contains(&"http.client.request.duration".to_owned())
    );
    rec.assert_conforms();
}

#[tokio::test]
async fn reqwest_normalizes_unknown_http_methods() {
    let (addr, _seen, server_handle) = start_loopback_server().await;
    let rec = Recorder::start("reqwest-unknown-method");
    let client = ClientBuilder::new(reqwest::Client::new())
        .with(O11yMiddleware::new(rec.sdk()))
        .build();

    let method = reqwest::Method::from_bytes(b"PURGE").expect("custom method");
    let resp = client
        .request(method, format!("http://127.0.0.1:{}/cache", addr.port()))
        .send()
        .await
        .expect("PURGE succeeded");
    assert_eq!(resp.status(), reqwest::StatusCode::OK);

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].name.as_ref(), "HTTP");
    assert_eq!(
        span_attr(&spans[0], "http.request.method").as_deref(),
        Some("_OTHER")
    );
    assert_eq!(
        span_attr(&spans[0], "http.request.method_original").as_deref(),
        Some("PURGE")
    );
    rec.assert_conforms();
    server_handle.abort();
}

#[tokio::test]
async fn reqwest_records_a_canceled_request_when_the_future_is_dropped() {
    use std::future::Future as _;
    use std::task::{Context, Waker};

    // A listener that never accepts: the connection sits in the backlog and
    // no response ever arrives, so the request stays pending.
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();

    let rec = Recorder::start("reqwest-canceled");
    let client = ClientBuilder::new(reqwest::Client::new())
        .with(O11yMiddleware::new(rec.sdk()))
        .build();
    {
        let fut = client
            .get(format!("http://127.0.0.1:{port}/hang#access_token=frag"))
            .send();
        let mut fut = std::pin::pin!(fut);
        let mut cx = Context::from_waker(Waker::noop());
        assert!(fut.as_mut().poll(&mut cx).is_pending());
    }

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].span_kind, SpanKind::Client);
    assert_eq!(
        span_attr(&spans[0], "error.type").as_deref(),
        Some("canceled")
    );
    assert_eq!(spans[0].status, Status::error("canceled"));
    assert_eq!(span_attr(&spans[0], "http.response.status_code"), None);
    let url_full = span_attr(&spans[0], "url.full").expect("url.full");
    assert!(!url_full.contains("access_token"), "{url_full}");
    assert!(!url_full.contains('#'), "{url_full}");

    let points = duration_points(&rec);
    assert_eq!(points.len(), 1);
    assert_eq!(points[0].0, 1);
    assert_eq!(points[0].1.as_deref(), Some("canceled"));
    rec.assert_conforms();
    drop(listener);
}

/// Returns `(count, error.type)` for each latest data point of
/// `http.client.request.duration`.
fn duration_points(rec: &Recorder) -> Vec<(u64, Option<String>)> {
    use libo11y::opentelemetry_proto::tonic::common::v1::any_value::Value as ProtoValue;
    use libo11y::opentelemetry_proto::tonic::metrics::v1::metric::Data;

    let mut latest = Vec::new();
    for batch in rec.metrics() {
        for rm in batch.resource_metrics {
            for sm in rm.scope_metrics {
                for m in sm.metrics {
                    if m.name != "http.client.request.duration" {
                        continue;
                    }
                    let Some(Data::Histogram(hist)) = m.data else {
                        continue;
                    };
                    latest = hist
                        .data_points
                        .into_iter()
                        .map(|dp| {
                            let error_type = dp.attributes.into_iter().find_map(|kv| {
                                match (kv.key.as_str(), kv.value.and_then(|v| v.value)) {
                                    ("error.type", Some(ProtoValue::StringValue(s))) => Some(s),
                                    _ => None,
                                }
                            });
                            (dp.count, error_type)
                        })
                        .collect();
                }
            }
        }
    }
    latest
}

#[tokio::test]
async fn reqwest_strips_the_fragment_from_url_full() {
    let (addr, _seen, server_handle) = start_loopback_server().await;
    let rec = Recorder::start("reqwest-fragment");
    let client = ClientBuilder::new(reqwest::Client::new())
        .with(O11yMiddleware::new(rec.sdk()))
        .build();
    client
        .get(format!(
            "http://127.0.0.1:{}/cb?X-Amz-Signature=sig#access_token=tok",
            addr.port()
        ))
        .send()
        .await
        .expect("request succeeded");
    let spans = rec.spans();
    assert_eq!(
        span_attr(&spans[0], "url.full").as_deref(),
        Some(
            format!(
                "http://127.0.0.1:{}/cb?X-Amz-Signature=REDACTED",
                addr.port()
            )
            .as_str()
        )
    );
    rec.assert_conforms();
    server_handle.abort();
}
