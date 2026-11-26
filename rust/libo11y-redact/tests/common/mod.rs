//! Helpers shared by the integration tests.

use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::registry::Registry;

/// The fields of every event recorded while a closure ran, as
/// `name=value` strings in recording order, each value as the subscriber
/// saw it through `record_debug`.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<String>>>);

struct FieldVisitor<'a>(&'a mut Vec<String>);

impl Visit for FieldVisitor<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.0.push(format!("{}={value:?}", field.name()));
    }
}

impl<S: Subscriber> Layer<S> for Captured {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut fields = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        event.record(&mut FieldVisitor(&mut fields));
    }
}

/// Runs `f` under a tracing subscriber local to this thread and returns
/// the recorded fields joined by single spaces.
pub fn capture_tracing(f: impl FnOnce()) -> String {
    let captured = Captured::default();
    let subscriber = Registry::default().with(captured.clone());
    tracing::subscriber::with_default(subscriber, f);
    let fields = captured.0.lock().unwrap_or_else(PoisonError::into_inner);
    fields.join(" ")
}
