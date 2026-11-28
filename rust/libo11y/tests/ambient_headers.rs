//! The OTLP headers an explicit [`EnvLookup`] resolves, against a process
//! environment that sets its own. Upstream's OTLP exporters read
//! `OTEL_EXPORTER_OTLP_HEADERS` from the process environment themselves, so
//! the ambient variables are set on a child process running this test
//! again: the test cannot change its own environment safely.
#![cfg(all(feature = "otlp-http", feature = "otlp-grpc"))]

use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::net::TcpListener;
use std::process::Command;
use std::sync::{Arc, Mutex};

use opentelemetry::trace::{Span as _, Tracer as _};
use opentelemetry_proto::tonic::collector::trace::v1::trace_service_server::{
    TraceService, TraceServiceServer,
};
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTraceServiceRequest, ExportTraceServiceResponse,
};

use libo11y::{EnvLookup, Environment, Sdk};

/// Marks the child run.
const CHILD: &str = "AMBIENT_HEADERS_TEST_CHILD";

/// The process environment's headers: a credential for some other
/// collector, which must never reach the one the lookup names.
const AMBIENT: &[(&str, &str)] = &[
    (
        "OTEL_EXPORTER_OTLP_HEADERS",
        "authorization=Bearer%20ambient,x-ambient=general",
    ),
    (
        "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
        "authorization=Bearer%20ambient-logs,x-ambient=logs",
    ),
];

#[test]
fn the_lookups_otlp_headers_win_over_the_process_environment() {
    if std::env::var_os(CHILD).is_some() {
        child();
        return;
    }
    let mut command = Command::new(std::env::current_exe().expect("test binary"));
    command
        .args([
            "--exact",
            "the_lookups_otlp_headers_win_over_the_process_environment",
            "--test-threads=1",
        ])
        .env(CHILD, "1");
    for (key, value) in AMBIENT {
        command.env(key, value);
    }
    let output = command.output().expect("child runs");
    assert!(
        output.status.success(),
        "child failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn child() {
    http_headers_come_from_the_lookup(Some("authorization=Bearer%20explicit,x-explicit=1"));
    http_headers_come_from_the_lookup(None);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(grpc_metadata_comes_from_the_lookup(Some(
        "authorization=Bearer%20explicit,x-explicit=1",
    )));
    runtime.block_on(grpc_metadata_comes_from_the_lookup(None));
}

/// What the collector must see, given the lookup's header variable.
fn assert_headers(what: &str, headers: &HashMap<String, String>, lookup: Option<&str>) {
    assert_eq!(
        headers.get("x-ambient"),
        None,
        "{what}: an ambient header reached the collector"
    );
    if lookup.is_some() {
        assert_eq!(
            headers.get("authorization").map(String::as_str),
            Some("Bearer explicit"),
            "{what}"
        );
        assert_eq!(
            headers.get("x-explicit").map(String::as_str),
            Some("1"),
            "{what}"
        );
    } else {
        assert_eq!(
            headers.get("authorization"),
            None,
            "{what}: an ambient credential reached the collector"
        );
    }
}

type Captured = Arc<Mutex<Vec<(String, HashMap<String, String>)>>>;

/// An HTTP collector that answers every request with an empty success and
/// records its path and headers.
fn spawn_http_collector() -> (String, Captured) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let captured = Captured::default();
    let sink = Arc::clone(&captured);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            let header_end = loop {
                let Ok(n) = stream.read(&mut tmp) else { return };
                if n == 0 {
                    break None;
                }
                buf.extend_from_slice(&tmp[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Some(pos + 4);
                }
            };
            let Some(header_end) = header_end else {
                continue;
            };
            let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
            let path = head
                .lines()
                .next()
                .and_then(|line| line.split(' ').nth(1))
                .unwrap_or_default()
                .to_owned();
            let headers: HashMap<String, String> = head
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
                .collect();
            let content_len: usize = headers
                .get("content-length")
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            while buf.len() < header_end + content_len {
                match stream.read(&mut tmp) {
                    Ok(n) if n > 0 => buf.extend_from_slice(&tmp[..n]),
                    _ => break,
                }
            }
            sink.lock().expect("lock").push((path, headers));
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/x-protobuf\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    });
    (format!("http://{addr}"), captured)
}

