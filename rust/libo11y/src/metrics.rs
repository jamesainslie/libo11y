//! The meter provider.
//!
//! For now this is a plain `SdkMeterProvider` with the resource and, when
//! one was injected, a periodic reader over the injected exporter. The
//! exemplar-aware wrapper and libo11y's own OTLP metric exporter replace
//! [`build_meter_provider`]; the selection, protocol and TLS files for
//! metrics are already resolved in
//! [`Selection::metrics`](crate::export::Selection).

use std::fmt;
use std::time::Duration;

use opentelemetry_sdk::Resource;
use opentelemetry_sdk::metrics::exporter::PushMetricExporter;
use opentelemetry_sdk::metrics::{MeterProviderBuilder, PeriodicReader, SdkMeterProvider};

use crate::env::EnvLookup;
use crate::export::failures::{ExportFailures, ObservedMetricExporter};

/// The periodic reader's default interval.
const DEFAULT_EXPORT_INTERVAL: Duration = Duration::from_secs(60);

/// A metric exporter waiting for its reader. It erases the exporter's type.
pub(crate) trait PendingMetricExporter: Send {
    /// Registers a periodic reader over the exporter, wrapped so its failed
    /// exports are recorded.
    fn register(
        self: Box<Self>,
        builder: MeterProviderBuilder,
        interval: Duration,
        failures: ExportFailures,
    ) -> MeterProviderBuilder;

    /// Shuts down an exporter the SDK will not use.
    fn discard(self: Box<Self>);
}

/// A metric exporter of a known type, pending.
pub(crate) struct PendingMetric<E>(pub(crate) E);

impl<E: PushMetricExporter> PendingMetricExporter for PendingMetric<E> {
    fn register(
        self: Box<Self>,
        builder: MeterProviderBuilder,
        interval: Duration,
        failures: ExportFailures,
    ) -> MeterProviderBuilder {
        let exporter = ObservedMetricExporter::new(self.0, failures);
        builder.with_reader(
            PeriodicReader::builder(exporter)
                .with_interval(interval)
                .build(),
        )
    }

    fn discard(self: Box<Self>) {
        let _ = self.0.shutdown_with_timeout(Duration::ZERO);
    }
}

impl fmt::Debug for dyn PendingMetricExporter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PendingMetricExporter")
    }
}

/// `OTEL_METRIC_EXPORT_INTERVAL` in milliseconds, read through `env` so the
/// reader's interval is always set in code; 60 seconds by default and for
/// a value that is not a positive whole number.
pub(crate) fn export_interval(env: &EnvLookup) -> Duration {
    env.trimmed("OTEL_METRIC_EXPORT_INTERVAL")
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map_or(DEFAULT_EXPORT_INTERVAL, Duration::from_millis)
}

/// Builds the meter provider. While the SDK is disabled no reader is
/// registered, so instruments work and nothing is collected, and an
/// injected exporter is shut down now, as Go shuts down an injected reader.
pub(crate) fn build_meter_provider(
    resource: Resource,
    env: &EnvLookup,
    exporter: Option<Box<dyn PendingMetricExporter>>,
    failures: ExportFailures,
    disabled: bool,
) -> SdkMeterProvider {
    let builder = SdkMeterProvider::builder().with_resource(resource);
    match exporter {
        Some(exporter) if disabled => {
            exporter.discard();
            builder.build()
        }
        Some(exporter) => exporter
            .register(builder, export_interval(env), failures)
            .build(),
        None => builder.build(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_interval_is_read_through_the_lookup() {
        let env = |v: &str| EnvLookup::from_pairs([("OTEL_METRIC_EXPORT_INTERVAL", v)]);
        assert_eq!(export_interval(&env("1500")), Duration::from_millis(1500));
        assert_eq!(export_interval(&env("0")), DEFAULT_EXPORT_INTERVAL);
        assert_eq!(export_interval(&env("soon")), DEFAULT_EXPORT_INTERVAL);
        assert_eq!(
            export_interval(&EnvLookup::empty()),
            DEFAULT_EXPORT_INTERVAL
        );
    }
}
