//! libo11y's `tracing` stack: the layers [`Sdk::tracing_layer`] hands out
//! and [`Builder::setup`] installs as the global default.
//!
//! The stack is a composite layer built by [`layers`] over a
//! [`PartsCell`], the SDK parts the layers read at each callback:
//!
//! 1. [`DiagnosticsLayer`] reports the warnings and errors among the
//!    OpenTelemetry crates' own diagnostic events to the error handler.
//! 2. The span layer, tracing-opentelemetry's `OpenTelemetryLayer` on the
//!    SDK's tracer, with context activation on so `Context::current()` is
//!    the entered span, behind a per-layer filter that passes spans at or above
//!    the configured span level (`INFO` by default) when telemetry is not
//!    suppressed, and only `ERROR` events. An error event sets the span's
//!    status; it adds no exception event. Every event, error ones included,
//!    belongs to the logs.
//! 3. The log layer goes after the span layer.
//!
//! Every layer runs behind a per-layer filter, and every one but the
//! diagnostics layer filters out [`is_diagnostic`] events. No layer may veto
//! an event or a span for the whole stack: a `false` from `enabled` would
//! drop spans below the log level from traces, and a `false` from
//! `event_enabled` leaves `tracing-subscriber`'s per-layer filter state
//! behind, so the next span on the thread misses every filtered layer.
//!
//! `tracing` lets a process set its global default once, so the global
//! stack is built once, over a cell whose parts each later setup replaces.
//! Span IDs then stay the registry's across setups, and a span opened under
//! one SDK closes cleanly under the next.
//!
//! [`Sdk::tracing_layer`]: crate::Sdk::tracing_layer
//! [`Builder::setup`]: crate::Builder::setup

use std::sync::{Arc, OnceLock, PoisonError, RwLock};

use opentelemetry::Context;
use opentelemetry::trace::SpanBuilder;
use opentelemetry_sdk::trace::SdkTracer;
use tracing::subscriber::Interest;
use tracing::{Level, Metadata, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::filter::{dynamic_filter_fn, filter_fn};
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::registry::LookupSpan;

use crate::Error;
use crate::diagnostics::{DiagnosticsLayer, ErrorHandler, is_diagnostic, reports};
use crate::log_layer::{LogLayer, LogPipeline};

/// What the layers of one SDK read.
#[derive(Clone)]
pub(crate) struct Parts {
    /// The tracer the span layer starts spans on.
    pub(crate) tracer: SdkTracer,
    /// Minimum verbosity for `tracing` spans exported to OpenTelemetry
    /// (defaults to `Level::INFO`, so library `DEBUG` and `TRACE` spans such as
    /// `h2` frame traces are not exported).
    pub(crate) span_level: Level,
    /// Where OpenTelemetry's diagnostics go.
    pub(crate) handler: ErrorHandler,
    /// Where application log events go.
    pub(crate) logs: Arc<LogPipeline>,
}

impl std::fmt::Debug for Parts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Parts").finish_non_exhaustive()
    }
}

/// The parts the layers read, replaceable for the global stack.
#[derive(Debug)]
pub(crate) struct PartsCell(RwLock<Arc<Parts>>);

impl PartsCell {
    pub(crate) fn new(parts: Arc<Parts>) -> Self {
        Self(RwLock::new(parts))
    }

    pub(crate) fn current(&self) -> Arc<Parts> {
        Arc::clone(&self.0.read().unwrap_or_else(PoisonError::into_inner))
    }

    fn replace(&self, parts: Arc<Parts>) {
        *self.0.write().unwrap_or_else(PoisonError::into_inner) = parts;
    }
}

/// The tracer the span layer uses: whichever SDK's tracer the cell holds
/// when a span starts.
#[derive(Debug, Clone)]
pub(crate) struct CellTracer(Arc<PartsCell>);

impl opentelemetry::trace::Tracer for CellTracer {
    type Span = opentelemetry_sdk::trace::Span;

    fn build_with_context(&self, builder: SpanBuilder, parent_cx: &Context) -> Self::Span {
        self.0
            .current()
            .tracer
            .build_with_context(builder, parent_cx)
    }
}

