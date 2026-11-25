//! The trace pipeline of an SDK built without globals: `tracing` spans and
//! OpenTelemetry API spans exported with the resource and redacted, one
//! trace across both APIs, error events setting span status, violations
//! counted, and the diagnostics routed to the error handler.

mod common;

use std::sync::{Arc, Mutex};

use opentelemetry::trace::{
    Span as _, SpanContext, SpanId, Status, TraceContextExt as _, TraceFlags, TraceId, TraceState,
    Tracer as _,
};
use opentelemetry::{Context, KeyValue};
use opentelemetry_sdk::metrics::InMemoryMetricExporter;

use common::{Ended, Spans, attr, hermetic, violations};
use libo11y::{PiiMode, TelemetryError};

const KEY: [u8; 32] = [3; 32];

/// Runs `f` with the SDK's tracing stack as the thread's default.
fn traced<T>(sdk: &libo11y::Sdk, f: impl FnOnce() -> T) -> T {
    tracing::subscriber::with_default(sdk.subscriber(), f)
}

#[test]
fn tracing_and_api_spans_are_exported_with_the_resource() {
    let spans = Spans::default();
    let sdk = hermetic("pipeline-resource")
        .with_span_exporter(spans.clone())
        .build()
        .expect("SDK");
    traced(&sdk, || {
        let _span = tracing::info_span!("from-tracing").entered();
    });
    sdk.tracer("api").start("from-api").end();
    sdk.force_flush().expect("flush");

    assert_eq!(spans.named("from-tracing").name, "from-tracing");
    assert_eq!(spans.named("from-api").name, "from-api");
    let resource = spans.resource().expect("the exporter got the resource");
    assert_eq!(resource.schema_url(), Some(libo11y_spec::SCHEMA_URL));
    assert_eq!(
        resource
            .get(&opentelemetry::Key::from_static_str("service.name"))
            .map(|v| v.to_string())
            .as_deref(),
        Some("pipeline-resource")
    );
    assert_eq!(&resource, sdk.resource());
}

#[test]
fn span_attributes_are_classified_on_both_apis() {
    for (mode, want_pii) in [(PiiMode::Drop, None), (PiiMode::Hash, Some("hmac-sha256:"))] {
        let spans = Spans::default();
        let sdk = hermetic("pipeline-classify")
            .pii_mode(mode)
            .pii_hash_key(KEY)
            .with_span_exporter(spans.clone())
            .build()
            .expect("SDK");
        traced(&sdk, || {
            let _span = tracing::info_span!(
                "tracing-op",
                http.request.header.authorization = "Bearer s3cret",
                host.ip = "10.9.8.7",
                http.route = "/orders"
            )
            .entered();
        });
        let mut api = sdk.tracer("api").start("api-op");
        api.set_attribute(KeyValue::new("http.request.header.cookie", "id=1"));
        api.set_attribute(KeyValue::new("host.ip", "10.9.8.7"));
        api.add_event(
            "e",
            vec![KeyValue::new("http.request.header.authorization", "x")],
        );
        api.end();
        sdk.force_flush().expect("flush");

        for name in ["tracing-op", "api-op"] {
            let span = spans.named(name);
            assert_eq!(
                attr(&span.attributes, "http.request.header.authorization"),
                None
            );
            assert_eq!(attr(&span.attributes, "http.request.header.cookie"), None);
            let pii = attr(&span.attributes, "host.ip");
            match want_pii {
                None => assert_eq!(pii, None, "{mode:?} {name}"),
                Some(prefix) => {
                    let token = pii.expect("the token stays");
                    assert!(token.starts_with(prefix), "{token}");
                    assert_ne!(token, "10.9.8.7");
                }
            }
        }
        assert_eq!(
            attr(&spans.named("tracing-op").attributes, "http.route").as_deref(),
            Some("/orders")
        );
        assert!(
            spans.named("api-op").events.events[0].attributes.is_empty(),
            "event attributes are classified"
        );
    }
}

#[test]
fn a_tracing_span_and_an_api_child_share_a_trace() {
    let spans = Spans::default();
    let sdk = hermetic("pipeline-nesting")
        .with_span_exporter(spans.clone())
        .build()
        .expect("SDK");
    let tracer = sdk.tracer("api");
    traced(&sdk, || {
        tracing::info_span!("outer").in_scope(|| {
            tracer.start("api-child").end();
        });
        let api_parent = tracer.start("api-parent");
        let cx = Context::current_with_span(api_parent);
        {
            let _attached = cx.clone().attach();
            let _inner = tracing::info_span!("tracing-child").entered();
        }
        cx.span().end();
    });
    sdk.force_flush().expect("flush");

    let outer = spans.named("outer");
    let child = spans.named("api-child");
    assert_eq!(child.span_context.trace_id(), outer.span_context.trace_id());
    assert_eq!(child.parent_span_id, outer.span_context.span_id());

    let api_parent = spans.named("api-parent");
    let tracing_child = spans.named("tracing-child");
    assert_eq!(
        tracing_child.span_context.trace_id(),
        api_parent.span_context.trace_id()
    );
    assert_eq!(
        tracing_child.parent_span_id,
        api_parent.span_context.span_id()
    );
}

