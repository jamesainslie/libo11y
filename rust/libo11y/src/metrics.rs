//! The meter provider, attribute classification, exemplar sampling, views,
//! metric sinks, OTLP metric exporter, and process runtime metrics.

pub(crate) mod exemplar;
pub(crate) mod exporter;
pub(crate) mod process;
pub(crate) mod provider;
pub(crate) mod sink;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use opentelemetry_sdk::Resource;
use opentelemetry_sdk::metrics::exporter::PushMetricExporter;
use opentelemetry_sdk::metrics::{
    Aggregation, Instrument, InstrumentKind, MeterProviderBuilder, PeriodicReader,
    SdkMeterProvider, Stream,
};

use crate::diagnostics::ErrorHandler;
use crate::env::EnvLookup;
use crate::export::failures::{ExportFailures, ObservedMetricExporter};
use crate::export::{Route, SignalExport};
use crate::{Error, Policy};

pub use exemplar::{ExemplarFilter, ExemplarSample, ExemplarValue};
pub use provider::Libo11yMeterProvider;
pub use sink::{MemoryMetricSink, MetricSink};

use exemplar::ExemplarRegistry;
use exporter::{ExemplarMetricExporter, RenamedStreams, stream_custom_name};
use process::ProcessMetrics;
use provider::{HistogramBucketRule, wildcard_match};
use sink::{ConsoleMetricSink, temporality_preference};

/// The periodic reader's default interval.
const DEFAULT_EXPORT_INTERVAL: Duration = Duration::from_secs(60);

/// The per-stream cardinality limit pinned in code (matching Go and
/// OpenTelemetry SDK defaults).
pub(crate) const DEFAULT_CARDINALITY_LIMIT: usize = 2000;

/// A user-supplied metric view closure.
pub(crate) type MetricView = Arc<dyn Fn(&Instrument) -> Option<Stream> + Send + Sync + 'static>;

/// A metric exporter or sink waiting for its reader. It erases the concrete
/// type while receiving the provider's [`ExemplarRegistry`] when registered.
pub(crate) trait PendingMetricExporter: Send {
    /// Registers a periodic reader over the exporter, wrapped so its failed
    /// exports are recorded.
    fn register(
        self: Box<Self>,
        builder: MeterProviderBuilder,
        interval: Duration,
        failures: ExportFailures,
        exemplars: Arc<ExemplarRegistry>,
        renamed: Arc<RenamedStreams>,
    ) -> MeterProviderBuilder;

    /// Shuts down an exporter the SDK will not use.
    fn discard(self: Box<Self>);
}

/// A plain SDK [`PushMetricExporter`], pending.
pub(crate) struct PendingMetric<E>(pub(crate) E);

impl<E: PushMetricExporter> PendingMetricExporter for PendingMetric<E> {
    fn register(
        self: Box<Self>,
        builder: MeterProviderBuilder,
        interval: Duration,
        failures: ExportFailures,
        _exemplars: Arc<ExemplarRegistry>,
        _renamed: Arc<RenamedStreams>,
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

/// A [`MetricSink`] waiting to be wrapped in an [`ExemplarMetricExporter`]
/// with its own per-reader [`ExemplarStore`](exemplar::ExemplarStore).
pub(crate) struct PendingSink<S>(pub(crate) S);

impl<S: MetricSink> PendingMetricExporter for PendingSink<S> {
    fn register(
        self: Box<Self>,
        builder: MeterProviderBuilder,
        interval: Duration,
        failures: ExportFailures,
        exemplars: Arc<ExemplarRegistry>,
        renamed: Arc<RenamedStreams>,
    ) -> MeterProviderBuilder {
        let exemplar_exporter = ExemplarMetricExporter::new(self.0, exemplars, renamed);
        let observed = ObservedMetricExporter::new(exemplar_exporter, failures);
        builder.with_reader(
            PeriodicReader::builder(observed)
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

/// Builds the metric exporter selected by `route` from the environment.
pub(crate) fn metric_exporter_for(
    route: Route,
    export: &SignalExport,
    env: &EnvLookup,
    error_handler: &ErrorHandler,
) -> Result<Option<Box<dyn PendingMetricExporter>>, Error> {
    Ok(match route {
        Route::Otlp => Some(otlp_metric_exporter(export, env, error_handler)?),
        Route::Console => Some(Box::new(PendingSink(ConsoleMetricSink::stdout(
            temporality_preference(env),
        )))),
        Route::None | Route::Injected => None,
    })
}

fn otlp_metric_exporter(
    export: &SignalExport,
    #[cfg_attr(
        not(any(feature = "otlp-http", feature = "otlp-grpc")),
        allow(unused_variables, reason = "only OTLP transports read env")
    )]
    env: &EnvLookup,
    #[cfg_attr(
        not(any(feature = "otlp-http", feature = "otlp-grpc")),
        allow(
            unused_variables,
            reason = "only OTLP transports report partial success"
        )
    )]
    error_handler: &ErrorHandler,
) -> Result<Box<dyn PendingMetricExporter>, Error> {
    match export.protocol {
        #[cfg(feature = "otlp-http")]
        crate::export::Protocol::HttpProtobuf | crate::export::Protocol::HttpJson => {
            let sink = sink::OtlpHttpMetricSink::new(export, env, Arc::clone(error_handler))
                .map_err(Error::BuildingMetricReader)?;
            Ok(Box::new(PendingSink(sink)))
        }
        #[cfg(feature = "otlp-grpc")]
        crate::export::Protocol::Grpc => {
            let sink = sink::OtlpGrpcMetricSink::new(export, env, Arc::clone(error_handler))
                .map_err(Error::BuildingMetricReader)?;
            Ok(Box::new(PendingSink(sink)))
        }
        #[allow(
            unreachable_patterns,
            reason = "reachable when a transport feature is disabled"
        )]
        other => Err(Error::OtlpFeatureDisabled {
            signal: libo11y_spec::Signal::Metrics,
            protocol: other,
        }),
    }
}

