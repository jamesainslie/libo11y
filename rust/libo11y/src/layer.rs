//! libo11y's `tracing` stack: the layers [`Sdk::tracing_layer`] hands out
//! and [`Builder::setup`] installs as the global default.
//!
//! The stack is a list of boxed layers built by [`layers`] over a
//! [`PartsCell`], the SDK parts the layers read at each callback:
//!
//! 1. [`DiagnosticsLayer`] reports the warnings and errors among the
//!    OpenTelemetry crates' own diagnostic events to the error handler.
//! 2. The span layer, tracing-opentelemetry's `OpenTelemetryLayer` on the
//!    SDK's tracer, with context activation on so `Context::current()` is
//!    the entered span, behind a per-layer filter that passes every span and
//!    only `ERROR` events. An error event sets the span's status; it adds no
//!    exception event. Every event, error ones included, belongs to the
//!    logs.
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
use tracing::{Level, Metadata, Subscriber};
use tracing_subscriber::Layer;
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::registry::LookupSpan;

use crate::Error;
use crate::diagnostics::{DiagnosticsLayer, ErrorHandler, is_diagnostic, reports};

/// What the layers of one SDK read.
#[derive(Clone)]
pub(crate) struct Parts {
    /// The tracer the span layer starts spans on.
    pub(crate) tracer: SdkTracer,
    /// Where OpenTelemetry's diagnostics go.
    pub(crate) handler: ErrorHandler,
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

/// A boxed layer of the libo11y stack.
pub(crate) type BoxedLayer<S> = Box<dyn Layer<S> + Send + Sync + 'static>;

/// Whether the span layer sees `metadata`: every span, and only `ERROR`
/// events, so an error event sets the span's status and every other event
/// is a log record only.
fn span_layer_accepts(metadata: &Metadata<'_>) -> bool {
    !is_diagnostic(metadata)
        && (metadata.is_span() || (metadata.is_event() && *metadata.level() == Level::ERROR))
}

/// The libo11y layers over `cell`, in stack order. A new layer is added
/// here, and every public way to get the stack picks it up.
pub(crate) fn layers<S>(cell: &Arc<PartsCell>) -> Vec<BoxedLayer<S>>
where
    S: Subscriber + for<'span> LookupSpan<'span> + Send + Sync,
{
    let for_handler = Arc::clone(cell);
    let diagnostics = DiagnosticsLayer::new(move || Arc::clone(&for_handler.current().handler))
        .with_filter(filter_fn(reports));
    let spans = tracing_opentelemetry::OpenTelemetryLayer::new(CellTracer(Arc::clone(cell)))
        .with_context_activation(true)
        .with_error_events_to_status(true)
        .with_error_events_to_exceptions(false)
        .with_filter(filter_fn(span_layer_accepts));
    vec![Box::new(diagnostics), Box::new(spans)]
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

/// Installs libo11y's stack as the global `tracing` default the first time,
/// over `parts`, or makes the installed stack read `parts`. Callers hold
/// the setup guard, so two calls never race.
pub(crate) fn install_tracing_default(parts: Arc<Parts>) -> Result<(), Error> {
    if let Some(cell) = GLOBAL.get() {
        cell.replace(parts);
        // Layers that filter by callsite may answer differently for the new
        // parts.
        tracing::callsite::rebuild_interest_cache();
        return Ok(());
    }
    let cell = Arc::new(PartsCell::new(parts));
    let subscriber = tracing_subscriber::registry().with(layers(&cell));
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
