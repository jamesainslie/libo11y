//! Contract-bearing events (`Sdk::event`, `Sdk::event_in_context`) and
//! shutdown drop reporting (`o11y.telemetry.dropped`).

use std::collections::HashMap;
use std::time::SystemTime;

use opentelemetry::logs::AnyValue;
use opentelemetry::{Context, Key, KeyValue};
use tracing::Level;

use libo11y_spec::{EVENT_NAME_KEY, attr, event};

use crate::BoxError;
use crate::lifecycle::SignalFailure;
use crate::log_layer::value_to_any;
use crate::sdk::Sdk;
use crate::violations::SCOPE_NAME;

/// Attribute count up to which [`dedupe_attrs`] scans pairwise instead of
/// building a map, matching Go's `smallAttrsLen`.
const SMALL_ATTRS_LEN: usize = 8;

impl Sdk {
    /// Emits a contract-bearing event: a log record identified by `name`,
    /// exempt from level gating (via force-emit), and correlated to the active
    /// span in [`opentelemetry::Context::current`].
    ///
    /// Any caller-supplied `event.name` attribute is stripped (the library
    /// always stamps `event.name = name` first). Duplicate keys are
    /// deduplicated last-wins, preserving the position of each key's last
    /// occurrence.
    pub fn event(&self, name: impl Into<String>, attrs: impl IntoIterator<Item = KeyValue>) {
        self.event_in_context(&Context::current(), name, attrs);
    }

    /// Like [`Sdk::event`], but correlates the event to the span in `cx`
    /// rather than the current thread's context.
    pub fn event_in_context(
        &self,
        cx: &Context,
        name: impl Into<String>,
        attrs: impl IntoIterator<Item = KeyValue>,
    ) {
        let name = name.into();
        let _ = self.emit_event(cx, &name, attrs);
    }

    /// Structural force-emit path shared by [`Sdk::event`], the startup
    /// summary canary, and shutdown drop reporting. Returns any sink error so
    /// the startup canary can fail setup.
    pub(crate) fn emit_event(
        &self,
        cx: &Context,
        name: &str,
        attrs: impl IntoIterator<Item = KeyValue>,
    ) -> Result<(), BoxError> {
        let cleaned = event_attrs(
            attrs
                .into_iter()
                .map(|kv| (kv.key, value_to_any(kv.value)))
                .collect(),
        );
        let mut out = Vec::with_capacity(cleaned.len() + 1);
        out.push((
            Key::from_static_str(EVENT_NAME_KEY),
            AnyValue::from(name.to_owned()),
        ));
        out.extend(cleaned);
        self.0.log_pipeline.dispatch(
            cx,
            SystemTime::now(),
            Level::INFO,
            name,
            SCOPE_NAME,
            None,
            out,
            true,
        )
    }

    /// Emits `o11y.telemetry.dropped` to surviving sinks when a signal fails
    /// to shut down cleanly.
    pub(crate) fn emit_dropped_event(&self, failure: &SignalFailure) {
        self.event_in_context(
            &Context::new(),
            event::TELEMETRY_DROPPED,
            [
                KeyValue::new(attr::SIGNAL, failure.signal().as_str()),
                KeyValue::new("error.type", failure.error_type()),
            ],
        );
    }
}

/// Strips any caller-supplied `event.name` attribute and deduplicates keys
/// last-wins, preserving the position of the last occurrence of each key.
pub(crate) fn event_attrs(attrs: Vec<(Key, AnyValue)>) -> Vec<(Key, AnyValue)> {
    let filtered: Vec<_> = attrs
        .into_iter()
        .filter(|(k, _)| k.as_str() != EVENT_NAME_KEY)
        .collect();
    dedupe_attrs(filtered)
}

/// Keeps the last occurrence of each non-empty key, preserving the order of
/// those survivors. Empty-key attributes always pass through, matching Go.
fn dedupe_attrs(attrs: Vec<(Key, AnyValue)>) -> Vec<(Key, AnyValue)> {
    let len = attrs.len();
    if len <= SMALL_ATTRS_LEN {
        let mut keep = vec![true; len];
        for i in 0..len {
            let key = attrs[i].0.as_str();
            if key.is_empty() {
                continue;
            }
            if attrs[i + 1..].iter().any(|(b, _)| b.as_str() == key) {
                keep[i] = false;
            }
        }
        return attrs
            .into_iter()
            .zip(keep)
            .filter_map(|(attr, k)| k.then_some(attr))
            .collect();
    }

    let mut last: HashMap<&str, usize> = HashMap::with_capacity(len);
    for (i, (k, _)) in attrs.iter().enumerate() {
        last.insert(k.as_str(), i);
    }
    let keep: Vec<bool> = attrs
        .iter()
        .enumerate()
        .map(|(i, (k, _))| k.as_str().is_empty() || last.get(k.as_str()) == Some(&i))
        .collect();
    attrs
        .into_iter()
        .zip(keep)
        .filter_map(|(attr, k)| k.then_some(attr))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_attrs_strips_event_name_and_dedupes_last_wins_in_order() {
        let attrs = vec![
            (
                Key::from_static_str("event.name"),
                AnyValue::from("spoofed"),
            ),
            (Key::from_static_str("a"), AnyValue::Int(1)),
            (Key::from_static_str("b"), AnyValue::Int(2)),
            (Key::from_static_str("a"), AnyValue::Int(3)),
            (Key::from_static_str("c"), AnyValue::Int(4)),
        ];
        let got = event_attrs(attrs);
        assert_eq!(
            got,
            vec![
                (Key::from_static_str("b"), AnyValue::Int(2)),
                (Key::from_static_str("a"), AnyValue::Int(3)),
                (Key::from_static_str("c"), AnyValue::Int(4)),
            ]
        );
    }

    #[test]
    fn dedupe_attrs_handles_large_lists_with_same_order() {
        let mut attrs = Vec::new();
        for i in 0..12 {
            attrs.push((Key::from(format!("k{i}")), AnyValue::Int(i)));
        }
        attrs.push((Key::from("k1"), AnyValue::Int(100)));
        attrs.push((Key::from("k5"), AnyValue::Int(500)));
        let got = event_attrs(attrs);
        assert_eq!(got.len(), 12);
        // k1 and k5 moved to their last-occurrence positions at the end.
        assert_eq!(got[10], (Key::from("k1"), AnyValue::Int(100)));
        assert_eq!(got[11], (Key::from("k5"), AnyValue::Int(500)));
        assert_eq!(got[0], (Key::from("k0"), AnyValue::Int(0)));
        assert_eq!(got[1], (Key::from("k2"), AnyValue::Int(2)));
    }
}