fn http_headers_come_from_the_lookup(lookup_headers: Option<&str>) {
    let (endpoint, captured) = spawn_http_collector();
    let mut vars = vec![
        ("OTEL_METRICS_EXPORTER", "none".to_owned()),
        ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf".to_owned()),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint),
    ];
    if let Some(headers) = lookup_headers {
        vars.push(("OTEL_EXPORTER_OTLP_HEADERS", headers.to_owned()));
    }
    let sdk = Sdk::builder()
        .service_name("ambient-http")
        .environment(Environment::Test)
        .without_runtime_metrics()
        .without_console_log()
        .env_lookup(EnvLookup::from_pairs(vars))
        .with_error_handler(|_| {})
        .build()
        .expect("SDK");
    sdk.tracer("t").start("op").end();
    sdk.event("ambient.checked", []);
    sdk.shutdown().expect("both exports reach the collector");

    let captured = captured.lock().expect("lock");
    for path in ["/v1/traces", "/v1/logs"] {
        let (_, headers) = captured
            .iter()
            .find(|(got, _)| got == path)
            .unwrap_or_else(|| panic!("no request to {path}: {captured:?}"));
        assert_headers(path, headers, lookup_headers);
    }
}

#[derive(Clone, Default)]
struct RecordingTraces(Arc<Mutex<Vec<HashMap<String, String>>>>);

#[tonic::async_trait]
impl TraceService for RecordingTraces {
    async fn export(
        &self,
        request: tonic::Request<ExportTraceServiceRequest>,
    ) -> Result<tonic::Response<ExportTraceServiceResponse>, tonic::Status> {
        let metadata = request
            .metadata()
            .iter()
            .filter_map(|entry| match entry {
                tonic::metadata::KeyAndValueRef::Ascii(key, value) => Some((
                    key.as_str().to_owned(),
                    value.to_str().unwrap_or_default().to_owned(),
                )),
                tonic::metadata::KeyAndValueRef::Binary(..) => None,
            })
            .collect();
        self.0.lock().expect("lock").push(metadata);
        Ok(tonic::Response::new(ExportTraceServiceResponse {
            partial_success: None,
        }))
    }
}

async fn grpc_metadata_comes_from_the_lookup(lookup_headers: Option<&'static str>) {
    let service = RecordingTraces::default();
    let received = Arc::clone(&service.0);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = tonic::transport::Server::builder()
            .add_service(TraceServiceServer::new(service))
            .serve_with_incoming(TcpIncoming(listener))
            .await;
    });

    let mut vars = vec![
        ("OTEL_METRICS_EXPORTER", "none".to_owned()),
        ("OTEL_LOGS_EXPORTER", "none".to_owned()),
        ("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc".to_owned()),
        ("OTEL_EXPORTER_OTLP_ENDPOINT", format!("http://{addr}")),
    ];
    if let Some(headers) = lookup_headers {
        vars.push(("OTEL_EXPORTER_OTLP_HEADERS", headers.to_owned()));
    }
    let sdk = Sdk::builder()
        .service_name("ambient-grpc")
        .environment(Environment::Test)
        .without_runtime_metrics()
        .without_console_log()
        .env_lookup(EnvLookup::from_pairs(vars))
        .with_error_handler(|_| {})
        .build()
        .expect("SDK");
    sdk.tracer("t").start("op").end();
    tokio::task::spawn_blocking(move || sdk.shutdown())
        .await
        .expect("join")
        .expect("the export reaches the collector");

    let received = received.lock().expect("lock");
    let metadata = received.first().expect("one export");
    assert_headers("grpc traces", metadata, lookup_headers);
}

/// A `Stream` over a Tokio listener, so the test needs no `tokio-stream`
/// dependency.
struct TcpIncoming(tokio::net::TcpListener);

impl tonic::codegen::tokio_stream::Stream for TcpIncoming {
    type Item = std::io::Result<tokio::net::TcpStream>;

    fn poll_next(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.0
            .poll_accept(cx)
            .map(|accepted| Some(accepted.map(|(stream, _)| stream)))
    }
}
