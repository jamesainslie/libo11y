//! Integration tests for the log pipeline, console formatting, attribute
//! replacement, per-leg classification, `RedactingLogProcessor`, `LevelHandle`,
//! `force_emit`, `Sdk::event`, wide-event `Record`, and `o11y.telemetry.dropped`.

mod common;

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use opentelemetry::logs::{AnyValue, LogRecord as _, Logger as _, LoggerProvider as _, Severity};
use opentelemetry::trace::{
    Span as _, SpanContext, SpanId, TraceContextExt as _, TraceFlags, TraceId, TraceState,
    Tracer as _,
};
use opentelemetry::{Context, Key, KeyValue};
use opentelemetry_sdk::error::{OTelSdkError, OTelSdkResult};
use opentelemetry_sdk::logs::{LogBatch, LogExporter, SdkLogRecord};
use opentelemetry_sdk::metrics::InMemoryMetricExporter;

use common::{hermetic, violations};
use libo11y::{
    BoxError, ConsoleFormat, LevelHandle, LogRecord, LogSink, PiiMode, Sdk, Signal,
    force_emit_context, record_from_context, start_record, with_force_emit,
};

const KEY: [u8; 32] = [5; 32];

/// In-memory `io::Write` capturing console output across clones.
#[derive(Debug, Clone, Default)]
struct SharedBuffer(Arc<Mutex<Vec<u8>>>);

impl SharedBuffer {
    fn text(&self) -> String {
        String::from_utf8(self.0.lock().expect("buf").clone()).expect("utf8")
    }

    fn lines(&self) -> Vec<String> {
        self.text().lines().map(str::to_owned).collect()
    }
}

impl io::Write for SharedBuffer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("buf").extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Capturing `LogSink` for assertions on extra sinks.
#[derive(Debug, Clone, Default)]
struct CaptureSink(Arc<Mutex<Vec<LogRecord>>>);

impl CaptureSink {
    fn records(&self) -> Vec<LogRecord> {
        self.0.lock().expect("sink").clone()
    }
}

impl LogSink for CaptureSink {
    fn emit(&self, record: &LogRecord) -> Result<(), BoxError> {
        self.0.lock().expect("sink").push(record.clone());
        Ok(())
    }
}

/// In-memory `LogExporter` that keeps records through shutdown.
#[derive(Debug, Clone, Default)]
struct KeptLogs(Arc<Mutex<Vec<SdkLogRecord>>>);

impl KeptLogs {
    fn records(&self) -> Vec<SdkLogRecord> {
        self.0.lock().expect("logs").clone()
    }
}

impl LogExporter for KeptLogs {
    async fn export(&self, batch: LogBatch<'_>) -> OTelSdkResult {
        let mut guard = self.0.lock().expect("logs");
        for (record, _) in batch.iter() {
            guard.push(record.clone());
        }
        Ok(())
    }
}

/// A log exporter whose exports always fail.
#[derive(Debug, Clone)]
struct FailingLogs;

impl LogExporter for FailingLogs {
    async fn export(&self, _: LogBatch<'_>) -> OTelSdkResult {
        Err(OTelSdkError::InternalFailure("collector down".to_owned()))
    }
}

fn traced<T>(sdk: &Sdk, f: impl FnOnce() -> T) -> T {
    tracing::subscriber::with_default(sdk.subscriber(), f)
}

fn otlp_attr<'a>(record: &'a SdkLogRecord, key: &str) -> Option<&'a AnyValue> {
    record
        .attributes_iter()
        .find(|(k, _)| k.as_str() == key)
        .map(|(_, v)| v)
}

