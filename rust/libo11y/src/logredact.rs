//! Sensitivity classification for log attributes (both flat and nested
//! `AnyValue::Map`/`AnyValue::ListAny`) and the [`RedactingLogProcessor`] that
//! guards `SdkLoggerProvider` against non-libo11y log bridges.
//!
//! Mirrors Go's `logredact.go` and `logprocessor.go`: maps and lists under an
//! unclassified key are walked on their dotted effective keys up to depth 16
//! and a node budget of 2048. The walk fails closed: past the depth limit or
//! once the node budget is spent, unexamined composites or remaining members
//! are dropped rather than forwarded uninspected. Maps or lists emptied by
//! classification are dropped.

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use opentelemetry::logs::{AnyValue, LogRecord as _, Logger as _, LoggerProvider as _};
use opentelemetry::{InstrumentationScope, Key};
use opentelemetry_sdk::error::OTelSdkResult;
use opentelemetry_sdk::logs::{LogProcessor, SdkLogRecord, SdkLogger, SdkLoggerProvider};

use libo11y_spec::Signal;

use crate::violations::ViolationRecorder;
use crate::{Decision, Policy, Violations};

/// Maximum composite nesting depth walked for log attributes (matches Go's
/// `maxCompositeDepth`).
pub(crate) const MAX_COMPOSITE_DEPTH: usize = 16;

/// Maximum nodes visited while walking one top-level log attribute (matches
/// Go's `compositeWalkBudget`).
pub(crate) const COMPOSITE_WALK_BUDGET: usize = 2048;

thread_local! {
    /// Depth counter set while libo11y's own OTLP leg emits a record it has
    /// already classified, so [`RedactingLogProcessor`] leaves it untouched
    /// instead of double-counting violations or double-hashing tokens.
    static PIPELINE_CLASSIFIED: Cell<u32> = const { Cell::new(0) };
}

/// RAII guard marking the current thread as emitting an already-classified
/// OTLP log record from libo11y's own log pipeline.
pub(crate) struct PipelineClassifiedGuard;

impl PipelineClassifiedGuard {
    pub(crate) fn enter() -> Self {
        PIPELINE_CLASSIFIED.with(|depth| depth.set(depth.get().saturating_add(1)));
        Self
    }
}

impl Drop for PipelineClassifiedGuard {
    fn drop(&mut self) {
        PIPELINE_CLASSIFIED.with(|depth| depth.set(depth.get().saturating_sub(1)));
    }
}

/// Reports whether the current thread is inside libo11y's own OTLP emission.
pub(crate) fn is_pipeline_classified() -> bool {
    PIPELINE_CLASSIFIED.with(|depth| depth.get() > 0)
}

/// Remaining node budget for one composite attribute walk.
struct WalkBudget {
    remaining: usize,
}

impl WalkBudget {
    const fn new() -> Self {
        Self {
            remaining: COMPOSITE_WALK_BUDGET,
        }
    }

    fn spend(&mut self) -> bool {
        if let Some(next) = self.remaining.checked_sub(1) {
            self.remaining = next;
            true
        } else {
            false
        }
    }
}

const fn is_composite(value: &AnyValue) -> bool {
    matches!(value, AnyValue::Map(_) | AnyValue::ListAny(_))
}

fn nested_key<'a>(prefix: &str, key: &'a str) -> Cow<'a, str> {
    if prefix.is_empty() {
        Cow::Borrowed(key)
    } else {
        Cow::Owned(format!("{prefix}.{key}"))
    }
}

/// Classifies a slice of log attributes independently, returning the kept or
/// rewritten attributes in order and the per-rule violation counts.
pub(crate) fn classify_log_attrs(
    policy: &Policy,
    attrs: &[(Key, AnyValue)],
) -> (Vec<(Key, AnyValue)>, Violations) {
    let mut violations = Violations::default();
    let mut out = Vec::with_capacity(attrs.len());
    for (key, value) in attrs {
        let mut walk = WalkBudget::new();
        if let (Some(kept), _) = classify_attr(
            policy,
            "",
            key.clone(),
            value.clone(),
            0,
            &mut walk,
            &mut violations,
        ) {
            out.push(kept);
        }
    }
    (out, violations)
}

