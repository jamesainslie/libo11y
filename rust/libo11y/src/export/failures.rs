//! The export failures of one signal, captured while a shutdown or a flush
//! runs.
//!
//! Upstream's batch processors export on their own threads and discard the
//! result of the final export: their shutdown reports success even when the
//! collector rejected the last batch. libo11y wraps every span and log
//! exporter so each failed export is recorded into the windows that are
//! open, one per shutdown or flush call in progress, and the call reports
//! what failed while it ran, whoever started the export. This is Go's
//! `exportFailures`, with its bound: the first five distinct errors are kept
//! and the rest are counted.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use opentelemetry_sdk::Resource;
use opentelemetry_sdk::error::{OTelSdkError, OTelSdkResult};
use opentelemetry_sdk::logs::{LogBatch, LogExporter};
use opentelemetry_sdk::metrics::Temporality;
use opentelemetry_sdk::metrics::data::ResourceMetrics;
use opentelemetry_sdk::metrics::exporter::PushMetricExporter;
use opentelemetry_sdk::trace::{SpanData, SpanExporter};

/// An error shared between the windows that recorded it.
pub(crate) type SharedError = Arc<dyn std::error::Error + Send + Sync + 'static>;

/// How many distinct export errors one call reports in full.
const MAX_WINDOW_ERRORS: usize = 5;

/// How deep the source chain of a call's own error is searched for errors
/// a window recorded too.
const MAX_CHAIN: usize = 64;

/// The open windows of one signal. Clones share them.
#[derive(Debug, Clone, Default)]
pub(crate) struct ExportFailures(Arc<Mutex<Vec<Arc<Window>>>>);

#[derive(Debug, Default)]
struct Window(Mutex<WindowState>);

#[derive(Debug, Default)]
struct WindowState {
    /// The first distinct errors, with the text that identifies them.
    errors: Vec<(String, SharedError)>,
    /// Failed exports beyond them, repeats included.
    more: usize,
}

impl Window {
    fn add(&self, err: &OTelSdkError) {
        let key = err.to_string();
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if state.errors.len() < MAX_WINDOW_ERRORS && !state.errors.iter().any(|(k, _)| *k == key) {
            state.errors.push((key, Arc::new(copy(err))));
        } else {
            state.more += 1;
        }
    }
}

/// A copy of an upstream error, which is not `Clone`.
fn copy(err: &OTelSdkError) -> OTelSdkError {
    match err {
        OTelSdkError::AlreadyShutdown => OTelSdkError::AlreadyShutdown,
        OTelSdkError::Timeout(after) => OTelSdkError::Timeout(*after),
        OTelSdkError::InternalFailure(message) => OTelSdkError::InternalFailure(message.clone()),
    }
}

impl ExportFailures {
    /// Records a failed export into every open window.
    pub(crate) fn record(&self, result: &OTelSdkResult) {
        let Err(err) = result else { return };
        let windows = self
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        for window in windows {
            window.add(err);
        }
    }

    /// Runs `call` inside a window and returns its error, if any, followed
    /// by the export failures recorded meanwhile that the error does not
    /// already carry, then a count of the failed exports beyond the first
    /// five distinct ones. Empty means nothing failed.
    pub(crate) fn during<F>(&self, call: F) -> Vec<SharedError>
    where
        F: FnOnce() -> OTelSdkResult,
    {
        let window = Arc::new(Window::default());
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Arc::clone(&window));
        let result = call();
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|open| !Arc::ptr_eq(open, &window));
        let state = std::mem::take(&mut *window.0.lock().unwrap_or_else(PoisonError::into_inner));

        let mut errors: Vec<SharedError> = Vec::new();
        let mut carried = Vec::new();
        if let Err(err) = result {
            let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&err);
            while let Some(e) = source {
                if carried.len() >= MAX_CHAIN {
                    break;
                }
                carried.push(e.to_string());
                source = e.source();
            }
            errors.push(Arc::new(err));
        }
        for (key, failure) in state.errors {
            if !carried.contains(&key) {
                errors.push(failure);
            }
        }
        if state.more > 0 {
            errors.push(Arc::new(MoreFailures { count: state.more }));
        }
        errors
    }

    /// Whether a shutdown or a flush is recording failures, for tests that
    /// time a failure into a window.
    #[cfg(test)]
    pub(crate) fn window_open(&self) -> bool {
        !self
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_empty()
    }
}

/// The count of failed exports a window did not keep.
#[derive(Debug, thiserror::Error)]
#[error("o11y: {count} more failed {}", if *.count == 1 { "export" } else { "exports" })]
pub(crate) struct MoreFailures {
    count: usize,
}

/// A span exporter whose failed exports are recorded.
#[derive(Debug)]
pub(crate) struct ObservedSpanExporter<E> {
    inner: E,
    failures: ExportFailures,
}

impl<E> ObservedSpanExporter<E> {
    pub(crate) fn new(inner: E, failures: ExportFailures) -> Self {
        Self { inner, failures }
    }
}

impl<E: SpanExporter> SpanExporter for ObservedSpanExporter<E> {
    async fn export(&self, batch: Vec<SpanData>) -> OTelSdkResult {
        let result = self.inner.export(batch).await;
        self.failures.record(&result);
        result
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.inner.shutdown_with_timeout(timeout)
    }