#[test]
fn console_json_and_text_formatting_and_trace_correlation() {
    let json_buf = SharedBuffer::default();
    let json_sdk = hermetic("console-json")
        .console_writer(json_buf.clone())
        .console_format(ConsoleFormat::Json)
        .log_level(tracing::Level::TRACE)
        .build()
        .expect("SDK");

    let text_buf = SharedBuffer::default();
    let text_sdk = hermetic("console-text")
        .console_writer(text_buf.clone())
        .console_format(ConsoleFormat::Text)
        .log_level(tracing::Level::TRACE)
        .build()
        .expect("SDK");

    let sc = SpanContext::new(
        TraceId::from(0x0af7_6519_16cd_43dd_8448_eb21_1c80_319c_u128),
        SpanId::from(0xb7ad_6b71_6920_3331_u64),
        TraceFlags::SAMPLED,
        true,
        TraceState::default(),
    );
    let cx = Context::new().with_remote_span_context(sc);

    {
        let _guard = cx.clone().attach();
        traced(&json_sdk, || {
            tracing::trace!(
                trace_id = "spoofed-trace",
                span_id = "spoofed-span",
                order.id = "ord-1",
                "order created"
            );
        });
        traced(&text_sdk, || {
            tracing::info!(
                trace_id = "spoofed-trace",
                span_id = "spoofed-span",
                note = "two words",
                "order created"
            );
        });
    }

    let json_lines = json_buf.lines();
    assert_eq!(json_lines.len(), 1);
    let line = &json_lines[0];
    // Verify exact key order: time, level, msg, trace_id, span_id, order.id.
    let pos_time = line.find("\"time\":\"").expect("time");
    let pos_level = line.find("\",\"level\":\"DEBUG-4\"").expect("DEBUG-4");
    let pos_msg = line.find(",\"msg\":\"order created\"").expect("msg");
    let pos_trace = line
        .find(",\"trace_id\":\"0af7651916cd43dd8448eb211c80319c\"")
        .expect("trace_id");
    let pos_span = line
        .find(",\"span_id\":\"b7ad6b7169203331\"")
        .expect("span_id");
    let pos_attr = line.find(",\"order.id\":\"ord-1\"}").expect("order.id");
    assert!(pos_time < pos_level);
    assert!(pos_level < pos_msg);
    assert!(pos_msg < pos_trace);
    assert!(pos_trace < pos_span);
    assert!(pos_span < pos_attr);
    assert!(!line.contains("spoofed"), "spoofed ids dropped: {line}");

    let text_lines = text_buf.lines();
    assert_eq!(text_lines.len(), 1);
    let tline = &text_lines[0];
    assert!(tline.starts_with("time="), "{tline}");
    assert!(
        tline.contains(" level=INFO msg=\"order created\" trace_id=0af7651916cd43dd8448eb211c80319c span_id=b7ad6b7169203331 note=\"two words\""),
        "{tline}"
    );
    assert!(!tline.contains("spoofed"), "{tline}");
}

#[test]
fn tracing_field_types_and_diagnostics_isolation() {
    let sink = CaptureSink::default();
    let otlp = KeptLogs::default();
    let sdk = hermetic("fields")
        .without_console_log()
        .with_extra_log_sink(sink.clone())
        .with_log_exporter(otlp.clone())
        .build()
        .expect("SDK");

    let io_err = io::Error::other("disk broke");
    traced(&sdk, || {
        tracing::info!(
            i = -7_i64,
            u_small = 42_u64,
            u_big = u64::MAX,
            i128_fit = -99_i128,
            i128_big = i128::MAX,
            u128_fit = 100_u128,
            u128_big = u128::MAX,
            f = 1.25_f64,
            b = true,
            s = "hello",
            dbg = ?vec![1, 2],
            err = &io_err as &dyn std::error::Error,
            "typed event"
        );
        // OpenTelemetry diagnostic must NOT reach log sinks.
        tracing::error!(target: "opentelemetry_sdk", "internal sdk noise");
    });
    sdk.force_flush().expect("flush");

    let recs = sink.records();
    assert_eq!(recs.len(), 1, "diagnostic was excluded");
    let rec = &recs[0];
    assert_eq!(rec.message(), "typed event");
    assert_eq!(rec.attr("i"), Some(&AnyValue::Int(-7)));
    assert_eq!(rec.attr("u_small"), Some(&AnyValue::Int(42)));
    assert_eq!(
        rec.attr("u_big"),
        Some(&AnyValue::from(u64::MAX.to_string()))
    );
    assert_eq!(rec.attr("i128_fit"), Some(&AnyValue::Int(-99)));
    assert_eq!(
        rec.attr("i128_big"),
        Some(&AnyValue::from(i128::MAX.to_string()))
    );
    assert_eq!(rec.attr("u128_fit"), Some(&AnyValue::Int(100)));
    assert_eq!(
        rec.attr("u128_big"),
        Some(&AnyValue::from(u128::MAX.to_string()))
    );
    assert_eq!(rec.attr("f"), Some(&AnyValue::Double(1.25)));
    assert_eq!(rec.attr("b"), Some(&AnyValue::Boolean(true)));
    assert_eq!(rec.attr("s"), Some(&AnyValue::from("hello")));
    assert_eq!(rec.attr("dbg"), Some(&AnyValue::from("[1, 2]")));
    assert_eq!(
        rec.attr("exception.message"),
        Some(&AnyValue::from("disk broke"))
    );

    // OTLP record carries source location for tracing events.
    let otlp_recs = otlp.records();
    assert_eq!(otlp_recs.len(), 1);
    assert_eq!(otlp_recs[0].severity_number(), Some(Severity::Info));
    assert_eq!(otlp_recs[0].severity_text(), Some("INFO"));
    assert!(otlp_attr(&otlp_recs[0], "code.file.path").is_some());
    assert!(otlp_attr(&otlp_recs[0], "code.line.number").is_some());
}