/// Reports, without recording violations, whether `key`/`value` or any nested
/// composite member requires classification or fails a walk bound.
fn attr_needs_classification(
    policy: &Policy,
    prefix: &str,
    key: &str,
    value: &AnyValue,
    depth: usize,
    walk: &mut WalkBudget,
) -> bool {
    let effective = nested_key(prefix, key);
    if policy.decide(&effective) != Decision::Keep {
        return true;
    }
    value_needs_classification(policy, &effective, value, depth, walk)
}

fn value_needs_classification(
    policy: &Policy,
    prefix: &str,
    value: &AnyValue,
    depth: usize,
    walk: &mut WalkBudget,
) -> bool {
    if !is_composite(value) {
        return false;
    }
    if depth >= MAX_COMPOSITE_DEPTH || !walk.spend() {
        return true;
    }
    match value {
        AnyValue::Map(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_unstable_by(|(a, _), (b, _)| a.as_str().cmp(b.as_str()));
            for (k, v) in entries {
                if !walk.spend()
                    || attr_needs_classification(policy, prefix, k.as_str(), v, depth + 1, walk)
                {
                    return true;
                }
            }
            false
        }
        AnyValue::ListAny(items) => {
            for item in items.iter() {
                if is_composite(item) && !walk.spend() {
                    return true;
                }
                if value_needs_classification(policy, prefix, item, depth + 1, walk) {
                    return true;
                }
            }
            false
        }
        _ => false,
    }
}

/// Classifies one attribute at `prefix` and `depth`. Returns `(Some(attr), changed)`
/// when kept/rewritten, or `(None, true)` when dropped.
fn classify_attr(
    policy: &Policy,
    prefix: &str,
    key: Key,
    value: AnyValue,
    depth: usize,
    walk: &mut WalkBudget,
    violations: &mut Violations,
) -> (Option<(Key, AnyValue)>, bool) {
    let effective = nested_key(prefix, key.as_str());
    match policy.decide(&effective) {
        Decision::Drop(rule) => {
            violations.add(rule);
            (None, true)
        }
        Decision::Rewrite(rule) => {
            violations.add(rule);
            match policy.token_any(&value) {
                Some(token) => (Some((key, AnyValue::from(token))), true),
                None => (None, true),
            }
        }
        Decision::Keep => {
            let (out, changed) = classify_value(policy, &effective, value, depth, walk, violations);
            (out.map(|v| (key, v)), changed)
        }
    }
}

/// Classifies a value held under `prefix` at `depth`. Returns `(Some(v), changed)`
/// when surviving, or `(None, true)` when dropped (emptied or cut by depth/budget).
fn classify_value(
    policy: &Policy,
    prefix: &str,
    value: AnyValue,
    depth: usize,
    walk: &mut WalkBudget,
    violations: &mut Violations,
) -> (Option<AnyValue>, bool) {
    if !is_composite(&value) {
        return (Some(value), false);
    }
    if depth >= MAX_COMPOSITE_DEPTH || !walk.spend() {
        return (None, true);
    }
    match value {
        AnyValue::Map(map) => {
            let mut entries: Vec<_> = map.into_iter().collect();
            entries.sort_unstable_by(|(a, _), (b, _)| a.as_str().cmp(b.as_str()));
            let mut kept = HashMap::with_capacity(entries.len());
            let mut changed = false;
            for (k, v) in entries {
                if !walk.spend() {
                    changed = true;
                    break;
                }
                let (member, member_changed) =
                    classify_attr(policy, prefix, k, v, depth + 1, walk, violations);
                changed |= member_changed;
                if let Some((mk, mv)) = member {
                    kept.insert(mk, mv);
                }
            }
            if !changed {
                return (Some(AnyValue::Map(Box::new(kept))), false);
            }
            if kept.is_empty() {
                (None, true)
            } else {
                (Some(AnyValue::Map(Box::new(kept))), true)
            }
        }
        AnyValue::ListAny(items) => {
            let mut kept = Vec::with_capacity(items.len());
            let mut changed = false;
            for item in *items {
                if is_composite(&item) && !walk.spend() {
                    changed = true;
                    break;
                }
                let (elem, elem_changed) =
                    classify_value(policy, prefix, item, depth + 1, walk, violations);
                changed |= elem_changed;
                if let Some(eo) = elem {
                    kept.push(eo);
                }
            }
            if !changed {
                return (Some(AnyValue::ListAny(Box::new(kept))), false);
            }
            if kept.is_empty() {
                (None, true)
            } else {
                (Some(AnyValue::ListAny(Box::new(kept))), true)
            }
        }
        other => (Some(other), false),
    }
}

