//! Wide-event [`Record`] accumulation: one analytically rich record enriched
//! across the lifetime of a request and emitted once as a canonical event.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use opentelemetry::{Context, Key, KeyValue, Value};

use crate::Sdk;

/// Private context wrapper so only libo11y's helpers can attach or retrieve a
/// [`Record`] on an [`opentelemetry::Context`].
#[derive(Clone)]
struct RecordContext(Record);

/// Accumulates attributes over the life of a request into one wide event (a
/// canonical log line).
///
/// Cloning is cheap and shares the same underlying attribute map, so a
/// middleware can start a record via [`start_record`] while downstream
/// handlers enrich it concurrently via [`record_from_context`].
#[derive(Debug, Clone, Default)]
pub struct Record(Arc<Mutex<RecordInner>>);

#[derive(Debug, Default)]
struct RecordInner {
    attrs: HashMap<Key, Value>,
    order: Vec<Key>,
}

impl Record {
    /// Creates an empty wide-event record.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets or overwrites `key` with `value`, preserving first-insertion order.
    pub fn set(&self, key: impl Into<Key>, value: impl Into<Value>) {
        let key = key.into();
        let value = value.into();
        let mut inner = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if !inner.attrs.contains_key(&key) {
            inner.order.push(key.clone());
        }
        inner.attrs.insert(key, value);
    }

    /// Adds `delta` to an integer counter at `key`, creating it at `delta` if
    /// absent. If `key` currently holds a value of another kind, it is
    /// replaced by `delta` while preserving its position.
    pub fn add(&self, key: impl Into<Key>, delta: i64) {
        let key = key.into();
        let mut inner = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let next = match inner.attrs.get(&key) {
            Some(Value::I64(current)) => current.wrapping_add(delta),
            Some(_) => delta,
            None => {
                inner.order.push(key.clone());
                delta
            }
        };
        inner.attrs.insert(key, Value::I64(next));
    }

    /// Records the larger of the existing floating-point value and `value` for
    /// `key`. If `key` currently holds a value of another kind, it is replaced
    /// by `value` while preserving its position.
    pub fn max(&self, key: impl Into<Key>, value: f64) {
        let key = key.into();
        let mut inner = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match inner.attrs.get(&key) {
            Some(Value::F64(existing)) if *existing >= value => return,
            Some(_) => {}
            None => inner.order.push(key.clone()),
        }
        inner.attrs.insert(key, Value::F64(value));
    }

    /// Returns a snapshot of the accumulated attributes in first-insertion
    /// order.
    #[must_use]
    pub fn snapshot(&self) -> Vec<KeyValue> {
        let inner = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        inner
            .order
            .iter()
            .filter_map(|key| {
                inner
                    .attrs
                    .get(key)
                    .map(|value| KeyValue::new(key.clone(), value.clone()))
            })
            .collect()
    }

    /// Flushes the accumulated wide event under `name` through `sdk`,
    /// correlating with [`opentelemetry::Context::current`]. Any key in
    /// `extra_attrs` overrides the accumulated attribute of the same name via
    /// event deduplication.
    pub fn emit_event(
        &self,
        sdk: &Sdk,
        name: impl Into<String>,
        extra_attrs: impl IntoIterator<Item = KeyValue>,
    ) {
        self.emit_event_in_context(&Context::current(), sdk, name, extra_attrs);
    }

    /// Like [`Record::emit_event`], but correlates the event with `cx`.
    pub fn emit_event_in_context(
        &self,
        cx: &Context,
        sdk: &Sdk,
        name: impl Into<String>,
        extra_attrs: impl IntoIterator<Item = KeyValue>,
    ) {
        let mut attrs = self.snapshot();
        attrs.extend(extra_attrs);
        sdk.event_in_context(cx, name, attrs);
    }
}

/// Attaches a fresh [`Record`] to `cx` and returns both the derived context
/// and the shared record handle.
#[must_use]
pub fn start_record(cx: &Context) -> (Context, Record) {
    let record = Record::new();
    (cx.with_value(RecordContext(record.clone())), record)
}

/// Returns the [`Record`] attached to `cx`, or a fresh detached no-op record
/// when none is present. Never panics.
#[must_use]
pub fn record_from_context(cx: &Context) -> Record {
    cx.get::<RecordContext>()
        .map_or_else(Record::new, |entry| entry.0.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_add_max_preserve_insertion_order_and_handle_type_changes() {
        let rec = Record::new();
        rec.set("user.tier", "pro");
        rec.add("db.queries", 2);
        rec.max("downstream.max_ms", 12.5);
        rec.set("user.tier", "enterprise");
        rec.add("db.queries", 3);
        rec.max("downstream.max_ms", 8.0);
        rec.max("downstream.max_ms", 25.0);

        // Replacing a non-matching kind keeps the key's slot.
        rec.set("mixed.int", "not-an-int");
        rec.add("mixed.int", 4);
        rec.set("mixed.float", 10_i64);
        rec.max("mixed.float", 3.5);

        assert_eq!(
            rec.snapshot(),
            vec![
                KeyValue::new("user.tier", "enterprise"),
                KeyValue::new("db.queries", 5_i64),
                KeyValue::new("downstream.max_ms", 25.0_f64),
                KeyValue::new("mixed.int", 4_i64),
                KeyValue::new("mixed.float", 3.5_f64),
            ]
        );
    }

    #[test]
    fn context_helpers_share_attached_record_and_return_detached_when_absent() {
        let bare = Context::new();
        let detached = record_from_context(&bare);
        detached.set("ignored", true);
        assert!(record_from_context(&bare).snapshot().is_empty());

        let (cx, started) = start_record(&bare);
        started.set("a", 1_i64);
        let fetched = record_from_context(&cx);
        fetched.add("a", 2);
        assert_eq!(started.snapshot(), vec![KeyValue::new("a", 3_i64)]);
    }

    #[test]
    fn concurrent_mutations_are_safe() {
        let rec = Record::new();
        std::thread::scope(|s| {
            for t in 0..8 {
                let rec = rec.clone();
                s.spawn(move || {
                    for i in 0..100 {
                        rec.add("count", 1);
                        rec.max("peak", f64::from(t * 100 + i));
                    }
                });
            }
        });
        let snap = rec.snapshot();
        assert_eq!(
            snap.iter().find(|kv| kv.key.as_str() == "count"),
            Some(&KeyValue::new("count", 800_i64))
        );
        assert_eq!(
            snap.iter().find(|kv| kv.key.as_str() == "peak"),
            Some(&KeyValue::new("peak", 799.0_f64))
        );
    }
}
