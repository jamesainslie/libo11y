//! The logger provider behind the OTLP log leg.
//!
//! [`build_logger_provider`] puts a batch log processor over the selected
//! exporter, wrapped so its failed exports are recorded for shutdown and
//! flush. The tracing log layer and the redacting log processor for other
//! bridges build on this provider; the redacting processor goes in front
//! of the batch processor, as in Go.

use std::fmt;
use std::time::Duration;

use opentelemetry_sdk::Resource;
use opentelemetry_sdk::logs::{
    BatchConfig, BatchConfigBuilder, BatchLogProcessor, LogExporter, SdkLoggerProvider,
};

use crate::env::EnvLookup;
use crate::export::failures::{ExportFailures, ObservedLogExporter};

/// A log exporter waiting to be batched. It erases the exporter's type.
pub(crate) trait PendingLogExporter: Send {
    /// The batch log processor over the exporter, wrapped to observe
    /// failures.
    fn into_processor(
        self: Box<Self>,
        failures: ExportFailures,
        batch: BatchConfig,
    ) -> BatchLogProcessor;

    /// Shuts down an exporter the SDK will not use.
    #[allow(dead_code, reason = "used once log export can be switched off")]
    fn discard(self: Box<Self>);
}

/// A log exporter of a known type, pending.
pub(crate) struct PendingLog<E>(pub(crate) E);

impl<E: LogExporter + 'static> PendingLogExporter for PendingLog<E> {
    fn into_processor(
        self: Box<Self>,
        failures: ExportFailures,
        batch: BatchConfig,
    ) -> BatchLogProcessor {
        BatchLogProcessor::builder(ObservedLogExporter::new(self.0, failures))
            .with_batch_config(batch)
            .build()
    }

    fn discard(self: Box<Self>) {
        let _ = self.0.shutdown_with_timeout(Duration::ZERO);
    }
}

impl fmt::Debug for dyn PendingLogExporter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PendingLogExporter")
    }
}

/// The batch log processor's configuration, every field upstream lets code
/// set taken from `env` or upstream's default: `OTEL_BLRP_MAX_QUEUE_SIZE`
/// (2048), `OTEL_BLRP_SCHEDULE_DELAY` (1000 ms), `OTEL_BLRP_MAX_EXPORT_BATCH_SIZE`
/// (512).
pub(crate) fn batch_config(env: &EnvLookup) -> BatchConfig {
    let read = |key: &str, default: u64| {
        env.trimmed(key)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(default)
    };
    BatchConfigBuilder::default()
        .with_max_queue_size(
            usize::try_from(read("OTEL_BLRP_MAX_QUEUE_SIZE", 2048)).unwrap_or(2048),
        )
        .with_scheduled_delay(Duration::from_millis(read(
            "OTEL_BLRP_SCHEDULE_DELAY",
            1000,
        )))
        .with_max_export_batch_size(
            usize::try_from(read("OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", 512)).unwrap_or(512),
        )
        .build()
}

/// Builds the logger provider, or `None` when no log exporter was
/// selected.
pub(crate) fn build_logger_provider(
    resource: Resource,
    env: &EnvLookup,
    exporter: Option<Box<dyn PendingLogExporter>>,
    failures: ExportFailures,
) -> Option<SdkLoggerProvider> {
    let exporter = exporter?;
    Some(
        SdkLoggerProvider::builder()
            .with_resource(resource)
            .with_log_processor(exporter.into_processor(failures, batch_config(env)))
            .build(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batching_is_set_in_code() {
        let env = EnvLookup::from_pairs([
            ("OTEL_BLRP_MAX_QUEUE_SIZE", "64"),
            ("OTEL_BLRP_SCHEDULE_DELAY", "250"),
            ("OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", "nope"),
        ]);
        let batch = format!("{:?}", batch_config(&env));
        assert!(batch.contains("max_queue_size: 64"), "{batch}");
        assert!(batch.contains("scheduled_delay: 250ms"), "{batch}");
        // An unparsable batch size is the default, 512, which upstream then
        // clamps to the queue size.
        assert!(batch.contains("max_export_batch_size: 64"), "{batch}");
        let defaults = format!("{:?}", batch_config(&EnvLookup::empty()));
        assert!(defaults.contains("scheduled_delay: 1s"), "{defaults}");
    }
}