/// Returns a factory `SdkLogger` whose `create_log_record` constructs empty
/// `SdkLogRecord` instances (upstream's `SdkLogRecord::new` is `pub(crate)`).
/// The backing provider has no processors and starts no threads.
fn record_factory() -> &'static SdkLogger {
    static FACTORY: OnceLock<SdkLogger> = OnceLock::new();
    FACTORY.get_or_init(|| {
        SdkLoggerProvider::builder()
            .build()
            .logger("libo11y-redactor")
    })
}

/// A synchronous [`LogProcessor`] registered before the batch processor on
/// `SdkLoggerProvider`.
///
/// Enforces the sensitivity policy on every record emitted through
/// `SdkLoggerProvider` by third-party bridges or direct SDK logger calls,
/// counting violations once on [`Signal::Logs`]. Records emitted by libo11y's
/// own OTLP leg are already classified and marked via
/// [`PipelineClassifiedGuard`], so this processor leaves them untouched.
#[derive(Debug)]
pub(crate) struct RedactingLogProcessor {
    policy: Policy,
    recorder: ViolationRecorder,
}

impl RedactingLogProcessor {
    pub(crate) fn new(policy: Policy, recorder: ViolationRecorder) -> Self {
        Self { policy, recorder }
    }
}

impl LogProcessor for RedactingLogProcessor {
    fn emit(&self, data: &mut SdkLogRecord, _instrumentation: &InstrumentationScope) {
        if is_pipeline_classified() {
            return;
        }
        let needs = data.attributes_iter().any(|(k, v)| {
            attr_needs_classification(&self.policy, "", k.as_str(), v, 0, &mut WalkBudget::new())
        });
        if !needs {
            return;
        }

        let mut violations = Violations::default();
        let mut kept = Vec::new();
        for (k, v) in data.attributes_iter() {
            let mut walk = WalkBudget::new();
            if let (Some(attr), _) = classify_attr(
                &self.policy,
                "",
                k.clone(),
                v.clone(),
                0,
                &mut walk,
                &mut violations,
            ) {
                kept.push(attr);
            }
        }
        self.recorder.add_all(Signal::Logs, &violations);

        let mut fresh = record_factory().create_log_record();
        if let Some(event_name) = data.event_name() {
            fresh.set_event_name(event_name);
        }
        if let Some(target) = data.target() {
            fresh.set_target(target.clone());
        }
        if let Some(ts) = data.timestamp() {
            fresh.set_timestamp(ts);
        }
        if let Some(obs) = data.observed_timestamp() {
            fresh.set_observed_timestamp(obs);
        }
        if let Some(tc) = data.trace_context() {
            fresh.set_trace_context(tc.trace_id, tc.span_id, tc.trace_flags);
        }
        if let Some(st) = data.severity_text() {
            fresh.set_severity_text(st);
        }
        if let Some(sn) = data.severity_number() {
            fresh.set_severity_number(sn);
        }
        if let Some(body) = data.body() {
            fresh.set_body(body.clone());
        }
        fresh.add_attributes(kept);
        *data = fresh;
    }

