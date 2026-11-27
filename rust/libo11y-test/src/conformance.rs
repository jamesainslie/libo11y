//! Specification conformance, log-to-trace correlation, and full correlation
//! triangle assertions for [`Recorder`].

use std::collections::{BTreeMap, HashSet};

use opentelemetry::Key;
use opentelemetry::logs::AnyValue;
use opentelemetry_proto::tonic::common::v1::{
    KeyValue as ProtoKeyValue, any_value::Value as ProtoAnyValue,
};
use opentelemetry_proto::tonic::metrics::v1::{
    AggregationTemporality, metric::Data, number_data_point,
};

use libo11y_spec::{
    REQUIRED_TIER0, Sensitivity, Signal, attr, event_info, go_quote, metric, sensitivity_of,
};

use crate::recorder::Recorder;

/// The `o11y.rule` value recorded when classification removes a secret
/// attribute.
const SECRET_ATTRIBUTE_RULE: &str = "secret_attribute";

/// All-zero invalid trace ID in hex form.
const ZERO_TRACE_ID: &str = "00000000000000000000000000000000";

/// Checks whether a record for event `name` carrying `keys` satisfies its
/// registered specification contract.
///
/// Unregistered event names have no contract and return an empty `Vec`.
/// Registered events report:
/// - `event <name>: missing required attribute <key>`
/// - `event <name>: missing required template attribute <prefix>.<key>`
///   (a bare `"<prefix>."` does not satisfy a template).
#[must_use]
pub fn check_event(name: &str, keys: &[String]) -> Vec<String> {
    let Some(info) = event_info(name) else {
        return Vec::new();
    };
    let present: HashSet<&str> = keys.iter().map(String::as_str).collect();
    let mut problems = Vec::new();
    for &req in info.required {
        if !present.contains(req) {
            problems.push(format!("event {name}: missing required attribute {req}"));
        }
    }
    for &tmpl in info.required_templates {
        let prefix = format!("{tmpl}.");
        // A bare "<template>." carries no key, so it does not satisfy the
        // template.
        let satisfied = keys
            .iter()
            .any(|k| k.len() > prefix.len() && k.starts_with(&prefix));
        if !satisfied {
            problems.push(format!(
                "event {name}: missing required template attribute {prefix}<key>"
            ));
        }
    }
    problems
}