#[test]
fn replacer_runs_once_before_per_leg_classification_and_counts_once_per_sink() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen_trace_id = Arc::new(Mutex::new(false));
    let calls_cb = Arc::clone(&calls);
    let seen_cb = Arc::clone(&seen_trace_id);

    let console_buf = SharedBuffer::default();
    let extra = CaptureSink::default();
    let otlp = KeptLogs::default();
    let metrics = InMemoryMetricExporter::default();

    let sdk = hermetic("classify-per-leg")
        .pii_mode(PiiMode::Hash)
        .pii_hash_key(KEY)
        .console_writer(console_buf.clone())
        .with_log_exporter(otlp.clone())
        .with_extra_log_sink(extra.clone())
        .with_metric_exporter(metrics.clone())
        .with_attr_replacer(move |_groups, key, value| {
            calls_cb.fetch_add(1, Ordering::SeqCst);
            if key.as_str() == "trace_id" || key.as_str() == "span_id" {
                *seen_cb.lock().expect("lock") = true;
            }
            match key.as_str() {
                "drop.me" => None,
                "alias.ip" => Some((Key::from_static_str("host.ip"), value)),
                _ => Some((key, value)),
            }
        })
        .build()
        .expect("SDK");

    traced(&sdk, || {
        tracing::info!(
            trace_id = "user-supplied",
            span_id = "user-supplied",
            drop.me = "gone",
            alias.ip = "10.9.8.7",
            http.request.header.authorization = "Bearer s3cr3t",
            safe = "ok",
            "handled"
        );
    });
    sdk.force_flush().expect("flush");
    sdk.force_flush().expect("flush metrics");

    // Replacer ran ONCE per surviving non-reserved field: drop.me, alias.ip, auth, safe = 4.
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    assert!(
        !*seen_trace_id.lock().expect("lock"),
        "user trace_id/span_id must be dropped before replacer"
    );

    // All three legs see the same HMAC token (not double-hashed on OTLP) and drop the secret.
    let console_json: serde_json::Value =
        serde_json::from_str(&console_buf.lines()[0]).expect("json");
    let console_token = console_json["host.ip"].as_str().expect("console host.ip");
    assert!(console_token.starts_with("hmac-sha256:"), "{console_token}");
    assert!(
        console_json
            .get("http.request.header.authorization")
            .is_none()
    );
    assert!(console_json.get("drop.me").is_none());

    let extra_recs = extra.records();
    assert_eq!(extra_recs.len(), 1);
    assert_eq!(
        extra_recs[0].attr("host.ip"),
        Some(&AnyValue::from(console_token.to_owned()))
    );
    assert!(
        extra_recs[0]
            .attr("http.request.header.authorization")
            .is_none()
    );

    let otlp_recs = otlp.records();
    assert_eq!(otlp_recs.len(), 1);
    assert_eq!(
        otlp_attr(&otlp_recs[0], "host.ip"),
        Some(&AnyValue::from(console_token.to_owned())),
        "OTLP leg must hash once and match console token"
    );
    assert!(otlp_attr(&otlp_recs[0], "http.request.header.authorization").is_none());

    // 3 legs (console + OTLP + extra sink): each violation counts once per leg = 3.
    assert_eq!(
        violations(&metrics),
        [
            ("logs".to_owned(), "pii_attribute".to_owned(), 3),
            ("logs".to_owned(), "secret_attribute".to_owned(), 3),
        ]
    );
}

