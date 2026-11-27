//! End-to-end OTLP wire tests exercising the core `libo11y::Sdk` configured
//! via `EnvLookup` (`OTEL_EXPORTER_OTLP_*`) against [`OtlpHttpReceiver`]
//! (protobuf, JSON, gzip, custom headers) and [`OtlpGrpcReceiver`] (protobuf,
//! gzip, custom metadata headers) across all three signals (traces, metrics
//! with exemplars, and logs).

use std::collections::HashMap;
use std::time::Duration;

use opentelemetry::KeyValue;
use opentelemetry::trace::{Span as _, Tracer as _};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{
    AnyValue as ProtoAnyValue, KeyValue as ProtoKeyValue, any_value::Value as ProtoValue,
};
use opentelemetry_proto::tonic::metrics::v1::metric::Data;

use libo11y::{EnvLookup, Environment, Sdk};
use libo11y_spec::{EVENT_NAME_KEY, Outcome, SCHEMA_URL, attr, event};
use libo11y_test::{OtlpGrpcReceiver, OtlpHttpReceiver};

const WIRE_PII: &str = "10.9.8.7";
const WIRE_SECRET: &str = "s3cr3t-wire-sentinel";

fn proto_any_str(val: Option<&ProtoAnyValue>) -> String {
    let Some(inner) = val.and_then(|v| v.value.as_ref()) else {
        return String::new();
    };
    match inner {
        ProtoValue::StringValue(s) => s.clone(),
        ProtoValue::BoolValue(b) => b.to_string(),
        ProtoValue::IntValue(i) => i.to_string(),
        ProtoValue::DoubleValue(d) => d.to_string(),
        ProtoValue::BytesValue(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        ProtoValue::ArrayValue(arr) => {
            let parts: Vec<String> = arr.values.iter().map(|v| proto_any_str(Some(v))).collect();
            format!("[{}]", parts.join(","))
        }
        ProtoValue::KvlistValue(kvs) => {
            let parts: Vec<String> = kvs
                .values
                .iter()
                .map(|kv| format!("{}={}", kv.key, proto_any_str(kv.value.as_ref())))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        ProtoValue::StringValueStrindex(idx) => idx.to_string(),
    }
}

fn proto_attrs_map(kvs: &[ProtoKeyValue]) -> HashMap<String, String> {
    kvs.iter()
        .map(|kv| (kv.key.clone(), proto_any_str(kv.value.as_ref())))
        .collect()
}

fn assert_no_leak(where_: &str, kvs: &[ProtoKeyValue]) {
    for kv in kvs {
        assert_ne!(
            kv.key, "host.ip",
            "{where_}: PII key host.ip leaked on wire"
        );
        assert_ne!(
            kv.key, "http.request.header.authorization",
            "{where_}: secret key authorization leaked on wire"
        );
        assert_ne!(
            kv.key, "http.request.header.cookie",
            "{where_}: secret key cookie leaked on wire"
        );
        let text = proto_any_str(kv.value.as_ref());
        assert!(
            !text.contains(WIRE_PII) && !text.contains(WIRE_SECRET),
            "{where_}: attribute {} leaked sentinel value {text:?}",
            kv.key
        );
    }
}

fn assert_resource_ok(where_: &str, attrs: &[ProtoKeyValue], schema_url: &str, want_service: &str) {
    let map = proto_attrs_map(attrs);
    assert_eq!(
        map.get("service.name").map(String::as_str),
        Some(want_service),
        "{where_}: resource service.name mismatch: {map:?}"
    );
    assert_eq!(
        map.get("deployment.environment.name").map(String::as_str),
        Some("test"),
        "{where_}: resource environment mismatch: {map:?}"
    );
    assert_eq!(
        schema_url, SCHEMA_URL,
        "{where_}: resource schema URL mismatch"
    );
    assert_no_leak(&format!("{where_} resource"), attrs);
}

fn emit_wire_telemetry(sdk: &Sdk) -> ([u8; 16], [u8; 8]) {
    let mut captured_ids = ([0u8; 16], [0u8; 8]);
    tracing::subscriber::with_default(sdk.subscriber(), || {
        let _outer = tracing::info_span!(
            "wire.op",
            host.ip = WIRE_PII,
            http.request.header.authorization = WIRE_SECRET,
            http.route = "/orders"
        )
        .entered();

        let cx = opentelemetry::Context::current();
        {
            use opentelemetry::trace::TraceContextExt as _;
            let sc = cx.span().span_context().clone();
            assert!(sc.is_valid(), "tracing span must activate OTel context");
            captured_ids = (sc.trace_id().to_bytes(), sc.span_id().to_bytes());
        }

        // Also emit an OTel API child span with a classified event attribute.
        let mut child = sdk.tracer("wire").start("wire.child");
        child.set_attribute(KeyValue::new("http.request.header.cookie", WIRE_SECRET));
        child.add_event(
            "step",
            vec![KeyValue::new(
                "http.request.header.authorization",
                WIRE_SECRET,
            )],
        );
        child.end();

        // Emit a correlated tracing log and a contract-bearing event with
        // classified attributes that must be stripped before hitting the wire.
        tracing::info!(
            host.ip = WIRE_PII,
            http.request.header.authorization = WIRE_SECRET,
            order.id = "ord-wire-1",
            "inside wire span"
        );
        sdk.event(
            event::REQUEST_SUMMARY,
            [
                KeyValue::new("http.request.method", "POST"),
                KeyValue::new("http.response.status_code", 201_i64),
                KeyValue::new(attr::OUTCOME, Outcome::Success.as_str()),
                KeyValue::new(attr::DURATION, 0.125_f64),
                KeyValue::new("host.ip", WIRE_PII),
            ],
        );

        // Record histogram and counter measurements inside the active span so
        // exemplars carry the trace and span IDs across the wire.
        let meter = sdk.meter("wire");
        meter.f64_histogram("wire.work.duration").build().record(
            0.5,
            &[
                KeyValue::new("route", "/orders"),
                KeyValue::new("host.ip", WIRE_PII),
                KeyValue::new("http.request.header.authorization", WIRE_SECRET),
            ],
        );
        meter
            .u64_counter("wire.orders.total")
            .build()
            .add(1, &[KeyValue::new("host.ip", WIRE_PII)]);
    });
    captured_ids
}

fn verify_wire_payloads(
    want_service: &str,
    want_trace: [u8; 16],
    want_span: [u8; 8],
    traces: &[ExportTraceServiceRequest],
    metrics: &[ExportMetricsServiceRequest],
    logs: &[ExportLogsServiceRequest],
) {
    assert!(!traces.is_empty(), "expected at least one trace batch");
    assert!(!metrics.is_empty(), "expected at least one metric batch");
    assert!(!logs.is_empty(), "expected at least one log batch");

    verify_wire_traces(want_service, want_trace, traces);
    verify_wire_logs(want_service, want_trace, want_span, logs);
    verify_wire_metrics(want_service, want_trace, want_span, metrics);
}

fn verify_wire_traces(
    want_service: &str,
    want_trace: [u8; 16],
    traces: &[ExportTraceServiceRequest],
) {
    let mut saw_outer = false;
    let mut saw_child_event = false;
    for req in traces {
        for rs in &req.resource_spans {
            let res_attrs = rs
                .resource
                .as_ref()
                .map_or(&[][..], |r| r.attributes.as_slice());
            assert_resource_ok("traces", res_attrs, &rs.schema_url, want_service);
            for ss in &rs.scope_spans {
                for span in &ss.spans {
                    assert_no_leak(&format!("span {}", span.name), &span.attributes);
                    for ev in &span.events {
                        assert_no_leak(&format!("span event {}", ev.name), &ev.attributes);
                        if span.name == "wire.child" && ev.name == "step" {
                            saw_child_event = true;
                        }
                    }
                    for link in &span.links {
                        assert_no_leak("span link", &link.attributes);
                    }
                    if span.name == "wire.op" && span.trace_id == want_trace {
                        let attrs = proto_attrs_map(&span.attributes);
                        assert_eq!(attrs.get("http.route").map(String::as_str), Some("/orders"));
                        saw_outer = true;
                    }
                }
            }
        }
    }
    assert!(
        saw_outer,
        "outer span wire.op with expected trace_id not exported"
    );
    assert!(saw_child_event, "child span event step not exported");
}

fn verify_wire_logs(
    want_service: &str,
    want_trace: [u8; 16],
    want_span: [u8; 8],
    logs: &[ExportLogsServiceRequest],
) {
    let mut saw_correlated_log = false;
    let mut saw_summary_event = false;
    for req in logs {
        for rl in &req.resource_logs {
            let res_attrs = rl
                .resource
                .as_ref()
                .map_or(&[][..], |r| r.attributes.as_slice());
            assert_resource_ok("logs", res_attrs, &rl.schema_url, want_service);
            for sl in &rl.scope_logs {
                for lr in &sl.log_records {
                    assert_no_leak("log", &lr.attributes);
                    let body = proto_any_str(lr.body.as_ref());
                    assert!(
                        !body.contains(WIRE_PII) && !body.contains(WIRE_SECRET),
                        "log body leaked sentinel: {body:?}"
                    );
                    let correlated = lr.trace_id == want_trace && lr.span_id == want_span;
                    if body == "inside wire span" && correlated {
                        saw_correlated_log = true;
                    }
                    let attrs = proto_attrs_map(&lr.attributes);
                    if attrs.get(EVENT_NAME_KEY).map(String::as_str) == Some(event::REQUEST_SUMMARY)
                        && correlated
                    {
                        saw_summary_event = true;
                    }
                }
            }
        }
    }
    assert!(
        saw_correlated_log,
        "correlated log 'inside wire span' did not reach receiver"
    );
    assert!(
        saw_summary_event,
        "correlated event o11y.request.summary did not reach receiver"
    );
}

fn verify_wire_metrics(
    want_service: &str,
    want_trace: [u8; 16],
    want_span: [u8; 8],
    metrics: &[ExportMetricsServiceRequest],
) {
    let mut saw_hist_exemplar = false;
    let mut saw_counter_exemplar = false;
    for req in metrics {
        for rm in &req.resource_metrics {
            let res_attrs = rm
                .resource
                .as_ref()
                .map_or(&[][..], |r| r.attributes.as_slice());
            assert_resource_ok("metrics", res_attrs, &rm.schema_url, want_service);
            for sm in &rm.scope_metrics {
                for m in &sm.metrics {
                    match &m.data {
                        Some(Data::Histogram(h)) if m.name == "wire.work.duration" => {
                            for dp in &h.data_points {
                                assert_no_leak("histogram dp", &dp.attributes);
                                for ex in &dp.exemplars {
                                    assert_no_leak("histogram exemplar", &ex.filtered_attributes);
                                    if ex.trace_id == want_trace && ex.span_id == want_span {
                                        saw_hist_exemplar = true;
                                    }
                                }
                            }
                        }
                        Some(Data::Sum(s)) if m.name == "wire.orders.total" => {
                            for dp in &s.data_points {
                                assert_no_leak("counter dp", &dp.attributes);
                                for ex in &dp.exemplars {
                                    assert_no_leak("counter exemplar", &ex.filtered_attributes);
                                    if ex.trace_id == want_trace && ex.span_id == want_span {
                                        saw_counter_exemplar = true;
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    assert!(
        saw_hist_exemplar,
        "wire.work.duration histogram exemplar with trace/span ID did not reach receiver"
    );
    assert!(
        saw_counter_exemplar,
        "wire.orders.total counter exemplar with trace/span ID did not reach receiver"
    );
}

#[test]
fn otlp_http_protobuf_gzip_and_headers_end_to_end() {
    let receiver = OtlpHttpReceiver::start().expect("http receiver");
    let endpoint = receiver.endpoint();

    let sdk = Sdk::builder()
        .service_name("wire-http-proto")
        .environment(Environment::Test)
        .without_console_log()
        .without_runtime_metrics()
        .resource_attributes([
            KeyValue::new("host.ip", WIRE_PII),
            KeyValue::new("http.request.header.authorization", WIRE_SECRET),
        ])
        .env_lookup(EnvLookup::from_pairs([
            ("OTEL_TRACES_EXPORTER", "otlp"),
            ("OTEL_METRICS_EXPORTER", "otlp"),
            ("OTEL_LOGS_EXPORTER", "otlp"),
            ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"),
            ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.as_str()),
            ("OTEL_EXPORTER_OTLP_COMPRESSION", "gzip"),
            (
                "OTEL_EXPORTER_OTLP_HEADERS",
                "x-api-key=sec%20ret, x-tenant=acme",
            ),
            ("OTEL_METRIC_EXPORT_INTERVAL", "3600000"),
        ]))
        .with_error_handler(|_| {})
        .build()
        .expect("SDK");

    let (want_trace, want_span) = emit_wire_telemetry(&sdk);
    sdk.shutdown_with_timeout(Duration::from_secs(10))
        .expect("shutdown");

    let traces = receiver.traces();
    let metrics = receiver.metrics();
    let logs = receiver.logs();
    verify_wire_payloads(
        "wire-http-proto",
        want_trace,
        want_span,
        &traces,
        &metrics,
        &logs,
    );

    let headers = receiver.headers();
    assert!(headers.len() >= 3, "expected headers for all 3 signals");
    for h in &headers {
        assert_eq!(
            h.get("content-type").map(String::as_str),
            Some("application/x-protobuf"),
            "unexpected content-type in {h:?}"
        );
        assert_eq!(
            h.get("content-encoding").map(String::as_str),
            Some("gzip"),
            "expected gzip encoding in {h:?}"
        );
        assert_eq!(
            h.get("x-api-key").map(String::as_str),
            Some("sec ret"),
            "missing decoded x-api-key in {h:?}"
        );
        assert_eq!(
            h.get("x-tenant").map(String::as_str),
            Some("acme"),
            "missing x-tenant in {h:?}"
        );
    }

    receiver.clear();
    assert!(receiver.traces().is_empty());
    assert!(receiver.metrics().is_empty());
    assert!(receiver.logs().is_empty());
    assert!(receiver.headers().is_empty());
    receiver.shutdown();
    receiver.shutdown(); // idempotent
}

#[test]
fn otlp_http_json_end_to_end() {
    let receiver = OtlpHttpReceiver::start().expect("http receiver");
    let endpoint = receiver.endpoint();

    let sdk = Sdk::builder()
        .service_name("wire-http-json")
        .environment(Environment::Test)
        .without_console_log()
        .without_runtime_metrics()
        .resource_attributes([KeyValue::new("host.ip", WIRE_PII)])
        .env_lookup(EnvLookup::from_pairs([
            ("OTEL_TRACES_EXPORTER", "otlp"),
            ("OTEL_METRICS_EXPORTER", "otlp"),
            ("OTEL_LOGS_EXPORTER", "otlp"),
            ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json"),
            ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.as_str()),
            ("OTEL_EXPORTER_OTLP_HEADERS", "x-format=json"),
            ("OTEL_METRIC_EXPORT_INTERVAL", "3600000"),
        ]))
        .with_error_handler(|_| {})
        .build()
        .expect("SDK");

    let (want_trace, want_span) = emit_wire_telemetry(&sdk);
    sdk.shutdown_with_timeout(Duration::from_secs(10))
        .expect("shutdown");

    let traces = receiver.traces();
    let metrics = receiver.metrics();
    let logs = receiver.logs();
    verify_wire_payloads(
        "wire-http-json",
        want_trace,
        want_span,
        &traces,
        &metrics,
        &logs,
    );

    let headers = receiver.headers();
    assert!(headers.len() >= 3);
    for h in &headers {
        assert_eq!(
            h.get("content-type").map(String::as_str),
            Some("application/json"),
            "unexpected content-type in {h:?}"
        );
        assert_eq!(
            h.get("x-format").map(String::as_str),
            Some("json"),
            "missing x-format header in {h:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn otlp_grpc_gzip_and_metadata_end_to_end() {
    let receiver = OtlpGrpcReceiver::start().expect("grpc receiver");
    let endpoint = receiver.endpoint();

    let sdk = Sdk::builder()
        .service_name("wire-grpc")
        .environment(Environment::Test)
        .without_console_log()
        .without_runtime_metrics()
        .resource_attributes([
            KeyValue::new("host.ip", WIRE_PII),
            KeyValue::new("http.request.header.authorization", WIRE_SECRET),
        ])
        .env_lookup(EnvLookup::from_pairs([
            ("OTEL_TRACES_EXPORTER", "otlp"),
            ("OTEL_METRICS_EXPORTER", "otlp"),
            ("OTEL_LOGS_EXPORTER", "otlp"),
            ("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"),
            ("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint.as_str()),
            ("OTEL_EXPORTER_OTLP_COMPRESSION", "gzip"),
            ("OTEL_EXPORTER_OTLP_HEADERS", "x-grpc-auth=tok%20en"),
            ("OTEL_METRIC_EXPORT_INTERVAL", "3600000"),
        ]))
        .with_error_handler(|_| {})
        .build()
        .expect("SDK");

    let (want_trace, want_span) = emit_wire_telemetry(&sdk);
    sdk.shutdown_with_timeout_async(Duration::from_secs(10))
        .await
        .expect("shutdown");

    let traces = receiver.traces();
    let metrics = receiver.metrics();
    let logs = receiver.logs();
    verify_wire_payloads("wire-grpc", want_trace, want_span, &traces, &metrics, &logs);

    let headers = receiver.headers();
    assert!(headers.len() >= 3, "expected metadata for all 3 signals");
    for h in &headers {
        assert_eq!(
            h.get("x-grpc-auth").map(String::as_str),
            Some("tok en"),
            "missing decoded x-grpc-auth metadata in {h:?}"
        );
    }

    receiver.clear();
    assert!(receiver.traces().is_empty());
    assert!(receiver.metrics().is_empty());
    assert!(receiver.logs().is_empty());
    receiver.shutdown();
    receiver.shutdown(); // idempotent
}