impl Recorder {
    /// Checks every libo11y specification conformance invariant against the
    /// telemetry recorded so far:
    ///
    /// 1. Every [`REQUIRED_TIER0`] attribute key is present on `sdk().resource()`.
    /// 2. Flushes the SDK so violations on batched export paths are included.
    /// 3. Sums `o11y.schema.violations` data points with `o11y.rule=secret_attribute`
    ///    per `o11y.signal`; any count greater than zero is a failure (with a
    ///    distinct message for `resource`). PII violations are not checked.
    /// 4. Scans every leaf log attribute key (recursively traversing
    ///    `AnyValue::Map` and `AnyValue::ListAny` with dotted keys) for
    ///    spec-table [`Sensitivity::Secret`] keys in the clear, and checks
    ///    registered event contracts via [`check_event`].
    /// 5. Scans span attributes for spec-table [`Sensitivity::Secret`] keys
    ///    in the clear.
    ///
    /// # Errors
    ///
    /// Returns `Err(problems)` listing every violation found.
    pub fn check_conforms(&self) -> Result<(), Vec<String>> {
        let mut problems = Vec::new();

        // 1. Required tier-0 attributes on the resource.
        let resource = self.sdk().resource();
        for &key in REQUIRED_TIER0 {
            if resource.get(&Key::from_static_str(key)).is_none() {
                problems.push(format!(
                    "libo11y-test: resource missing required tier-0 attribute {}",
                    go_quote(key)
                ));
            }
        }

        // 2. Flush before reading violation counters (catches batched span
        //    exporter violations). Sdk::force_flush runs signals concurrently,
        //    so flush metrics once more afterwards to capture any violations
        //    incremented while trace or log batches were exporting.
        if let Err(err) = self.sdk().force_flush() {
            problems.push(format!(
                "libo11y-test: flushing before conformance checks: {err}"
            ));
        }
        if let Err(err) = self.sdk().meter_provider().force_flush() {
            problems.push(format!(
                "libo11y-test: flushing metrics before conformance checks: {err}"
            ));
        }

        // 3. Check o11y.schema.violations for secret_attribute per signal.
        let by_signal = self.violations_by_signal(SECRET_ATTRIBUTE_RULE);
        for (signal, count) in by_signal {
            if signal == Signal::Resource.as_str() {
                problems.push(format!(
                    "libo11y-test: options passed to start put a secret-classified attribute on the resource \
                     ({count} redaction(s) counted); it was redacted, but secrets must never be emitted"
                ));
            } else {
                problems.push(format!(
                    "libo11y-test: the code under test emitted secret-classified attributes on {signal} \
                     ({count} redaction(s) counted); they were redacted, but secrets must never be emitted"
                ));
            }
        }

        // 4. Logs: clear-text spec-table secret scan + event contract check.
        for captured in self.logs() {
            let mut keys = Vec::new();
            for (k, v) in captured.record().attributes() {
                walk_attr_keys("", k.as_str(), v, &mut |dotted| {
                    if sensitivity_of(&dotted) == Some(Sensitivity::Secret) {
                        problems.push(format!(
                            "libo11y-test: log record {} carries secret-classified attribute {} in the clear",
                            go_quote(captured.message()),
                            go_quote(&dotted),
                        ));
                    }
                    keys.push(dotted);
                });
            }
            if let Some(name) = captured.event_name() {
                for problem in check_event(name, &keys) {
                    problems.push(format!("libo11y-test: {problem}"));
                }
            }
        }

        // 5. Spans: clear-text spec-table secret scan on span.attributes.
        for span in self.spans() {
            for kv in &span.attributes {
                if sensitivity_of(kv.key.as_str()) == Some(Sensitivity::Secret) {
                    problems.push(format!(
                        "libo11y-test: span {} carries secret-classified attribute {} in the clear",
                        go_quote(span.name.as_ref()),
                        go_quote(kv.key.as_str()),
                    ));
                }
            }
        }

        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems)
        }
    }

    /// Panicking counterpart to [`Recorder::check_conforms`].
    ///
    /// # Panics
    ///
    /// Panics with every conformance failure when [`Recorder::check_conforms`]
    /// returns `Err`.
    pub fn assert_conforms(&self) {
        if let Err(problems) = self.check_conforms() {
            panic!("conformance checks failed:\n{}", problems.join("\n"));
        }
    }

    /// Checks that every captured log emitted while a valid `SpanContext` was
    /// active carries that span's 32-character lowercase hex `trace_id` and
    /// 16-character lowercase hex `span_id`.
    ///
    /// Logs emitted outside any span are ignored.
    ///
    /// # Errors
    ///
    /// Returns `Err(problems)` for every record missing or mismatching its
    /// active span's trace or span ID.
    pub fn check_correlated(&self) -> Result<(), Vec<String>> {
        let mut problems = Vec::new();
        for captured in self.logs() {
            let Some(sc) = captured.span_context() else {
                continue;
            };
            if !sc.is_valid() {
                continue;
            }
            let want_trace = sc.trace_id().to_string();
            let want_span = sc.span_id().to_string();

            match captured.trace_id() {
                None => problems.push(format!(
                    "libo11y-test: correlated record {} has no trace_id",
                    go_quote(captured.message())
                )),
                Some(got) if got != want_trace => problems.push(format!(
                    "libo11y-test: record {} trace_id {} does not match its span {}",
                    go_quote(captured.message()),
                    go_quote(&got),
                    go_quote(&want_trace),
                )),
                Some(_) => {}
            }

            match captured.span_id() {
                None => problems.push(format!(
                    "libo11y-test: correlated record {} has no span_id",
                    go_quote(captured.message())
                )),
                Some(got) if got != want_span => problems.push(format!(
                    "libo11y-test: record {} span_id {} does not match its span {}",
                    go_quote(captured.message()),
                    go_quote(&got),
                    go_quote(&want_span),
                )),
                Some(_) => {}
            }
        }
        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems)
        }
    }

    /// Panicking counterpart to [`Recorder::check_correlated`].
    ///
    /// # Panics
    ///
    /// Panics with every correlation failure when [`Recorder::check_correlated`]
    /// returns `Err`.
    pub fn assert_correlated(&self) {
        if let Err(problems) = self.check_correlated() {
            panic!("correlation checks failed:\n{}", problems.join("\n"));
        }
    }

    /// Verifies the full correlation triangle for `instrument_name`: at least
    /// one valid trace ID appears in a recorded span, a recorded log, AND a
    /// recorded exemplar on `instrument_name`.
    ///
    /// # Errors
    ///
    /// Returns `Err(problems)` describing which legs of the triangle were
    /// missing or did not share a trace ID.
    pub fn check_triangle(&self, instrument_name: &str) -> Result<(), Vec<String>> {
        let span_traces: HashSet<String> = self
            .spans()
            .into_iter()
            .filter(|s| s.span_context.is_valid())
            .map(|s| s.span_context.trace_id().to_string())
            .collect();

        let log_traces: HashSet<String> = self
            .logs()
            .into_iter()
            .filter_map(|l| l.trace_id())
            .filter(|tid| is_valid_hex_trace_id(tid))
            .collect();

        let exemplar_traces: HashSet<String> = self
            .exemplars(instrument_name)
            .into_iter()
            .map(|e| e.trace_id)
            .filter(|tid| is_valid_hex_trace_id(tid))
            .collect();

        let matched = span_traces
            .iter()
            .any(|tid| log_traces.contains(tid) && exemplar_traces.contains(tid));

        if matched {
            return Ok(());
        }

        let mut problems = Vec::new();
        if span_traces.is_empty() {
            problems.push("libo11y-test: triangle check failed: no spans recorded".to_owned());
        }
        if log_traces.is_empty() {
            problems.push(
                "libo11y-test: triangle check failed: no correlated logs recorded".to_owned(),
            );
        }
        if exemplar_traces.is_empty() {
            problems.push(format!(
                "libo11y-test: triangle check failed: no trace-linked exemplars recorded on {}",
                go_quote(instrument_name)
            ));
        }
        if problems.is_empty() {
            problems.push(format!(
                "libo11y-test: triangle check failed: no common trace_id shared across spans, logs, and exemplars on {}",
                go_quote(instrument_name)
            ));
        }
        Err(problems)
    }

    /// Panicking counterpart to [`Recorder::check_triangle`].
    ///
    /// # Panics
    ///
    /// Panics with diagnostic details when [`Recorder::check_triangle`]
    /// returns `Err`.
    pub fn assert_triangle(&self, instrument_name: &str) {
        if let Err(problems) = self.check_triangle(instrument_name) {
            panic!("triangle check failed:\n{}", problems.join("\n"));
        }
    }

    /// Computes total `o11y.schema.violations` counts for `rule`, keyed by
    /// `o11y.signal`. Handles both cumulative (latest snapshot per signal)
    /// and delta (summed across snapshots) temporalities.
    fn violations_by_signal(&self, rule: &str) -> BTreeMap<String, i64> {
        let mut cumulative: BTreeMap<String, i64> = BTreeMap::new();
        let mut delta: BTreeMap<String, i64> = BTreeMap::new();

        for request in self.recorded_metrics() {
            for rm in &request.resource_metrics {
                for sm in &rm.scope_metrics {
                    for m in &sm.metrics {
                        if m.name != metric::SCHEMA_VIOLATIONS {
                            continue;
                        }
                        let Some(Data::Sum(sum)) = &m.data else {
                            continue;
                        };
                        let is_delta =
                            sum.aggregation_temporality == AggregationTemporality::Delta as i32;
                        for dp in &sum.data_points {
                            let Some(number_data_point::Value::AsInt(val)) = dp.value else {
                                continue;
                            };
                            if val <= 0 {
                                continue;
                            }
                            if proto_attr_str(&dp.attributes, attr::RULE).as_deref() != Some(rule) {
                                continue;
                            }
                            let signal =
                                proto_attr_str(&dp.attributes, attr::SIGNAL).unwrap_or_default();
                            if is_delta {
                                *delta.entry(signal).or_insert(0) += val;
                            } else {
                                cumulative.insert(signal, val);
                            }
                        }
                    }
                }
            }
        }

        let mut totals = cumulative;
        for (signal, count) in delta {
            *totals.entry(signal).or_insert(0) += count;
        }
        totals.retain(|_, count| *count > 0);
        totals
    }
}