#[test]
fn redacting_log_processor_classifies_direct_bridge_records_and_counts_once() {
    let otlp = KeptLogs::default();
    let metrics = InMemoryMetricExporter::default();
    let sdk = hermetic("bridge")
        .without_console_log()
        .pii_mode(PiiMode::Hash)
        .pii_hash_key(KEY)
        .with_log_exporter(otlp.clone())
        .with_metric_exporter(metrics.clone())
        .build()
        .expect("SDK");

    let lp = sdk.logger_provider().expect("logger provider");
    let bridge = lp.logger("third-party-bridge");
    let mut rec = bridge.create_log_record();
    rec.set_body(AnyValue::from("from bridge"));
    rec.add_attribute("host.ip", "10.1.1.1");
    rec.add_attribute("http.request.header.cookie", "sid=secret");
    rec.add_attribute(
        "host",
        AnyValue::Map(Box::new(HashMap::from([
            (Key::from_static_str("mac"), AnyValue::from("aa:bb:cc")),
            (Key::from_static_str("name"), AnyValue::from("web-1")),
        ]))),
    );
    rec.add_attribute("safe", "kept");
    bridge.emit(rec);

    // Also emit through libo11y's own pipeline (console off -> only OTLP leg).
    traced(&sdk, || {
        tracing::info!(host.ip = "10.1.1.1", "own");
    });

    sdk.force_flush().expect("flush");
    sdk.force_flush().expect("flush metrics");

    let recs = otlp.records();
    assert_eq!(recs.len(), 2);
    let bridged = &recs[0];
    let own = &recs[1];

    assert!(otlp_attr(bridged, "http.request.header.cookie").is_none());
    assert_eq!(otlp_attr(bridged, "safe"), Some(&AnyValue::from("kept")));
    // Bridged host.ip token matches own pipeline's token.
    assert_eq!(otlp_attr(bridged, "host.ip"), otlp_attr(own, "host.ip"));
    let Some(AnyValue::Map(host_map)) = otlp_attr(bridged, "host") else {
        panic!("expected host map: {bridged:?}");
    };
    let Some(AnyValue::String(mac_token)) = host_map.get(&Key::from_static_str("mac")) else {
        panic!("expected tokenized host.mac: {host_map:?}");
    };
    assert!(
        mac_token.as_str().starts_with("hmac-sha256:"),
        "{mac_token:?}"
    );
    assert_eq!(
        host_map.get(&Key::from_static_str("name")),
        Some(&AnyValue::from("web-1"))
    );

    // Violations: bridge had 2 PII (host.ip, host.mac) + 1 secret (cookie);
    // own had 1 PII (host.ip), NOT double-counted by processor -> total 3 PII, 1 secret.
    assert_eq!(
        violations(&metrics),
        [
            ("logs".to_owned(), "pii_attribute".to_owned(), 3),
            ("logs".to_owned(), "secret_attribute".to_owned(), 1),
        ]
    );
}