/// Everything needed to assemble the meter provider and process metrics.
pub(crate) struct MeterParts<'a> {
    pub(crate) resource: Resource,
    pub(crate) policy: Policy,
    pub(crate) env: &'a EnvLookup,
    pub(crate) exemplar_filter: Option<ExemplarFilter>,
    pub(crate) histogram_rules: Vec<HistogramBucketRule>,
    pub(crate) views: Vec<MetricView>,
    pub(crate) exporter: Option<Box<dyn PendingMetricExporter>>,
    pub(crate) extra_sinks: Vec<Box<dyn PendingMetricExporter>>,
    pub(crate) failures: ExportFailures,
    pub(crate) disabled: bool,
    pub(crate) runtime_metrics: bool,
}

/// Builds the classifying, exemplar-aware [`Libo11yMeterProvider`] and
/// optional [`ProcessMetrics`].
///
/// While the SDK is disabled no reader is registered and no runtime metrics
/// are started, and any injected exporters or sinks are shut down immediately.
pub(crate) fn build_meter_provider(
    parts: MeterParts<'_>,
) -> (Libo11yMeterProvider, ProcessMetrics) {
    let filter = ExemplarFilter::resolve(parts.exemplar_filter, parts.env);
    let registry = Arc::new(ExemplarRegistry::default());

    let mut builder = SdkMeterProvider::builder().with_resource(parts.resource);

    // Register a single combined view for explicit histogram bucket rules so
    // the last matching rule wins, agreeing with `Libo11yMeterProvider`.
    if !parts.histogram_rules.is_empty() {
        let rules = parts.histogram_rules.clone();
        builder = builder.with_view(move |inst: &Instrument| {
            if inst.kind() != InstrumentKind::Histogram {
                return None;
            }
            let rule = rules
                .iter()
                .rev()
                .find(|rule| wildcard_match(&rule.pattern, inst.name()))?;
            Stream::builder()
                .with_aggregation(Aggregation::ExplicitBucketHistogram {
                    boundaries: rule.boundaries.clone(),
                    record_min_max: true,
                })
                .with_cardinality_limit(DEFAULT_CARDINALITY_LIMIT)
                .build()
                .ok()
        });
    }

    // Register user views, recording any stream renames so exemplars from an
    // original instrument are never attached to an unrelated renamed stream.
    let renamed = Arc::new(RenamedStreams::default());
    for view in &parts.views {
        let view = Arc::clone(view);
        let renamed = Arc::clone(&renamed);
        builder = builder.with_view(move |inst: &Instrument| {
            let stream = view(inst)?;
            if let Some(new_name) = stream_custom_name(&stream) {
                renamed.record_rename(inst.scope(), inst.name(), &new_name);
            }
            Some(stream)
        });
    }

    // Catch-all view pinning the default cardinality limit (2000) for any
    // instrument that neither a histogram-buckets rule nor a user view matched,
    // without clobbering user views or instrument advisory boundaries.
    let catchall_hist: Vec<String> = parts
        .histogram_rules
        .iter()
        .map(|r| r.pattern.clone())
        .collect();
    let catchall_views = parts.views;
    builder = builder.with_view(move |inst: &Instrument| {
        let hist_matched = inst.kind() == InstrumentKind::Histogram
            && catchall_hist
                .iter()
                .any(|pattern| wildcard_match(pattern, inst.name()));
        if hist_matched || catchall_views.iter().any(|v| v(inst).is_some()) {
            return None;
        }
        Stream::builder()
            .with_cardinality_limit(DEFAULT_CARDINALITY_LIMIT)
            .build()
            .ok()
    });

    if parts.disabled {
        if let Some(exporter) = parts.exporter {
            exporter.discard();
        }
        for extra in parts.extra_sinks {
            extra.discard();
        }
    } else {
        let interval = export_interval(parts.env);
        if let Some(exporter) = parts.exporter {
            builder = exporter.register(
                builder,
                interval,
                parts.failures.clone(),
                Arc::clone(&registry),
                Arc::clone(&renamed),
            );
        }
        for extra in parts.extra_sinks {
            builder = extra.register(
                builder,
                interval,
                parts.failures.clone(),
                Arc::clone(&registry),
                Arc::clone(&renamed),
            );
        }
    }

    let sdk_provider = builder.build();
    let provider = Libo11yMeterProvider::new(
        sdk_provider,
        parts.policy,
        filter,
        registry,
        parts.histogram_rules,
    );
    let process_metrics = if parts.runtime_metrics && !parts.disabled {
        process::register(&provider)
    } else {
        ProcessMetrics::default()
    };

    (provider, process_metrics)
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