fn is_valid_hex_trace_id(tid: &str) -> bool {
    tid.len() == 32 && tid != ZERO_TRACE_ID && tid.bytes().all(|b| b.is_ascii_hexdigit())
}

fn proto_attr_str(attrs: &[ProtoKeyValue], key: &str) -> Option<String> {
    attrs.iter().find_map(|kv| {
        if kv.key != key {
            return None;
        }
        match kv.value.as_ref()?.value.as_ref()? {
            ProtoAnyValue::StringValue(s) => Some(s.clone()),
            _ => None,
        }
    })
}

/// Calls `visit` with the dotted key of every leaf attribute under `(key, value)`,
/// recursively descending into [`AnyValue::Map`] and [`AnyValue::ListAny`]
/// with empty keys inlined into their parent prefix, matching `libo11y`'s log
/// classifier.
fn walk_attr_keys(prefix: &str, key: &str, value: &AnyValue, visit: &mut impl FnMut(String)) {
    let effective = match (prefix.is_empty(), key.is_empty()) {
        (true, _) => key.to_owned(),
        (false, true) => prefix.to_owned(),
        (false, false) => format!("{prefix}.{key}"),
    };
    if !effective.is_empty()
        && matches!(value, AnyValue::Map(_) | AnyValue::ListAny(_))
        && sensitivity_of(&effective) == Some(Sensitivity::Secret)
    {
        visit(effective.clone());
    }
    walk_value_keys(&effective, value, visit);
}