    fn force_flush(&self) -> OTelSdkResult {
        Ok(())
    }

    fn shutdown_with_timeout(&self, _timeout: Duration) -> OTelSdkResult {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::time::SystemTime;

    use opentelemetry::logs::Severity;
    use opentelemetry::trace::{SpanId, TraceFlags, TraceId};
    use opentelemetry_sdk::logs::InMemoryLogExporter;

    use crate::test_support::{ViolationReader, violation_points};
    use crate::{PiiMode, Rule};

    fn policy(mode: PiiMode) -> Policy {
        Policy::new(mode, &[7; 32], HashMap::new()).expect("policy")
    }

    fn any_map(entries: Vec<(&'static str, AnyValue)>) -> AnyValue {
        AnyValue::Map(Box::new(
            entries
                .into_iter()
                .map(|(k, v)| (Key::from_static_str(k), v))
                .collect(),
        ))
    }

    #[test]
    fn nested_maps_and_lists_are_classified_and_emptied_ones_dropped() {
        let pol = policy(PiiMode::Drop);
        let input = vec![
            (
                Key::from_static_str("host"),
                AnyValue::ListAny(Box::new(vec![
                    any_map(vec![
                        ("ip", AnyValue::from("10.0.0.1")),
                        ("name", AnyValue::from("web-1")),
                    ]),
                    any_map(vec![("ip", AnyValue::from("10.0.0.2"))]),
                ])),
            ),
            (
                Key::from_static_str("host.ip"),
                any_map(vec![("v4", AnyValue::from("10.0.0.3"))]),
            ),
            (Key::from_static_str("safe"), AnyValue::from("ok")),
        ];
        let (kept, violations) = classify_log_attrs(&pol, &input);
        assert_eq!(violations.get(Rule::PiiAttribute), 3);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].0.as_str(), "host");
        assert_eq!(kept[1].0.as_str(), "safe");
        let AnyValue::ListAny(items) = &kept[0].1 else {
            panic!("expected list: {:?}", kept[0].1);
        };
        assert_eq!(items.len(), 1, "emptied map element was dropped");
        let AnyValue::Map(map) = &items[0] else {
            panic!("expected map: {:?}", items[0]);
        };
        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get(&Key::from_static_str("name")),
            Some(&AnyValue::from("web-1"))
        );
    }

    #[test]
    fn depth_bound_fails_closed() {
        let pol = policy(PiiMode::Drop);
        // Build a nested map 20 levels deep (exceeds MAX_COMPOSITE_DEPTH = 16).
        let mut val = AnyValue::from("leaf");
        for _ in 0..20 {
            val = any_map(vec![("n", val)]);
        }
        let (kept, _) = classify_log_attrs(&pol, &[(Key::from_static_str("deep"), val)]);
        assert!(
            kept.is_empty(),
            "overly deep composite drops cleanly when emptied: {kept:?}"
        );
    }

    #[test]
    fn budget_bound_fails_closed() {
        let pol = policy(PiiMode::Drop);
        // Build a map with more than COMPOSITE_WALK_BUDGET entries.
        let mut map = HashMap::new();
        for i in 0..(COMPOSITE_WALK_BUDGET + 50) {
            map.insert(
                Key::from(format!("k{i:04}")),
                AnyValue::Int(i64::try_from(i).expect("small")),
            );
        }
        let (kept, _) = classify_log_attrs(
            &pol,
            &[(Key::from_static_str("huge"), AnyValue::Map(Box::new(map)))],
        );
        assert_eq!(kept.len(), 1);
        let AnyValue::Map(surviving) = &kept[0].1 else {
            panic!("expected map");
        };
        assert!(
            surviving.len() < COMPOSITE_WALK_BUDGET,
            "remaining entries past budget were dropped: {}",
            surviving.len()
        );
    }

    #[test]
    fn redacting_processor_preserves_metadata_and_skips_pipeline_marked_records() {
        let reader = ViolationReader::new();
        let recorder = ViolationRecorder::new(reader.provider());
        let exporter = InMemoryLogExporter::default();
        let provider = SdkLoggerProvider::builder()
            .with_log_processor(RedactingLogProcessor::new(policy(PiiMode::Hash), recorder))
            .with_simple_exporter(exporter.clone())
            .build();
        let logger = provider.logger("bridge");
        let ts = SystemTime::now();

        // Direct bridge record gets classified and metadata preserved.
        let mut rec = logger.create_log_record();
        rec.set_event_name("custom.event");
        rec.set_target("bridge::mod");
        rec.set_timestamp(ts);
        rec.set_observed_timestamp(ts);
        rec.set_severity_number(Severity::Warn);
        rec.set_severity_text("WARN");
        rec.set_body(AnyValue::from("hello"));
        rec.set_trace_context(
            TraceId::from(1_u128),
            SpanId::from(2_u64),
            Some(TraceFlags::SAMPLED),
        );
        rec.add_attribute("host.ip", "10.0.0.1");
        rec.add_attribute("http.request.header.authorization", "Bearer secret");
        rec.add_attribute("safe", "keep");
        logger.emit(rec);

        // Pipeline-marked record is skipped (no double-hashing or double-counting).
        {
            let _guard = PipelineClassifiedGuard::enter();
            let mut own = logger.create_log_record();
            own.set_body(AnyValue::from("own"));
            own.add_attribute("host.ip", "hmac-sha256:already-hashed");
            logger.emit(own);
        }

        let logs = exporter.get_emitted_logs().expect("logs");
        assert_eq!(logs.len(), 2);

        let bridged = &logs[0].record;
        assert_eq!(bridged.event_name(), Some("custom.event"));
        assert_eq!(bridged.target().map(AsRef::as_ref), Some("bridge::mod"));
        assert_eq!(bridged.timestamp(), Some(ts));
        assert_eq!(bridged.observed_timestamp(), Some(ts));
        assert_eq!(bridged.severity_number(), Some(Severity::Warn));
        assert_eq!(bridged.severity_text(), Some("WARN"));
        assert_eq!(bridged.body(), Some(&AnyValue::from("hello")));
        let tc = bridged.trace_context().expect("trace context");
        assert_eq!(tc.trace_id, TraceId::from(1_u128));
        assert_eq!(tc.span_id, SpanId::from(2_u64));
        let attrs: HashMap<_, _> = bridged
            .attributes_iter()
            .map(|(k, v)| (k.as_str(), v))
            .collect();
        assert!(!attrs.contains_key("http.request.header.authorization"));
        assert_eq!(attrs.get("safe"), Some(&&AnyValue::from("keep")));
        let Some(AnyValue::String(token)) = attrs.get("host.ip") else {
            panic!("expected tokenized host.ip: {attrs:?}");
        };
        assert!(token.as_str().starts_with("hmac-sha256:"), "{token:?}");

        let own_attrs: HashMap<_, _> = logs[1]
            .record
            .attributes_iter()
            .map(|(k, v)| (k.as_str(), v))
            .collect();
        assert_eq!(
            own_attrs.get("host.ip"),
            Some(&&AnyValue::from("hmac-sha256:already-hashed")),
            "pipeline-marked record was not re-hashed"
        );

        let points = violation_points(&reader.collect());
        assert_eq!(
            points,
            [
                ("logs".to_owned(), Rule::PiiAttribute.as_str().to_owned(), 1),
                (
                    "logs".to_owned(),
                    Rule::SecretAttribute.as_str().to_owned(),
                    1
                ),
            ]
        );
    }
}
