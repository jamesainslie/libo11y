//! Correlation, exemplar, and full correlation-triangle tests for
//! [`libo11y_test::Recorder`].

use opentelemetry::{Key, KeyValue};
use opentelemetry_sdk::metrics::{Aggregation, Instrument, Stream};

use libo11y::ExemplarFilter;
use libo11y_test::Recorder;

#[test]
fn full_correlation_triangle_across_counter_histogram_and_gauge() {
    let rec = Recorder::start("checkout");

    rec.in_scope(|| {
        let _span = tracing::info_span!("checkout.handle").entered();
        tracing::info!(order.id = "ord-42", "order accepted");

        let meter = rec.sdk().meter("checkout");
        meter.u64_counter("orders.processed").build().add(1, &[]);
        meter
            .f64_histogram("checkout.duration")
            .build()
            .record(0.25, &[]);
        meter
            .f64_gauge("checkout.amount")
            .build()
            .record(49.95, &[]);
        meter.i64_gauge("checkout.items").build().record(3, &[]);
    });

    let spans = rec.spans();
    assert_eq!(spans.len(), 1);
    let want_trace = spans[0].span_context.trace_id().to_string();
    let want_span = spans[0].span_context.span_id().to_string();

    let logs = rec.logs();
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0].trace_id().as_deref(), Some(want_trace.as_str()));
    assert_eq!(logs[0].span_id().as_deref(), Some(want_span.as_str()));

    rec.assert_correlated();
    rec.assert_conforms();

    for (name, expected_val) in [
        ("orders.processed", 1.0_f64),
        ("checkout.duration", 0.25_f64),
        ("checkout.amount", 49.95_f64),
        ("checkout.items", 3.0_f64),
    ] {
        let exemplars = rec.exemplars(name);
        assert_eq!(exemplars.len(), 1, "{name}: expected 1 exemplar");
        assert_eq!(exemplars[0].trace_id, want_trace, "{name}");
        assert_eq!(exemplars[0].span_id, want_span, "{name}");
        assert!(
            (exemplars[0].value - expected_val).abs() < 1e-9,
            "{name}: got {}, want {expected_val}",
            exemplars[0].value
        );
        rec.assert_triangle(name);
    }
}

#[test]
fn exponential_histogram_exemplars_cover_int_and_double() {
    let rec = Recorder::start_with("expo-svc", |b| {
        b.with_view(|inst: &Instrument| {
            if inst.name().starts_with("expo.") {
                Stream::builder()
                    .with_aggregation(Aggregation::Base2ExponentialHistogram {
                        max_size: 160,
                        max_scale: 20,
                        record_min_max: true,
                    })
                    .build()
                    .ok()
            } else {
                None
            }
        })
    })
    .expect("recorder");

    rec.in_scope(|| {
        let _span = tracing::info_span!("expo.op").entered();
        tracing::info!("expo recorded");
        let meter = rec.sdk().meter("svc");
        meter.f64_histogram("expo.float").build().record(0.5, &[]);
        meter.u64_histogram("expo.int").build().record(7, &[]);
    });

    let want_trace = rec.spans()[0].span_context.trace_id().to_string();
    for (name, want_val) in [("expo.float", 0.5_f64), ("expo.int", 7.0_f64)] {
        let exemplars = rec.exemplars(name);
        assert_eq!(exemplars.len(), 1, "{name}");
        assert_eq!(exemplars[0].trace_id, want_trace, "{name}");
        assert!((exemplars[0].value - want_val).abs() < 1e-9, "{name}");
        rec.assert_triangle(name);
    }
}