    fn force_flush(&self) -> OTelSdkResult {
        self.inner.force_flush()
    }

    fn set_resource(&mut self, resource: &Resource) {
        self.inner.set_resource(resource);
    }
}

/// A metric exporter whose failed exports are recorded. Upstream's
/// periodic reader reports a failed export as a bare `Failed to flush` or
/// `Failed to shutdown`, without the exporter's error.
#[derive(Debug)]
pub(crate) struct ObservedMetricExporter<E> {
    inner: E,
    failures: ExportFailures,
}

impl<E> ObservedMetricExporter<E> {
    pub(crate) fn new(inner: E, failures: ExportFailures) -> Self {
        Self { inner, failures }
    }
}

impl<E: PushMetricExporter> PushMetricExporter for ObservedMetricExporter<E> {
    async fn export(&self, metrics: &ResourceMetrics) -> OTelSdkResult {
        let result = self.inner.export(metrics).await;
        self.failures.record(&result);
        result
    }

    fn force_flush(&self) -> OTelSdkResult {
        self.inner.force_flush()
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.inner.shutdown_with_timeout(timeout)
    }

    fn temporality(&self) -> Temporality {
        self.inner.temporality()
    }
}

/// A log exporter whose failed exports are recorded.
#[derive(Debug)]
pub(crate) struct ObservedLogExporter<E> {
    inner: E,
    failures: ExportFailures,
}

impl<E> ObservedLogExporter<E> {
    pub(crate) fn new(inner: E, failures: ExportFailures) -> Self {
        Self { inner, failures }
    }
}

impl<E: LogExporter> LogExporter for ObservedLogExporter<E> {
    async fn export(&self, batch: LogBatch<'_>) -> OTelSdkResult {
        let result = self.inner.export(batch).await;
        self.failures.record(&result);
        result
    }

    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.inner.shutdown_with_timeout(timeout)
    }

    fn event_enabled(
        &self,
        level: opentelemetry::logs::Severity,
        target: &str,
        name: Option<&str>,
    ) -> bool {
        self.inner.event_enabled(level, target, name)
    }

    fn set_resource(&mut self, resource: &Resource) {
        self.inner.set_resource(resource);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(message: &str) -> OTelSdkResult {
        Err(OTelSdkError::InternalFailure(message.to_owned()))
    }

    fn texts(errors: &[SharedError]) -> Vec<String> {
        errors.iter().map(ToString::to_string).collect()
    }

    // go/exportfailures_internal_test.go
    // TestFailureWindowDeduplicatesUncomparableErrors.
    #[test]
    fn an_error_the_call_also_returns_is_reported_once() {
        let failures = ExportFailures::default();
        let errors = failures.during(|| {
            failures.record(&failure("export rejected"));
            failure("export rejected")
        });
        assert_eq!(texts(&errors), ["Operation failed: export rejected"]);
    }

    // TestFailureWindowKeepsFirstDistinctErrors.
    #[test]
    fn the_first_distinct_errors_are_kept_and_the_rest_counted() {
        let failures = ExportFailures::default();
        let errors = failures.during(|| {
            for i in 0..100 {
                failures.record(&failure(&format!("failure {i}")));
                failures.record(&failure("failure 0"));
            }
            Ok(())
        });
        let texts = texts(&errors);
        assert_eq!(texts.len(), MAX_WINDOW_ERRORS + 1, "{texts:?}");
        for (i, text) in texts.iter().take(MAX_WINDOW_ERRORS).enumerate() {
            assert_eq!(*text, format!("Operation failed: failure {i}"));
        }
        assert_eq!(
            texts[MAX_WINDOW_ERRORS],
            format!("o11y: {} more failed exports", 200 - MAX_WINDOW_ERRORS)
        );
    }

    // TestFailureWindowCountsOneInTheSingular.
    #[test]
    fn one_more_failure_is_singular() {
        let failures = ExportFailures::default();
        let errors = failures.during(|| {
            for i in 0..=MAX_WINDOW_ERRORS {
                failures.record(&failure(&format!("failure {i}")));
            }
            Ok(())
        });
        assert_eq!(
            errors.last().map(ToString::to_string).as_deref(),
            Some("o11y: 1 more failed export")
        );
    }

    #[test]
    fn a_failure_outside_any_window_is_not_reported() {
        let failures = ExportFailures::default();
        failures.record(&failure("before"));
        assert!(failures.during(|| Ok(())).is_empty());
        failures.record(&failure("after"));
        assert!(!failures.window_open());
    }

    #[test]
    fn overlapping_windows_each_report_the_failure() {
        let failures = ExportFailures::default();
        let outer = failures.during(|| {
            let inner = failures.during(|| {
                failures.record(&failure("shared"));
                Ok(())
            });
            assert_eq!(texts(&inner), ["Operation failed: shared"]);
            Ok(())
        });
        assert_eq!(texts(&outer), ["Operation failed: shared"]);
    }

    #[test]
    fn the_call_error_comes_first() {
        let failures = ExportFailures::default();
        let errors = failures.during(|| {
            failures.record(&failure("batch"));
            Err(OTelSdkError::Timeout(Duration::from_secs(1)))
        });
        assert_eq!(
            texts(&errors),
            ["Operation timed out after 1s", "Operation failed: batch"]
        );
    }
}
