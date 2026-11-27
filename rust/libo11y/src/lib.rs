//! Opinionated OpenTelemetry setup for Rust services, following the libo11y
//! specification.
//!
//! [`Sdk::builder`] takes the service identity, the sensitivity settings,
//! the application registries, the propagators and any injected exporters,
//! and builds an [`Sdk`]: the telemetry resource, the sensitivity
//! [`Policy`] and the [`Propagator`] every signal shares, the tracer and
//! meter providers over the exporters the standard `OTEL_*` variables
//! select, and the `tracing` layers that feed them
//! ([`Sdk::tracing_layer`]).
//!
//! [`Builder::build`] touches no global state. [`Builder::setup`] also
//! installs the OpenTelemetry globals and the global `tracing` subscriber,
//! once per process at a time. [`Sdk::shutdown`] flushes and stops every
//! signal under one deadline.
//!
//! ```
//! use libo11y::{Environment, PiiMode, Sdk};
//!
//! let sdk = Sdk::builder()
//!     .service_name("checkout")
//!     .environment(Environment::Production)
//!     .build_info(libo11y::build_info!())
//!     .pii_mode(PiiMode::Drop)
//!     .without_otel_env()
//!     .build()?;
//! assert_eq!(sdk.resource().schema_url(), Some(libo11y_spec::SCHEMA_URL));
//! # Ok::<(), libo11y::Error>(())
//! ```

pub mod appregistry;
mod builder;
mod buildinfo;
mod canonical;
mod console;
mod detect;
mod diagnostics;
mod env;
mod error;
mod event;
mod export;
mod forceemit;
mod layer;
mod lifecycle;
mod log_layer;
mod logredact;
mod logs;
mod metrics;
mod policy;
mod propagation;
mod record;
mod resource;
mod sanitize;
mod sdk;
mod setup;
#[cfg(all(feature = "tokio", unix))]
mod signals;
mod summary;
mod traces;
mod violations;

pub use appregistry::AppRegistry;
pub use builder::Builder;
pub use buildinfo::BuildInfo;
pub use console::ConsoleFormat;
pub use diagnostics::TelemetryError;
pub use env::EnvLookup;
pub use error::{BoxError, Error};
pub use export::Protocol;
pub use forceemit::{force_emit_context, is_force_emit, with_force_emit};
pub use libo11y_spec::Environment;
pub use libo11y_spec::Signal;
pub use lifecycle::{DEFAULT_SHUTDOWN_TIMEOUT, FlushError, ShutdownError, SignalFailure};
pub use log_layer::{AttrReplacer, LevelHandle, LogRecord, LogSink};
pub use metrics::{
    ExemplarFilter, ExemplarSample, ExemplarValue, Libo11yMeterProvider, MemoryMetricSink,
    MetricSink,
};
/// The OpenTelemetry API this crate builds on, for the traits and types its
/// own API takes and returns.
pub use opentelemetry;
/// The OpenTelemetry protobuf definitions and transforms, for [`MetricSink`]
/// implementations.
pub use opentelemetry_proto;
/// The OpenTelemetry SDK this crate builds on, for the exporters,
/// processors and samplers its builder takes.
pub use opentelemetry_sdk;
pub use policy::{Classified, Decision, MIN_PII_HASH_KEY_LEN, PiiMode, Policy, Rule, Violations};
pub use propagation::{BoxedPropagator, Propagator};
pub use record::{Record, record_from_context, start_record};
pub use sdk::Sdk;

/// Capture-time redaction: [`Secret`](redact::Secret), [`Masked`](redact::Masked),
/// the [`Redact`](redact::Redact) trait and its derive, which renders the
/// protected form on `Display`, `Debug` and `Serialize`. This is
/// [`libo11y_redact`] re-exported, with a derive that names this path.
pub mod redact {
    pub use libo11y_macros::__RedactInLibo11y as Redact;
    pub use libo11y_redact::*;
}

/// Helpers for tests that read the shared files under `conformance/` in
/// the repository.
#[cfg(test)]
mod test_support {
    use std::path::PathBuf;

    use opentelemetry::Value;
    use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData, ResourceMetrics};
    use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};

    /// A meter provider whose metrics a test reads back.
    pub(crate) struct ViolationReader {
        exporter: InMemoryMetricExporter,
        provider: SdkMeterProvider,
    }

    impl ViolationReader {
        pub(crate) fn new() -> Self {
            let exporter = InMemoryMetricExporter::default();
            let provider = SdkMeterProvider::builder()
                .with_reader(PeriodicReader::builder(exporter.clone()).build())
                .build();
            Self { exporter, provider }
        }

        pub(crate) fn provider(&self) -> &SdkMeterProvider {
            &self.provider
        }

        /// Collects and returns everything exported so far.
        pub(crate) fn collect(&self) -> Vec<ResourceMetrics> {
            self.provider.force_flush().expect("flush");
            self.exporter.get_finished_metrics().expect("metrics")
        }
    }

    /// The `o11y.schema.violations` points of the last collection, as
    /// (signal, rule, count), sorted.
    pub(crate) fn violation_points(metrics: &[ResourceMetrics]) -> Vec<(String, String, u64)> {
        let mut points = Vec::new();
        for metric in metrics
            .last()
            .into_iter()
            .flat_map(ResourceMetrics::scope_metrics)
            .flat_map(opentelemetry_sdk::metrics::data::ScopeMetrics::metrics)
            .filter(|m| m.name() == libo11y_spec::metric::SCHEMA_VIOLATIONS)
        {
            if let AggregatedMetrics::U64(MetricData::Sum(sum)) = metric.data() {
                for point in sum.data_points() {
                    let value_of = |key: &str| {
                        point
                            .attributes()
                            .find(|kv| kv.key.as_str() == key)
                            .map(|kv| match &kv.value {
                                Value::String(s) => s.to_string(),
                                other => other.to_string(),
                            })
                            .unwrap_or_default()
                    };
                    points.push((
                        value_of(libo11y_spec::attr::SIGNAL),
                        value_of(libo11y_spec::attr::RULE),
                        point.value(),
                    ));
                }
            }
        }
        points.sort();
        points
    }

    /// The path of `relative` under the repository's `conformance/`
    /// directory, or `None` outside the repository, as when the published
    /// crate's tests run, which leaves those tests nothing to check.
    pub(crate) fn conformance(relative: &str) -> Option<PathBuf> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../conformance")
            .join(relative);
        if path.exists() {
            Some(path)
        } else {
            eprintln!("skipped: {} is outside this package", path.display());
            None
        }
    }
}
