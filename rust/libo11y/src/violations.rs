//! The `o11y.schema.violations` counter: one count per attribute the policy
//! drops or rewrites, by signal and rule.

use opentelemetry::metrics::{Counter, MeterProvider};
use opentelemetry::{Context, InstrumentationScope, KeyValue};

use libo11y_spec::{Signal, attr, metric};

use crate::{Rule, Violations};

/// The instrumentation scope of the telemetry libo11y emits about itself.
/// Go names its module path and TypeScript its package; the Rust library
/// names its crate.
pub(crate) const SCOPE_NAME: &str = "libo11y";

/// The scope with the crate's version.
pub(crate) fn scope() -> InstrumentationScope {
    InstrumentationScope::builder(SCOPE_NAME)
        .with_version(env!("CARGO_PKG_VERSION"))
        .build()
}

/// Counts specification violations on `o11y.schema.violations`.
#[derive(Debug, Clone)]
pub(crate) struct ViolationRecorder {
    counter: Counter<u64>,
}

impl ViolationRecorder {
    /// Creates the counter on `provider`, with Go's unit and description.
    pub(crate) fn new<P: MeterProvider + ?Sized>(provider: &P) -> Self {
        let counter = provider
            .meter_with_scope(scope())
            .u64_counter(metric::SCHEMA_VIOLATIONS)
            .with_unit("{violation}")
            .with_description("Telemetry records that violated the libo11y specification.")
            .build();
        Self { counter }
    }

    /// Counts `n` violations of `rule` on `signal` in one measurement.
    ///
    /// The measurement runs under an empty context, as Go records it under
    /// `context.Background()`: classification often runs where no record's
    /// context applies (a span exporter's batch), and the count has no use
    /// for an exemplar linking it to whatever span happens to be current.
    pub(crate) fn add(&self, signal: Signal, rule: Rule, n: u64) {
        if n == 0 {
            return;
        }
        let _empty = Context::new().attach();
        self.counter.add(
            n,
            &[
                KeyValue::new(attr::SIGNAL, signal.as_str()),
                KeyValue::new(attr::RULE, rule.as_str()),
            ],
        );
    }

    /// Counts every violation in `violations` on `signal`.
    pub(crate) fn add_all(&self, signal: Signal, violations: &Violations) {
        for (rule, n) in violations {
            self.add(signal, rule, n);
        }
    }
}