/// Whether `metadata` is eligible for the span layer at `span_level`:
/// non-diagnostic spans at or above `span_level`, and only `ERROR` events, so
/// an error event sets the span's status and every other event is a log record
/// only. `sqlx::query` events are excluded so raw SQL in `db.statement` or
/// `summary` cannot reach span events when a caller lowers `SQLx`'s query log
/// level to `ERROR`.
fn span_layer_eligible(metadata: &Metadata<'_>, span_level: Level) -> bool {
    if is_diagnostic(metadata) {
        return false;
    }
    if metadata.is_span() {
        *metadata.level() <= span_level
    } else {
        let target = metadata.target();
        metadata.is_event()
            && *metadata.level() == Level::ERROR
            && target != "sqlx::query"
            && !target.starts_with("sqlx::query::")
    }
}

/// Whether the log layer sees `metadata`: every non-diagnostic event, so the
/// log layer never vetoes spans or OpenTelemetry diagnostics.
fn log_layer_accepts(metadata: &Metadata<'_>) -> bool {
    !is_diagnostic(metadata) && metadata.is_event()
}

/// The libo11y layers over `cell`, in stack order. A new layer is added
/// here, and every public way to get the stack picks it up.
pub(crate) fn layers<S>(cell: Arc<PartsCell>) -> impl Layer<S> + Send + Sync + 'static
where
    S: Subscriber + for<'span> LookupSpan<'span> + Send + Sync,
{
    let for_handler = Arc::clone(&cell);
    let diagnostics = DiagnosticsLayer::new(move || Arc::clone(&for_handler.current().handler))
        .with_filter(filter_fn(reports));
    let for_spans = Arc::clone(&cell);
    let for_callsite = Arc::clone(&cell);
    let span_filter = dynamic_filter_fn(move |metadata, _ctx| {
        !Context::is_current_telemetry_suppressed()
            && span_layer_eligible(metadata, for_spans.current().span_level)
    })
    .with_callsite_filter(move |metadata| {
        if span_layer_eligible(metadata, for_callsite.current().span_level) {
            Interest::sometimes()
        } else {
            Interest::never()
        }
    });
    let spans = tracing_opentelemetry::OpenTelemetryLayer::new(CellTracer(Arc::clone(&cell)))
        .with_context_activation(true)
        .with_error_events_to_status(true)
        .with_error_events_to_exceptions(false)
        .with_filter(span_filter);
    let logs = LogLayer::new(move || Arc::clone(&cell.current().logs))
        .with_filter(filter_fn(log_layer_accepts));
    diagnostics.and_then(spans).and_then(logs)
}

/// The cell of the global stack, once libo11y installed it.
static GLOBAL: OnceLock<Arc<PartsCell>> = OnceLock::new();

/// Fails when some other code set the global `tracing` default, so setup
/// can stop before it installs anything.
pub(crate) fn check_tracing_default() -> Result<(), Error> {
    if GLOBAL.get().is_none() && tracing::dispatcher::has_been_set() {
        return Err(Error::ForeignTracingSubscriber);
    }
    Ok(())
}

/// Makes libo11y's global stack, when one is installed, read `parts`.
/// Returns whether one was installed.
pub(crate) fn follow_tracing_default(parts: Arc<Parts>) -> bool {
    let Some(cell) = GLOBAL.get() else {
        return false;
    };
    cell.replace(parts);
    // Layers that filter by callsite may answer differently for the new
    // parts.
    tracing::callsite::rebuild_interest_cache();
    true
}

/// Installs libo11y's stack as the global `tracing` default the first time,
/// over `parts`, or makes the installed stack read `parts`. Callers hold
/// the setup guard, so two calls never race.
pub(crate) fn install_tracing_default(parts: Arc<Parts>) -> Result<(), Error> {
    if follow_tracing_default(Arc::clone(&parts)) {
        return Ok(());
    }
    let cell = Arc::new(PartsCell::new(parts));
    let subscriber = tracing_subscriber::registry().with(layers(Arc::clone(&cell)));
    tracing::subscriber::set_global_default(subscriber)
        .map_err(|_| Error::ForeignTracingSubscriber)?;
    // Only the setup holding the guard gets here, and only once.
    let _ = GLOBAL.set(cell);
    #[cfg(feature = "log")]
    {
        // Another `log` logger may own the facade already; `log` records
        // then stay with it.
        let _ = tracing_log::LogTracer::init();
    }
    Ok(())
}