#[test]
fn exemplar_filtered_attributes_and_filters() {
    // Filtered attributes preserved on view-projected metrics.
    let rec = Recorder::start_with("filtered-ex", |b| {
        b.with_view(|inst: &Instrument| {
            if inst.name() == "requests" {
                Stream::builder()
                    .with_allowed_attribute_keys([Key::from_static_str("route")])
                    .build()
                    .ok()
            } else {
                None
            }
        })
    })
    .expect("recorder");

    rec.in_scope(|| {
        let _span = tracing::info_span!("req").entered();
        rec.sdk().meter("svc").u64_counter("requests").build().add(
            1,
            &[
                KeyValue::new("route", "/items"),
                KeyValue::new("request.id", "req-9"),
            ],
        );
    });

    let exemplars = rec.exemplars("requests");
    assert_eq!(exemplars.len(), 1);
    assert_eq!(
        exemplars[0].filtered_attributes,
        vec![("request.id".to_owned(), "req-9".to_owned())]
    );

    // Default TraceBased records no exemplar outside a span.
    let rec = Recorder::start("no-span-ex");
    rec.sdk()
        .meter("svc")
        .u64_counter("bg.jobs")
        .build()
        .add(1, &[]);
    assert!(rec.exemplars("bg.jobs").is_empty());

    // AlwaysOff records no exemplar even inside a sampled span.
    let rec = Recorder::start_with("always-off", |b| {
        b.exemplar_filter(ExemplarFilter::AlwaysOff)
    })
    .expect("recorder");
    rec.in_scope(|| {
        let _span = tracing::info_span!("op").entered();
        rec.sdk()
            .meter("svc")
            .u64_counter("hits")
            .build()
            .add(1, &[]);
    });
    assert!(rec.exemplars("hits").is_empty());

    // AlwaysOn records exemplar outside a span with empty trace/span IDs.
    let rec = Recorder::start_with("always-on", |b| b.exemplar_filter(ExemplarFilter::AlwaysOn))
        .expect("recorder");
    rec.sdk()
        .meter("svc")
        .u64_counter("hits")
        .build()
        .add(5, &[]);
    let exemplars = rec.exemplars("hits");
    assert_eq!(exemplars.len(), 1);
    assert!(exemplars[0].trace_id.is_empty());
    assert!(exemplars[0].span_id.is_empty());
    assert!((exemplars[0].value - 5.0).abs() < 1e-9);
}

#[test]
fn check_triangle_fails_when_legs_missing_or_disjoint() {
    // Missing logs and exemplars.
    let rec = Recorder::start("missing-legs");
    rec.in_scope(|| {
        let _span = tracing::info_span!("only-span").entered();
    });
    let problems = rec
        .check_triangle("orders.placed")
        .expect_err("missing logs and exemplars");
    let joined = problems.join("\n");
    assert!(joined.contains("no correlated logs"), "{joined}");
    assert!(joined.contains("no trace-linked exemplars"), "{joined}");

    // All three legs present, but from disjoint traces.
    let rec = Recorder::start("disjoint-traces");
    rec.in_scope(|| {
        {
            let _span1 = tracing::info_span!("trace-a").entered();
            tracing::info!("logged in trace A");
        }
        {
            let _span2 = tracing::info_span!("trace-b").entered();
            rec.sdk()
                .meter("svc")
                .u64_counter("orders.placed")
                .build()
                .add(1, &[]);
        }
    });
    let problems = rec
        .check_triangle("orders.placed")
        .expect_err("disjoint trace IDs");
    assert!(
        problems.join("\n").contains("no common trace_id shared"),
        "{problems:?}"
    );
}

#[test]
fn event_in_context_attaches_explicit_context_for_extra_sinks() {
    use opentelemetry::Context;
    use opentelemetry::trace::{
        SpanContext, SpanId, TraceContextExt as _, TraceFlags, TraceId, TraceState,
    };

    let rec = Recorder::start("explicit-cx");

    // 1. Inside an active span, event_in_context(&Context::new(), ...) must
    //    capture NO span context rather than leaking the ambient span.
    rec.in_scope(|| {
        let _span = tracing::info_span!("ambient").entered();
        rec.sdk()
            .event_in_context(&Context::new(), "custom.uncorrelated", []);
    });

    // 2. Outside any active span, event_in_context(&explicit_cx, ...) must
    //    preserve the exact SpanContext (including trace_flags and is_remote).
    let explicit_sc = SpanContext::new(
        TraceId::from(0x0123_4567_89ab_cdef_u128),
        SpanId::from(0xfeed_face_u64),
        TraceFlags::default(), // unsampled
        true,                  // remote
        TraceState::default(),
    );
    let explicit_cx = Context::new().with_remote_span_context(explicit_sc.clone());
    rec.sdk()
        .event_in_context(&explicit_cx, "custom.explicit", []);

    let logs = rec.logs();
    assert_eq!(logs.len(), 2);

    assert_eq!(logs[0].event_name(), Some("custom.uncorrelated"));
    assert!(
        logs[0].span_context().is_none(),
        "uncorrelated event_in_context leaked ambient span context: {:?}",
        logs[0].span_context()
    );
    assert!(logs[0].trace_id().is_none());

    assert_eq!(logs[1].event_name(), Some("custom.explicit"));
    assert_eq!(logs[1].span_context(), Some(&explicit_sc));
    assert_eq!(
        logs[1].trace_id().as_deref(),
        Some(explicit_sc.trace_id().to_string().as_str())
    );

    rec.assert_correlated();
}

#[test]
#[should_panic(expected = "triangle check failed:")]
fn assert_triangle_panics_when_broken() {
    let rec = Recorder::start("panic-triangle");
    rec.assert_triangle("missing.metric");
}
