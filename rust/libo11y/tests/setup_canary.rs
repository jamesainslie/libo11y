//! Startup canary and effective config integration tests in a dedicated test
//! binary so process-global setup state stays isolated.

mod common;

use std::io;
use std::sync::{Arc, Mutex};

use opentelemetry::logs::AnyValue;
use opentelemetry::trace::{Span as _, Tracer as _, TracerProvider as _};

use common::hermetic;
use libo11y::{BoxError, Error, LogRecord, LogSink};

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

struct FailingSink;

impl LogSink for FailingSink {
    fn emit(&self, _: &LogRecord) -> Result<(), BoxError> {
        Err("sink rejects records".into())
    }
}

struct FailingWriter;

impl io::Write for FailingWriter {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::new(io::ErrorKind::BrokenPipe, "broken console"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct ReentrantSink(Arc<Mutex<Option<String>>>);

impl LogSink for ReentrantSink {
    fn emit(&self, _: &LogRecord) -> Result<(), BoxError> {
        let err = hermetic("reentrant-inner")
            .without_console_log()
            .setup()
            .expect_err("re-entrant setup must fail fast with AlreadySetup");
        *self.0.lock().expect("lock") = Some(err.to_string());
        Ok(())
    }
}

fn global_tracer_records() -> bool {
    let span = opentelemetry::global::tracer_provider()
        .tracer("probe")
        .start("probe");
    span.span_context().is_valid()
}

#[test]
fn startup_canary_lifecycle() {
    // 1. build() emits no startup canary, while effective_config() is available.
    let build_sink = CaptureSink::default();
    let built = hermetic("build-only")
        .without_console_log()
        .with_extra_log_sink(build_sink.clone())
        .build()
        .expect("build");
    assert!(build_sink.records().is_empty(), "build() skips canary");
    assert!(built.effective_config().contains("service.name=build-only"));
    built.shutdown().expect("shutdown");

    // 2. A failing console writer fails setup BEFORE any global is installed and releases the guard.
    let err = hermetic("bad-console")
        .console_writer(FailingWriter)
        .setup()
        .expect_err("console writer failed");
    assert!(matches!(err, Error::StartupCanary(_)), "{err}");
    assert!(
        err.to_string()
            .starts_with("o11y: startup canary rejected by log pipeline: "),
        "{err}"
    );
    assert!(!global_tracer_records(), "no global tracer installed");
    assert!(
        !tracing::dispatcher::has_been_set(),
        "no global tracing subscriber installed"
    );

    // 3. A failing extra sink also fails setup before installing globals and releases the guard.
    let err = hermetic("bad-sink")
        .without_console_log()
        .with_extra_log_sink(FailingSink)
        .setup()
        .expect_err("extra sink failed");
    assert!(matches!(err, Error::StartupCanary(_)), "{err}");
    assert!(err.to_string().contains("sink rejects records"), "{err}");
    assert!(!global_tracer_records(), "no global tracer installed");
    assert!(
        !tracing::dispatcher::has_been_set(),
        "no global tracing subscriber installed"
    );

    // 4. Setup emits the canary even when log level is ERROR, and a re-entrant setup from a sink
    //    fails fast with AlreadySetup without deadlocking.
    let summary_sink = CaptureSink::default();
    let reentrant_result = Arc::new(Mutex::new(None));
    let sdk = hermetic("canary-ok")
        .without_console_log()
        .log_level(tracing::Level::ERROR)
        .with_extra_log_sink(summary_sink.clone())
        .with_extra_log_sink(ReentrantSink(Arc::clone(&reentrant_result)))
        .setup()
        .expect("setup succeeds after earlier canary failures");
    assert!(global_tracer_records());
    assert_eq!(
        reentrant_result.lock().expect("lock").as_deref(),
        Some("o11y: already set up")
    );
    let recs = summary_sink.records();
    assert_eq!(recs.len(), 1);
    assert_eq!(recs[0].event_name(), Some("o11y.telemetry.configured"));
    assert_eq!(recs[0].message(), "o11y.telemetry.configured");
    assert_eq!(
        recs[0].attr("service.name"),
        Some(&AnyValue::from("canary-ok"))
    );
    assert_eq!(
        recs[0].attr("o11y.config.level"),
        Some(&AnyValue::from("ERROR"))
    );
    sdk.shutdown().expect("shutdown");

    // 5. without_startup_summary() suppresses the canary even when a failing sink is registered.
    let silent_sink = CaptureSink::default();
    let sdk2 = hermetic("no-summary")
        .without_console_log()
        .without_startup_summary()
        .with_extra_log_sink(silent_sink.clone())
        .with_extra_log_sink(FailingSink)
        .setup()
        .expect("setup without canary succeeds");
    assert!(silent_sink.records().is_empty());
    assert!(sdk2.effective_config().contains("service.name=no-summary"));
    sdk2.shutdown().expect("shutdown");
}