#[test]
fn level_handle_updates_filtering_immediately() {
    let handle = LevelHandle::new(tracing::Level::WARN);
    let sink = CaptureSink::default();
    let sdk = hermetic("level-handle")
        .without_console_log()
        .log_level_handle(handle.clone())
        .with_extra_log_sink(sink.clone())
        .build()
        .expect("SDK");

    // Emit from the SAME callsite before and after changing the handle.
    let emit_info = |n: i64| tracing::info!(seq = n, "tick");

    traced(&sdk, || {
        emit_info(1); // dropped at WARN
        handle.set(tracing::Level::DEBUG);
        emit_info(2); // emitted at DEBUG
        tracing::debug!("debug visible");
        handle.set(tracing::Level::ERROR);
        emit_info(3); // dropped at ERROR
    });

    let msgs: Vec<_> = sink
        .records()
        .into_iter()
        .map(|r| (r.message().to_owned(), r.attr("seq").cloned()))
        .collect();
    assert_eq!(
        msgs,
        vec![
            ("tick".to_owned(), Some(AnyValue::Int(2))),
            ("debug visible".to_owned(), None),
        ]
    );
}

#[test]
fn force_emit_bypasses_level_gate_but_bare_event_name_does_not() {
    let sink = CaptureSink::default();
    let sdk = hermetic("force-emit")
        .without_console_log()
        .log_level(tracing::Level::ERROR)
        .with_extra_log_sink(sink.clone())
        .build()
        .expect("SDK");

    traced(&sdk, || {
        tracing::info!("dropped info");
        // Bare event.name without force_emit still obeys the level gate (Go event_test.go).
        tracing::info!(event.name = "app.thing", "bare event");

        // with_force_emit bypasses level gate while still redacting secrets.
        with_force_emit(|| {
            tracing::info!(
                http.request.header.authorization = "Bearer secret",
                actor = "alice",
                "audit action"
            );
        });

        // Explicit force_emit_context attached to a span context correlates too.
        let span = sdk.tracer("t").start("audit-span");
        let cx = force_emit_context(&Context::new().with_span(span));
        let _guard = cx.attach();
        tracing::debug!("forced debug in span");
    });

    let recs = sink.records();
    assert_eq!(recs.len(), 2, "{recs:?}");
    assert_eq!(recs[0].message(), "audit action");
    assert_eq!(recs[0].attr("actor"), Some(&AnyValue::from("alice")));
    assert!(recs[0].attr("http.request.header.authorization").is_none());
    assert_eq!(recs[1].message(), "forced debug in span");
    assert!(recs[1].trace_id().is_some());
    assert!(recs[1].span_id().is_some());
}

#[test]
fn sdk_event_and_wide_record_behavior() {
    let sink = CaptureSink::default();
    let otlp = KeptLogs::default();
    let sdk = hermetic("events-records")
        .without_console_log()
        .log_level(tracing::Level::ERROR)
        .with_extra_log_sink(sink.clone())
        .with_log_exporter(otlp.clone())
        .build()
        .expect("SDK");

    let span = sdk.tracer("t").start("req");
    let span_id = span.span_context().span_id();
    let trace_id = span.span_context().trace_id();
    let base_cx = Context::new().with_span(span);

    // Sdk::event strips caller event.name, dedupes last-wins, force-emits at INFO,
    // correlates to span, and has no code.file.path/code.line.number on OTLP.
    {
        let _guard = base_cx.clone().attach();
        sdk.event(
            "checkout.order.placed",
            [
                KeyValue::new("event.name", "spoofed"),
                KeyValue::new("a", 1_i64),
                KeyValue::new("b", 2_i64),
                KeyValue::new("a", 3_i64),
            ],
        );
    }

    // Wide Record with concurrent updates and context helpers.
    let (rec_cx, wide) = start_record(&base_cx);
    wide.set("http.request.method", "POST");
    std::thread::scope(|s| {
        for i in 0..4 {
            let cx_clone = rec_cx.clone();
            s.spawn(move || {
                let r = record_from_context(&cx_clone);
                r.add("db.queries", 1);
                r.max("db.slowest_ms", f64::from((i + 1) * 10));
            });
        }
    });
    wide.emit_event_in_context(
        &rec_cx,
        &sdk,
        "o11y.request.summary",
        [
            KeyValue::new("http.request.method", "GET"), // overrides wide record via dedupe
            KeyValue::new("http.response.status_code", 200_i64),
        ],
    );

    // Event emitted under uncorrelated Context::new() while a span IS active on thread.
    {
        let _guard = base_cx.attach();
        sdk.event_in_context(&Context::new(), "uncorrelated.event", []);
    }

    sdk.force_flush().expect("flush");

    let recs = sink.records();
    assert_eq!(recs.len(), 3);

    // First: checkout.order.placed
    let first = &recs[0];
    assert_eq!(first.level(), tracing::Level::INFO);
    assert_eq!(first.event_name(), Some("checkout.order.placed"));
    assert_eq!(first.trace_id(), Some(trace_id));
    assert_eq!(first.span_id(), Some(span_id));
    let keys: Vec<&str> = first.attributes().iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["event.name", "b", "a"]);
    assert_eq!(first.attr("a"), Some(&AnyValue::Int(3)));

    // Second: wide record summary
    let second = &recs[1];
    assert_eq!(second.event_name(), Some("o11y.request.summary"));
    assert_eq!(second.attr("db.queries"), Some(&AnyValue::Int(4)));
    assert_eq!(second.attr("db.slowest_ms"), Some(&AnyValue::Double(40.0)));
    assert_eq!(
        second.attr("http.request.method"),
        Some(&AnyValue::from("GET"))
    );
    assert_eq!(second.trace_id(), Some(trace_id));

    // Third: explicitly uncorrelated event carries no trace context on sink or OTLP.
    assert_eq!(recs[2].trace_id(), None);
    assert_eq!(recs[2].span_id(), None);

    let otlp_recs = otlp.records();
    assert_eq!(otlp_recs.len(), 3);
    for rec in &otlp_recs {
        assert!(
            otlp_attr(rec, "code.file.path").is_none(),
            "events carry no source file"
        );
        assert!(
            otlp_attr(rec, "code.line.number").is_none(),
            "events carry no source line"
        );
    }
    assert!(
        otlp_recs[2].trace_context().is_none(),
        "uncorrelated event_in_context must not pick up ambient thread span"
    );

    // Detached record_from_context never panics and stays isolated.
    let detached = record_from_context(&Context::new());
    detached.set("x", 1_i64);
    assert!(record_from_context(&Context::new()).snapshot().is_empty());
}

