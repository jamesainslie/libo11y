//! The SDK's own diagnostics: errors from asynchronous telemetry work, such
//! as a failed export, and libo11y's warnings about its configuration.
//!
//! The OpenTelemetry crates report their internal diagnostics as `tracing`
//! events under targets that start with `opentelemetry`. Every libo11y
//! layer but the diagnostics layer filters them out, so they never reach the
//! span layer or libo11y's log sinks, where a failing log exporter would
//! feed its own failures back into itself. The warnings and errors among
//! them go to the error handler; the debug and info ones are dropped. The
//! default handler writes a rate-limited line to standard error, outside
//! the telemetry pipeline, as Go's does: message
//! `o11y: telemetry error` at `WARN`, a burst of five reports refilling one
//! per 30 seconds, and a `suppressed` count after a quiet spell.

use std::fmt::{self, Write as _};
use std::io::Write as _;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Metadata, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

use libo11y_spec::{go_quote, is_go_print};

/// The handler errors are reported to.
pub(crate) type ErrorHandler = Arc<dyn Fn(&TelemetryError) + Send + Sync>;

/// The burst of reports the default handler writes before it rate limits.
const BURST: f64 = 5.0;

/// How long the default handler takes to earn one more report.
const REFILL: Duration = Duration::from_secs(30);

/// An error from asynchronous telemetry work, or a warning libo11y raises
/// about its configuration, as the error handler receives it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelemetryError {
    target: Option<String>,
    message: String,
}

impl TelemetryError {
    /// A warning of libo11y's own.
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            target: None,
            message: message.into(),
        }
    }

    /// The `tracing` target of the OpenTelemetry crate that reported the
    /// error, such as `opentelemetry_sdk`, or `None` for libo11y's own.
    #[must_use]
    pub fn target(&self) -> Option<&str> {
        self.target.as_deref()
    }

    /// What went wrong. For an OpenTelemetry diagnostic, the event's name
    /// followed by its fields, such as
    /// `BatchSpanProcessor.ExportError: error=...`.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Renders a diagnostic event: its name, its message field, then its
    /// other fields as `key=value`.
    fn from_event(event: &Event<'_>) -> Self {
        let mut fields = Fields::default();
        event.record(&mut fields);
        let metadata = event.metadata();
        let mut message = metadata.name().to_owned();
        let mut sep = ": ";
        if let Some(text) = fields.message {
            message.push_str(sep);
            message.push_str(&text);
            sep = " ";
        }
        for (key, value) in fields.rest {
            // Writing to a String cannot fail.
            let _ = write!(message, "{sep}{key}={value}");
            sep = " ";
        }
        Self {
            target: Some(metadata.target().to_owned()),
            message,
        }
    }
}

impl fmt::Display for TelemetryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TelemetryError {}

/// The fields of a diagnostic event, but its `name`, which repeats the
/// event's own name.
#[derive(Default)]
struct Fields {
    message: Option<String>,
    rest: Vec<(&'static str, String)>,
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record(field, value.to_owned());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.record(field, format!("{value:?}"));
    }
}

impl Fields {
    fn record(&mut self, field: &Field, value: String) {
        match field.name() {
            "name" => {}
            "message" => self.message = Some(value),
            key => self.rest.push((key, value)),
        }
    }
}

/// Whether `metadata` belongs to an OpenTelemetry crate's diagnostics.
pub(crate) fn is_diagnostic(metadata: &Metadata<'_>) -> bool {
    metadata.target().starts_with("opentelemetry")
}

/// The layer that reports OpenTelemetry's diagnostic warnings and errors to
/// the error handler. It runs behind a per-layer filter that passes only
/// those events ([`reports`]).
///
/// It never vetoes an event for the whole stack: `tracing-subscriber`
/// leaves its per-layer filter state behind when [`Layer::event_enabled`]
/// returns false, and the next span on the thread then misses every
/// filtered layer. The other libo11y layers filter diagnostics out instead.
pub(crate) struct DiagnosticsLayer {
    handler: Arc<dyn Fn() -> ErrorHandler + Send + Sync>,
}

impl DiagnosticsLayer {
    /// A layer that reports to the handler `current` returns at each event,
    /// so the global stack follows the SDK installed last.
    pub(crate) fn new(current: impl Fn() -> ErrorHandler + Send + Sync + 'static) -> Self {
        Self {
            handler: Arc::new(current),
        }
    }
}

impl<S: Subscriber> Layer<S> for DiagnosticsLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        if reports(event.metadata()) {
            (self.handler)()(&TelemetryError::from_event(event));
        }
    }
}

/// Whether the diagnostics layer reports `metadata`: a diagnostic event at
/// `WARN` or `ERROR`.
pub(crate) fn reports(metadata: &Metadata<'_>) -> bool {
    metadata.is_event() && is_diagnostic(metadata) && *metadata.level() <= Level::WARN
}

impl fmt::Debug for DiagnosticsLayer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DiagnosticsLayer").finish_non_exhaustive()
    }
}

/// A token bucket: a burst of [`BURST`] reports, refilling one per
/// [`REFILL`].
#[derive(Debug)]
struct RateLimiter {
    tokens: f64,
    last: Instant,
    suppressed: u64,
}

/// What the rate limiter decided for one report.
#[derive(Debug, PartialEq, Eq)]
enum Take {
    /// Write the report, noting how many were suppressed before it.
    Report { suppressed: u64 },
    /// Drop the report.
    Suppress,
}

impl RateLimiter {
    fn new(now: Instant) -> Self {
        Self {
            tokens: BURST,
            last: now,
            suppressed: 0,
        }
    }

