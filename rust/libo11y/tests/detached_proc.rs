//! Integration tests for `libo11y::detached` and `libo11y::proc` covering
//! process-global setup (`Builder::setup`) and public API behavior.

mod common;

use std::collections::HashMap;
use std::process::Command;

use opentelemetry::Context;
use opentelemetry::baggage::{BaggageExt as _, KeyValueMetadata};
use opentelemetry::trace::{Span as _, SpanId, SpanKind, TraceContextExt as _, Tracer as _};

use libo11y::{Carrier, detached, proc};

#[test]
fn global_detached_and_proc_use_setup_providers() {
    let spans = common::Ended::default();
    let sdk = common::hermetic("detached-proc-global")
        .without_console_log()
        .without_runtime_metrics()
        .without_startup_summary()
        .without_tracing_default()
        .with_span_processor(spans.clone())
        .setup()
        .expect("setup");

    // Package-level detached::capture and detached::start_linked use globals.
    let origin = opentelemetry::global::tracer("test").start("request");
    let origin_sc = origin.span_context().clone();
    let origin_cx = Context::new()
        .with_span(origin)
        .with_baggage([KeyValueMetadata::new("tenant", "acme", "")]);
    let carrier = detached::capture(&origin_cx);
    origin_cx.span().end();

    assert!(!carrier.is_empty());
    let roundtrip: Carrier = carrier.to_string().parse().expect("parse carrier");
    assert_eq!(roundtrip.span_context().span_id(), origin_sc.span_id());

    let (job_cx, mut job) = detached::start_linked_with(&Context::new(), &roundtrip, "job", |b| {
        b.with_kind(SpanKind::Consumer)
    });
    job.end();
    assert_eq!(
        job_cx.baggage().get("tenant").map(ToString::to_string),
        Some("acme".to_owned())
    );

    // Package-level proc::inject and proc::extract use the global propagator.
    let mut frame = HashMap::new();
    proc::inject(&origin_cx, &mut frame);
    assert!(frame.contains_key("traceparent"), "{frame:?}");
    assert!(frame.contains_key("baggage"), "{frame:?}");

    let extracted = proc::extract(&Context::new(), &frame);
    assert_eq!(
        extracted.span().span_context().span_id(),
        origin_sc.span_id()
    );
    assert_eq!(
        extracted.baggage().get("tenant").map(ToString::to_string),
        Some("acme".to_owned())
    );

    // Child command env carries TRACEPARENT and TRACESTATE, never baggage.
    let mut cmd = Command::new("worker");
    proc::inject_command(&origin_cx, &mut cmd);
    let pairs: Vec<(String, String)> = cmd
        .get_envs()
        .filter_map(|(k, v)| Some((k.to_str()?.to_owned(), v?.to_str()?.to_owned())))
        .collect();
    assert!(pairs.iter().any(|(k, _)| k == proc::ENV_TRACEPARENT));
    assert!(pairs.iter().any(|(k, _)| k == proc::ENV_TRACESTATE));
    assert!(!pairs.iter().any(|(k, _)| k.eq_ignore_ascii_case("baggage")));

    let from_child = proc::from_env_pairs(&Context::new(), pairs);
    assert_eq!(
        from_child.span().span_context().trace_id(),
        origin_sc.trace_id()
    );

    sdk.shutdown().expect("shutdown");

    let recorded = spans.spans();
    let job_span = recorded.iter().find(|s| s.name == "job").expect("job span");
    assert_eq!(job_span.parent_span_id, SpanId::INVALID);
    assert_eq!(job_span.span_kind, SpanKind::Consumer);
    assert_eq!(job_span.links.len(), 1);
    assert_eq!(
        job_span.links[0].span_context.span_id(),
        origin_sc.span_id()
    );
}