#[test]
fn without_log_export_and_with_log_exporter_precedence() {
    let off = hermetic("logs-off")
        .without_console_log()
        .with_log_exporter(KeptLogs::default())
        .without_log_export()
        .build()
        .expect("SDK");
    assert!(off.logger_provider().is_none());
    assert!(off.effective_config().contains("o11y.config.logs=none"));

    let reenabled = hermetic("logs-on")
        .without_console_log()
        .without_log_export()
        .with_log_exporter(KeptLogs::default())
        .build()
        .expect("SDK");
    assert!(reenabled.logger_provider().is_some());
    assert!(
        reenabled
            .effective_config()
            .contains("o11y.config.logs=injected")
    );
}

#[test]
fn shutdown_failure_emits_telemetry_dropped_to_surviving_sinks() {
    let console = SharedBuffer::default();
    let extra = CaptureSink::default();
    let sdk = hermetic("drop-report")
        .console_writer(console.clone())
        .with_extra_log_sink(extra.clone())
        .with_log_exporter(FailingLogs)
        .log_level(tracing::Level::ERROR)
        .build()
        .expect("SDK");

    traced(&sdk, || {
        tracing::error!("buffered log that will fail export");
    });

    let err = sdk
        .shutdown_with_timeout(Duration::from_secs(5))
        .expect_err("log export rejected");
    assert_eq!(err.failures()[0].signal(), Signal::Logs);

    let recs = extra.records();
    let dropped = recs
        .iter()
        .find(|r| r.event_name() == Some("o11y.telemetry.dropped"))
        .expect("o11y.telemetry.dropped emitted to surviving extra sink");
    assert_eq!(dropped.attr("o11y.signal"), Some(&AnyValue::from("logs")));
    assert_eq!(
        dropped.attr("error.type"),
        Some(&AnyValue::from("export_error"))
    );

    let console_text = console.text();
    assert!(
        console_text.contains("\"event.name\":\"o11y.telemetry.dropped\""),
        "{console_text}"
    );
    assert!(
        console_text.contains("\"o11y.signal\":\"logs\""),
        "{console_text}"
    );
}