    fn take(&mut self, now: Instant) -> Take {
        let earned = now.saturating_duration_since(self.last).as_secs_f64() / REFILL.as_secs_f64();
        self.tokens = (self.tokens + earned).min(BURST);
        self.last = now;
        if self.tokens < 1.0 {
            self.suppressed += 1;
            return Take::Suppress;
        }
        self.tokens -= 1.0;
        Take::Report {
            suppressed: std::mem::take(&mut self.suppressed),
        }
    }
}

/// The default handler: rate-limited lines to standard error.
pub(crate) fn default_handler() -> ErrorHandler {
    let limiter = Mutex::new(RateLimiter::new(Instant::now()));
    Arc::new(move |err| {
        let take = limiter
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take(Instant::now());
        if let Take::Report { suppressed } = take {
            let line = report_line(SystemTime::now(), err, suppressed);
            // Standard error is the destination of last resort: a failed
            // write has nowhere to be reported.
            let _ = std::io::stderr().lock().write_all(line.as_bytes());
        }
    })
}

/// One report as Go's slog text handler writes it: time, level, message,
/// the error, and the suppressed count when there is one.
fn report_line(now: SystemTime, err: &TelemetryError, suppressed: u64) -> String {
    let mut line = format!(
        "time={} level=WARN msg={} error={}",
        rfc3339_millis(now),
        text_value("o11y: telemetry error"),
        text_value(err.message())
    );
    if suppressed > 0 {
        let _ = write!(line, " suppressed={suppressed}");
    }
    line.push('\n');
    line
}

/// A value as slog's text handler writes it: quoted, Go style, when it is
/// empty or holds a space, `=`, `"` or a character Go does not print.
fn text_value(s: &str) -> String {
    let needs_quotes = s.is_empty()
        || s.chars()
            .any(|c| c == ' ' || c == '=' || c == '"' || !is_go_print(c));
    if needs_quotes {
        go_quote(s)
    } else {
        s.to_owned()
    }
}

/// `now` in UTC as RFC 3339 with milliseconds, the precision slog's text
/// handler writes.
fn rfc3339_millis(now: SystemTime) -> String {
    let since = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    let (year, month, day) = crate::console::civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        since.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::console::civil_from_days;

    use tracing_subscriber::layer::SubscriberExt as _;

    // go/errhandler_test.go TestRateLimitedErrorHandlerBurstThenSuppress.
    #[test]
    fn a_burst_is_reported_then_suppressed() {
        let start = Instant::now();
        let mut limiter = RateLimiter::new(start);
        let reported = (0..8)
            .filter(|_| matches!(limiter.take(start), Take::Report { .. }))
            .count();
        assert_eq!(reported, 5);
    }

    #[test]
    fn one_report_refills_per_thirty_seconds_with_the_suppressed_count() {
        let start = Instant::now();
        let mut limiter = RateLimiter::new(start);
        for _ in 0..5 {
            assert_eq!(limiter.take(start), Take::Report { suppressed: 0 });
        }
        assert_eq!(limiter.take(start), Take::Suppress);
        assert_eq!(limiter.take(start), Take::Suppress);
        let later = start + Duration::from_secs(29);
        assert_eq!(limiter.take(later), Take::Suppress);
        let refilled = start + Duration::from_secs(31);
        assert_eq!(limiter.take(refilled), Take::Report { suppressed: 3 });
        assert_eq!(limiter.take(refilled), Take::Suppress);
    }

    #[test]
    fn the_report_line_is_gos_slog_text() {
        let at = UNIX_EPOCH + Duration::from_millis(1_764_064_800_123);
        let err = TelemetryError::new("exporter unreachable");
        assert_eq!(
            report_line(at, &err, 0),
            "time=2025-11-25T10:00:00.123Z level=WARN msg=\"o11y: telemetry error\" error=\"exporter unreachable\"\n"
        );
        assert_eq!(
            report_line(at, &TelemetryError::new("x"), 3),
            "time=2025-11-25T10:00:00.123Z level=WARN msg=\"o11y: telemetry error\" error=x suppressed=3\n"
        );
    }

    #[test]
    fn dates_convert_across_eras() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(20_782), (2026, 11, 25));
    }

    fn recording() -> (ErrorHandler, Arc<Mutex<Vec<TelemetryError>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let handler: ErrorHandler = Arc::new(move |err: &TelemetryError| {
            sink.lock().expect("lock").push(err.clone());
        });
        (handler, seen)
    }

    #[test]
    fn diagnostic_warnings_and_errors_reach_the_handler() {
        use tracing_subscriber::Layer as _;
        use tracing_subscriber::filter::filter_fn;

        let (handler, reported) = recording();
        let diagnostics =
            DiagnosticsLayer::new(move || Arc::clone(&handler)).with_filter(filter_fn(reports));
        let subscriber = tracing_subscriber::registry().with(diagnostics);
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(
                name: "BatchSpanProcessor.ExportError",
                target: "opentelemetry_sdk",
                name = "BatchSpanProcessor.ExportError",
                error = "connection refused"
            );
            tracing::debug!(target: "opentelemetry-otlp", "dialing");
            tracing::error!(
                name: "Exporter.Failed",
                target: "opentelemetry",
                message = "boom",
                code = 7
            );
            tracing::warn!(target: "app", "not a diagnostic");
        });
        let reported = reported.lock().expect("lock");
        assert_eq!(
            reported
                .iter()
                .map(TelemetryError::message)
                .collect::<Vec<_>>(),
            [
                "BatchSpanProcessor.ExportError: error=connection refused",
                "Exporter.Failed: boom code=7",
            ]
        );
        assert_eq!(reported[0].target(), Some("opentelemetry_sdk"));
    }
}