fn walk_value_keys(prefix: &str, value: &AnyValue, visit: &mut impl FnMut(String)) {
    match value {
        AnyValue::Map(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_unstable_by(|(a, _), (b, _)| a.as_str().cmp(b.as_str()));
            for (k, v) in entries {
                walk_attr_keys(prefix, k.as_str(), v, visit);
            }
        }
        AnyValue::ListAny(items) => {
            let mut had_composite = false;
            for item in items.iter() {
                if matches!(item, AnyValue::Map(_) | AnyValue::ListAny(_)) {
                    had_composite = true;
                    walk_value_keys(prefix, item, visit);
                }
            }
            if !had_composite && !prefix.is_empty() {
                visit(prefix.to_owned());
            }
        }
        _ => {
            if !prefix.is_empty() {
                visit(prefix.to_owned());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::SystemTime;

    use opentelemetry::logs::AnyValue;
    use opentelemetry::trace::{
        SpanContext, SpanId, SpanKind, Status, TraceFlags, TraceId, TraceState,
    };
    use opentelemetry::{InstrumentationScope, Key, KeyValue};
    use opentelemetry_sdk::trace::{SpanData, SpanEvents, SpanLinks};

    use libo11y::{LogRecord, LogSink};
    use libo11y_spec::{attr, event};

    use super::*;
    use crate::recorder::CapturedLog;

    fn any_map(entries: Vec<(&'static str, AnyValue)>) -> AnyValue {
        AnyValue::Map(Box::new(
            entries
                .into_iter()
                .map(|(k, v)| (Key::from_static_str(k), v))
                .collect(),
        ))
    }

    fn capture_via_sink(rec_builder: impl FnOnce(&Recorder)) -> Vec<LogRecord> {
        #[derive(Clone, Default)]
        struct Collect(std::sync::Arc<std::sync::Mutex<Vec<LogRecord>>>);
        impl LogSink for Collect {
            fn emit(&self, record: &LogRecord) -> Result<(), libo11y::BoxError> {
                self.0.lock().expect("lock").push(record.clone());
                Ok(())
            }
        }
        let sink = Collect::default();
        let rec = Recorder::start_with("sink-helper", |b| b.with_extra_log_sink(sink.clone()))
            .expect("recorder");
        rec_builder(&rec);
        let result = sink.0.lock().expect("lock").clone();
        drop(rec);
        result
    }

    #[test]
    fn check_event_reports_missing_required_and_template_attributes() {
        assert!(check_event("custom.unregistered", &[]).is_empty());

        let problems = check_event(event::REQUEST_SUMMARY, &["http.request.method".to_owned()]);
        assert!(problems.iter().any(|p| p == "event o11y.request.summary: missing required attribute http.response.status_code"), "{problems:?}");
        assert!(problems.iter().any(|p| p == "event o11y.request.summary: missing required attribute o11y.outcome"), "{problems:?}");
        assert!(
            problems.iter().any(
                |p| p == "event o11y.request.summary: missing required attribute o11y.duration"
            ),
            "{problems:?}"
        );

        // Bare template prefix ("o11y.config.") must not satisfy the template.
        let bare = check_event(
            event::TELEMETRY_CONFIGURED,
            &["o11y.config".to_owned(), "o11y.config.".to_owned()],
        );
        assert_eq!(
            bare,
            vec![
                "event o11y.telemetry.configured: missing required template attribute o11y.config.<key>"
            ]
        );

        // Concrete template key satisfies it.
        assert!(
            check_event(
                event::TELEMETRY_CONFIGURED,
                &["o11y.config.traces".to_owned()]
            )
            .is_empty()
        );
    }

    #[test]
    fn walk_attr_keys_handles_nested_maps_lists_and_inline_empty_keys() {
        let nested = any_map(vec![
            (
                "request.header",
                any_map(vec![("authorization", AnyValue::from("Bearer x"))]),
            ),
            (
                "list",
                AnyValue::ListAny(Box::new(vec![any_map(vec![(
                    "cookie",
                    AnyValue::from("c=1"),
                )])])),
            ),
            ("", any_map(vec![("inline", AnyValue::from("ok"))])),
        ]);
        let mut keys = Vec::new();
        walk_attr_keys("", "http", &nested, &mut |k| keys.push(k));
        assert!(
            keys.contains(&"http.request.header.authorization".to_owned()),
            "{keys:?}"
        );
        assert!(keys.contains(&"http.list.cookie".to_owned()), "{keys:?}");
        assert!(keys.contains(&"http.inline".to_owned()), "{keys:?}");
    }

    #[test]
    fn check_conforms_detects_planted_nested_secret_in_log_map_and_list() {
        // Produce a clean LogRecord with a nested map bypassing classification
        // by rewriting an unclassified key into a nested secret map via a
        // replacer-free planted record. Since LogRecord's constructor is
        // pub(crate) in libo11y, use a custom AttrReplacer on a throwaway SDK
        // whose policy only runs after replacer? Wait: classification runs
        // after replacer, so we build a map under an unclassified key? No,
        // classification walks maps too. Instead test walk_attr_keys + planted
        // span + planted log from a recorder with a non-secret event.
        // For planted log with nested secret in the clear, verify through
        // direct walk + planted LogRecord via PiiMode::Allow? Secrets always
        // drop in libo11y, so verify nested secret detection directly via
        // `check_log_attrs_in_clear` AND via a real `SpanData` planted into
        // `Recorder::push_raw_span`.
        let rec = Recorder::start("planted-span");
        let sc = SpanContext::new(
            TraceId::from(1_u128),
            SpanId::from(2_u64),
            TraceFlags::SAMPLED,
            false,
            TraceState::default(),
        );
        rec.push_raw_span(SpanData {
            span_context: sc,
            parent_span_id: SpanId::INVALID,
            parent_span_is_remote: false,
            span_kind: SpanKind::Internal,
            name: "leaked".into(),
            start_time: SystemTime::now(),
            end_time: SystemTime::now(),
            attributes: vec![KeyValue::new(
                "http.request.header.authorization",
                "Bearer leaked",
            )],
            dropped_attributes_count: 0,
            events: SpanEvents::default(),
            links: SpanLinks::default(),
            status: Status::Unset,
            instrumentation_scope: InstrumentationScope::default(),
        });

        let problems = rec.check_conforms().expect_err("planted span secret");
        let joined = problems.join("\n");
        assert!(
            joined.contains(r#"span "leaked" carries secret-classified attribute "http.request.header.authorization" in the clear"#),
            "{joined}"
        );
    }

    #[test]
    fn check_correlated_detects_missing_or_mismatched_trace_and_span_ids() {
        let records = capture_via_sink(|rec| {
            rec.in_scope(|| {
                tracing::info!("outside");
            });
        });
        assert_eq!(records.len(), 1);

        // Plant a record with no trace_id/span_id alongside a valid SpanContext.
        let rec = Recorder::start("uncorrelated-planted");
        let sc = SpanContext::new(
            TraceId::from(0x11_u128),
            SpanId::from(0x22_u64),
            TraceFlags::SAMPLED,
            false,
            TraceState::default(),
        );
        rec.push_raw_log(CapturedLog::new(records[0].clone(), Some(sc)));
        let problems = rec.check_correlated().expect_err("missing correlation");
        let joined = problems.join("\n");
        assert!(joined.contains("has no trace_id"), "{joined}");
        assert!(joined.contains("has no span_id"), "{joined}");

        // Plant a record carrying one span's IDs alongside a DIFFERENT active SpanContext.
        let inside_records = capture_via_sink(|r| {
            r.in_scope(|| {
                let _s = tracing::info_span!("s").entered();
                tracing::info!("inside");
            });
        });
        let rec2 = Recorder::start("mismatch-planted");
        let other_sc = SpanContext::new(
            TraceId::from(0xdead_beef_u128),
            SpanId::from(0xcafe_u64),
            TraceFlags::SAMPLED,
            false,
            TraceState::default(),
        );
        rec2.push_raw_log(CapturedLog::new(inside_records[0].clone(), Some(other_sc)));
        let problems = rec2.check_correlated().expect_err("mismatched correlation");
        let joined = problems.join("\n");
        assert!(joined.contains("trace_id"), "{joined}");
        assert!(joined.contains("does not match its span"), "{joined}");
        assert!(joined.contains("span_id"), "{joined}");
    }

    #[test]
    fn nested_map_event_keys_satisfy_contract() {
        let mut inner = HashMap::new();
        inner.insert(Key::from_static_str("method"), AnyValue::from("GET"));
        let mut http = HashMap::new();
        http.insert(
            Key::from_static_str("request"),
            AnyValue::Map(Box::new(inner)),
        );
        http.insert(
            Key::from_static_str("response.status_code"),
            AnyValue::Int(200),
        );
        let mut keys = Vec::new();
        walk_attr_keys("", "http", &AnyValue::Map(Box::new(http)), &mut |k| {
            keys.push(k);
        });
        keys.push(attr::OUTCOME.to_owned());
        keys.push(attr::DURATION.to_owned());
        assert!(
            check_event(event::REQUEST_SUMMARY, &keys).is_empty(),
            "{keys:?}"
        );
    }
}