#[test]
fn an_error_event_sets_the_span_status_and_other_events_stay_off_the_span() {
    let spans = Spans::default();
    let sdk = hermetic("pipeline-status")
        .with_span_exporter(spans.clone())
        .build()
        .expect("SDK");
    traced(&sdk, || {
        tracing::info_span!("failing").in_scope(|| {
            tracing::info!("step one");
            tracing::warn!("almost");
            tracing::error!("boom");
        });
        tracing::info_span!("fine").in_scope(|| tracing::info!("all good"));
    });
    sdk.force_flush().expect("flush");

    let failing = spans.named("failing");
    assert!(
        matches!(failing.status, Status::Error { .. }),
        "{:?}",
        failing.status
    );
    let events: Vec<&str> = failing
        .events
        .events
        .iter()
        .map(|e| e.name.as_ref())
        .collect();
    assert_eq!(events, ["boom"], "only the error event reaches the span");
    assert!(
        failing.events.events[0]
            .attributes
            .iter()
            .all(|kv| !kv.key.as_str().starts_with("exception.")),
        "no exception attributes"
    );
    let fine = spans.named("fine");
    assert_eq!(fine.status, Status::Unset);
    assert!(fine.events.events.is_empty());
}

// go/spanpolicy_test.go TestInjectedProcessorAndExporterReceiveRedactedSpans.
#[test]
fn an_injected_processor_and_exporter_both_get_redacted_spans() {
    let spans = Spans::default();
    let ended = Ended::default();
    let sdk = hermetic("pipeline-both")
        .with_span_processor(ended.clone())
        .with_span_exporter(spans.clone())
        .build()
        .expect("SDK");
    let mut span = sdk.tracer("t").start("op");
    span.set_attribute(KeyValue::new("http.request.header.authorization", "x"));
    span.end();
    sdk.force_flush().expect("flush");
    for (who, got) in [("processor", ended.spans()), ("exporter", spans.spans())] {
        assert_eq!(got.len(), 1, "{who}");
        assert_eq!(
            attr(&got[0].attributes, "http.request.header.authorization"),
            None,
            "{who}"
        );
    }
}

// TestSpanViolationCountedOnce.
#[test]
fn a_span_violation_counts_once_however_many_destinations() {
    for with_exporter in [false, true] {
        let metrics = InMemoryMetricExporter::default();
        let mut builder = hermetic("pipeline-count")
            .with_span_processor(Ended::default())
            .with_metric_exporter(metrics.clone());
        if with_exporter {
            builder = builder.with_span_exporter(Spans::default());
        }
        let sdk = builder.build().expect("SDK");
        let mut span = sdk.tracer("t").start("op");
        span.set_attribute(KeyValue::new("host.ip", "10.9.8.7"));
        span.end();
        sdk.force_flush().expect("flush");
        // The exporter counts while the batch exports, which the first
        // flush runs beside the metric flush; the second collects it.
        sdk.force_flush().expect("flush");
        assert_eq!(
            violations(&metrics),
            [("traces".to_owned(), "pii_attribute".to_owned(), 1)],
            "exporter: {with_exporter}"
        );
    }
}

#[test]
fn resource_violations_count_once_the_counter_exists() {
    let metrics = InMemoryMetricExporter::default();
    let sdk = hermetic("pipeline-resource-count")
        .resource_attributes([KeyValue::new("host.ip", "10.0.0.1")])
        .with_metric_exporter(metrics.clone())
        .build()
        .expect("SDK");
    sdk.force_flush().expect("flush");
    assert_eq!(
        violations(&metrics),
        [("resource".to_owned(), "pii_attribute".to_owned(), 1)]
    );
}

#[test]
fn opentelemetry_diagnostics_reach_the_handler_not_the_spans() {
    let reported: Arc<Mutex<Vec<TelemetryError>>> = Arc::default();
    let sink = Arc::clone(&reported);
    let spans = Spans::default();
    let sdk = hermetic("pipeline-diagnostics")
        .with_error_handler(move |err| sink.lock().expect("lock").push(err.clone()))
        .with_span_exporter(spans.clone())
        .build()
        .expect("SDK");
    traced(&sdk, || {
        tracing::info_span!("op").in_scope(|| {
            tracing::error!(
                name: "Exporter.Failed",
                target: "opentelemetry_sdk",
                name = "Exporter.Failed",
                error = "connection refused"
            );
        });
        // A span after a diagnostic on the same thread still reaches the
        // span layer.
        tracing::info_span!("after").in_scope(|| {});
    });
    sdk.force_flush().expect("flush");
    let reported = reported.lock().expect("lock");
    assert_eq!(reported.len(), 1, "{reported:?}");
    assert_eq!(
        reported[0].message(),
        "Exporter.Failed: error=connection refused"
    );
    assert_eq!(reported[0].target(), Some("opentelemetry_sdk"));
    let op = spans.named("op");
    assert_eq!(
        op.status,
        Status::Unset,
        "a diagnostic is not the span's error"
    );
    assert!(op.events.events.is_empty());
    assert_eq!(spans.named("after").name, "after");
}

/// A remote parent, as inbound propagation leaves it.
fn remote_parent() -> (Context, SpanContext) {
    let sc = SpanContext::new(
        TraceId::from(0xa1_u128),
        SpanId::from(0xb2_u64),
        TraceFlags::SAMPLED,
        true,
        TraceState::default(),
    );
    (Context::new().with_remote_span_context(sc.clone()), sc)
}

#[test]
fn the_propagator_carries_the_trace() {
    let sdk = hermetic("pipeline-propagate").build().expect("SDK");
    let (cx, parent) = remote_parent();
    let span = sdk.tracer("t").start_with_context("op", &cx);
    let cx = cx.with_span(span);
    let mut carrier = std::collections::HashMap::new();
    opentelemetry::propagation::TextMapPropagator::inject_context(
        sdk.propagator(),
        &cx,
        &mut carrier,
    );
    assert!(
        carrier["traceparent"].contains(&parent.trace_id().to_string()),
        "{carrier:?}"
    );
}
