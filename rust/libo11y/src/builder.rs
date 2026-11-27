//! The SDK builder: every option libo11y takes, resolved into the resource,
//! the sensitivity policy, the propagator, the exporters and the providers.

use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use opentelemetry::KeyValue;
use opentelemetry_sdk::metrics::exporter::PushMetricExporter;
use opentelemetry_sdk::trace::{ShouldSample, SpanExporter, SpanProcessor};

use libo11y_spec::{Signal, go_quote};

use crate::appregistry::merge_classes;
use crate::detect::Detected;
use crate::diagnostics::{ErrorHandler, TelemetryError, default_handler};
use crate::export::failures::ExportFailures;
use crate::export::{Route, Selection, SelectionInputs, SignalExport};
use crate::layer::Parts;
use crate::lifecycle::ShutdownCell;
use crate::logs::{PendingLog, PendingLogExporter, build_logger_provider};
use crate::metrics::{PendingMetric, PendingMetricExporter, build_meter_provider};
use crate::propagation::{BoxedPropagator, Propagator};
use crate::resource::build_resource;
use crate::sdk::{Inner, Sdk};
use crate::traces::{
    Pending, PendingSpanExporter, SamplerChoice, TraceParts, batch_config, build_tracer_provider,
    span_limits,
};
use crate::violations::{ViolationRecorder, scope};
use crate::{AppRegistry, BuildInfo, EnvLookup, Error, MIN_PII_HASH_KEY_LEN, PiiMode, Policy};

/// The standard kill switch for every signal.
const SDK_DISABLED: &str = "OTEL_SDK_DISABLED";

/// Where an application registry comes from.
#[derive(Debug, Clone)]
enum RegistrySource {
    Loaded(AppRegistry),
    File(PathBuf),
}

/// Everything the builder was told.
pub(crate) struct Settings {
    pub(crate) service_name: Option<String>,
    pub(crate) service_version: Option<String>,
    pub(crate) service_namespace: Option<String>,
    pub(crate) environment: Option<String>,
    pub(crate) extra_environments: BTreeSet<String>,
    pub(crate) lax_identity: bool,
    pub(crate) resource_attributes: Vec<KeyValue>,
    pub(crate) build_info: Option<BuildInfo>,
    pub(crate) ignore_env: bool,
    env: Option<EnvLookup>,
    pii_mode: PiiMode,
    pii_hash_key: Vec<u8>,
    registries: Vec<RegistrySource>,
    propagators: Vec<BoxedPropagator>,
    detected: Option<Detected>,
    sampler: Option<Box<dyn ShouldSample>>,
    span_exporter: Option<Box<dyn PendingSpanExporter>>,
    span_processor: Option<Box<dyn SpanProcessor>>,
    metric_exporter: Option<Box<dyn PendingMetricExporter>>,
    log_exporter: Option<Box<dyn PendingLogExporter>>,
    error_handler: Option<ErrorHandler>,
    pub(crate) tracing_default: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            service_name: None,
            service_version: None,
            service_namespace: None,
            environment: None,
            extra_environments: BTreeSet::new(),
            lax_identity: false,
            resource_attributes: Vec::new(),
            build_info: None,
            ignore_env: false,
            env: None,
            pii_mode: PiiMode::default(),
            pii_hash_key: Vec::new(),
            registries: Vec::new(),
            propagators: Vec::new(),
            detected: None,
            sampler: None,
            span_exporter: None,
            span_processor: None,
            metric_exporter: None,
            log_exporter: None,
            error_handler: None,
            tracing_default: true,
        }
    }
}

impl fmt::Debug for Settings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Settings")
            .field("service_name", &self.service_name)
            .field("environment", &self.environment)
            .field("ignore_env", &self.ignore_env)
            .field("pii_mode", &self.pii_mode)
            .field("propagators", &self.propagators.len())
            .field("span_exporter", &self.span_exporter.is_some())
            .field("span_processor", &self.span_processor.is_some())
            .field("metric_exporter", &self.metric_exporter.is_some())
            .field("tracing_default", &self.tracing_default)
            .finish_non_exhaustive()
    }
}

/// Builds an [`Sdk`]. Options override the standard `OTEL_*` environment
/// variables, which override libo11y's defaults; [`Builder::without_otel_env`]
/// removes the environment layer.
#[derive(Debug, Default)]
#[must_use = "a builder does nothing until it builds"]
pub struct Builder {
    settings: Settings,
}

impl Builder {
    /// Sets `service.name`. A service name is required: when neither this
    /// nor `OTEL_SERVICE_NAME` (nor `service.name` in
    /// `OTEL_RESOURCE_ATTRIBUTES`) provides a usable one, building fails with
    /// [`Error::NoServiceName`]. Surrounding white space is trimmed, and a
    /// blank name is no name.
    pub fn service_name(mut self, name: impl Into<String>) -> Self {
        self.settings.service_name = Some(name.into());
        self
    }

    /// Sets `service.version`. Without it the version comes from
    /// `OTEL_RESOURCE_ATTRIBUTES`, then from [`Builder::build_info`], then
    /// falls back to `0.0.0-unknown`.
    pub fn service_version(mut self, version: impl Into<String>) -> Self {
        self.settings.service_version = Some(version.into());
        self
    }

    /// Sets `service.namespace`, the grouping key that tells services of
    /// different teams or domains apart.
    pub fn service_namespace(mut self, namespace: impl Into<String>) -> Self {
        self.settings.service_namespace = Some(namespace.into());
        self
    }

    /// Sets `deployment.environment.name`, such as
    /// [`Environment::Production`](libo11y_spec::Environment::Production) or
    /// a value added with [`Builder::environment_values`]. An environment is
    /// required: without this or `deployment.environment.name` in
    /// `OTEL_RESOURCE_ATTRIBUTES`, building fails with
    /// [`Error::NoEnvironment`], and with [`Error::InvalidEnvironment`] when
    /// the value is outside the allowed set.
    pub fn environment(mut self, environment: impl fmt::Display) -> Self {
        self.settings.environment = Some(environment.to_string());
        self
    }

    /// Adds environments to the allowed set beyond the specification's
    /// `production`, `staging`, `development` and `test`, for organizations
    /// that run others, such as `qa` or `perf`.
    pub fn environment_values<I>(mut self, values: I) -> Self
    where
        I: IntoIterator,
        I::Item: fmt::Display,
    {
        self.settings
            .extra_environments
            .extend(values.into_iter().map(|v| v.to_string()));
        self
    }

    /// Downgrades the identity requirements (a service name and a valid
    /// deployment environment) from build errors to violations counted on
    /// the resource signal. For migrations and tests.
    pub fn without_strict_identity(mut self) -> Self {
        self.settings.lax_identity = true;
        self
    }

    /// Adds resource attributes. They are applied after the identity options,
    /// so a duplicate key here wins, and they are classified like every
    /// other attribute.
    pub fn resource_attributes(mut self, attributes: impl IntoIterator<Item = KeyValue>) -> Self {
        self.settings.resource_attributes.extend(attributes);
        self
    }

    /// Records the application's build: see [`build_info!`](crate::build_info).
    pub fn build_info(mut self, info: BuildInfo) -> Self {
        self.settings.build_info = Some(info);
        self
    }

    /// Selects how attributes classified as PII are handled. The default is
    /// [`PiiMode::Drop`]; [`PiiMode::Hash`] needs [`Builder::pii_hash_key`].
    pub fn pii_mode(mut self, mode: PiiMode) -> Self {
        self.settings.pii_mode = mode;
        self
    }

    /// Sets the secret key for [`PiiMode::Hash`] tokens, at least
    /// [`MIN_PII_HASH_KEY_LEN`] bytes. The key is copied.
    pub fn pii_hash_key(mut self, key: impl AsRef<[u8]>) -> Self {
        self.settings.pii_hash_key = key.as_ref().to_vec();
        self
    }

    /// Adds an application registry, whose keys the policy then classifies
    /// like specification keys. May be given more than once for registries
    /// with different namespaces.
    pub fn app_registry(mut self, registry: AppRegistry) -> Self {
        self.settings
            .registries
            .push(RegistrySource::Loaded(registry));
        self
    }

    /// Adds the application registry file at `path`, read when the SDK is
    /// built.
    pub fn app_registry_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.settings
            .registries
            .push(RegistrySource::File(path.into()));
        self
    }

    /// Replaces the default propagator, a composite of W3C Trace Context and
    /// W3C Baggage, overriding `OTEL_PROPAGATORS`. No propagators leave the
    /// choice to the variable, then the default; one is used as it is,
    /// several form a composite in order. The baggage egress filter wraps
    /// the result either way.
    pub fn propagators(mut self, propagators: impl IntoIterator<Item = BoxedPropagator>) -> Self {
        self.settings.propagators = propagators.into_iter().collect();
        self
    }

    /// Samples spans with `sampler`, overriding `OTEL_TRACES_SAMPLER`.
    /// Without it the variable decides, and without that (and under
    /// [`Builder::without_otel_env`]) the default is
    /// `ParentBased(AlwaysOn)`.
    pub fn trace_sampler(mut self, sampler: impl ShouldSample + 'static) -> Self {
        self.settings.sampler = Some(Box::new(sampler));
        self
    }

    /// Exports spans through `exporter` instead of the exporter
    /// `OTEL_TRACES_EXPORTER` and `OTEL_EXPORTER_OTLP_*` would select. Spans
    /// are still batched, and the exporter receives them redacted by the
    /// sensitivity policy. It runs beside a [`Builder::with_span_processor`]
    /// processor. A later exporter replaces an earlier one.
    ///
    /// `OTEL_SDK_DISABLED=true` overrides this: the exporter receives
    /// nothing and is shut down when the SDK is built.
    pub fn with_span_exporter<E: SpanExporter + 'static>(mut self, exporter: E) -> Self {
        self.settings.span_exporter = Some(Box::new(Pending(exporter)));
        self
    }

    /// Sets the one injected span processor; a later call replaces it, as
    /// Go's `WithSpanProcessor` does. Without a
    /// [`Builder::with_span_exporter`] exporter the processor owns the
    /// export path, and no exporter is built from the environment; with
    /// one, both run. `on_end` receives the span redacted by the sensitivity
    /// policy; `on_start` receives the live span, before redaction.
    ///
    /// `OTEL_SDK_DISABLED=true` overrides this: the processor receives
    /// nothing and is shut down when the SDK is built.
    pub fn with_span_processor<P: SpanProcessor + 'static>(mut self, processor: P) -> Self {
        self.settings.span_processor = Some(Box::new(processor));
        self
    }

    /// Exports metrics through `exporter`, read by a periodic reader at the
    /// `OTEL_METRIC_EXPORT_INTERVAL` interval (60 seconds by default),
    /// instead of the exporter `OTEL_METRICS_EXPORTER` would select. A later
    /// exporter replaces an earlier one.
    ///
    /// `OTEL_SDK_DISABLED=true` overrides this: no reader is registered and
    /// the exporter is shut down when the SDK is built.
    pub fn with_metric_exporter<E: PushMetricExporter>(mut self, exporter: E) -> Self {
        self.settings.metric_exporter = Some(Box::new(PendingMetric(exporter)));
        self
    }

    /// Sends telemetry errors, such as failed exports, and libo11y's own
    /// warnings about its configuration to `handler` instead of the default,
    /// which writes rate-limited `o11y: telemetry error` lines to standard
    /// error.
    ///
    /// The OpenTelemetry crates report their errors as `tracing` events
    /// under `opentelemetry*` targets. libo11y's layers hand the warnings and
    /// errors among them to the handler, wherever those layers run, and keep
    /// all of them away from the span layer and libo11y's log sinks. Other
    /// layers in a subscriber of your own still see them unless they filter
    /// those targets out. The handler must not log through libo11y's
    /// pipeline: when the failing component is the log exporter, that
    /// recurses.
    pub fn with_error_handler<F>(mut self, handler: F) -> Self
    where
        F: Fn(&TelemetryError) + Send + Sync + 'static,
    {
        self.settings.error_handler = Some(Arc::new(handler));
        self
    }

    /// Makes [`Builder::setup`] leave the global `tracing` subscriber alone.
    /// Compose [`Sdk::tracing_layer`] into your own subscriber instead.
    ///
    /// `tracing` takes one global subscriber per process. Once an earlier
    /// setup installed libo11y's, it stays, and this setup points it at the
    /// new SDK rather than leave it on the old one.
    pub fn without_tracing_default(mut self) -> Self {
        self.settings.tracing_default = false;
        self
    }

    /// Reads no `OTEL_*` variable anywhere: hermetic mode, for tests and for
    /// processes that must not depend on their environment. Every SDK
    /// setting is pinned in code, a signal with nothing injected is off, and
    /// no OTLP exporter is built.
    pub fn without_otel_env(mut self) -> Self {
        self.settings.ignore_env = true;
        self
    }

    /// Reads `OTEL_*` variables from `env` instead of the process
    /// environment. [`Builder::without_otel_env`] still wins.
    pub fn env_lookup(mut self, env: EnvLookup) -> Self {
        self.settings.env = Some(env);
        self
    }

    /// Replaces the detected resource layers, for tests.
    #[cfg(test)]
    pub(crate) fn detected(mut self, detected: Detected) -> Self {
        self.settings.detected = Some(detected);
        self
    }

    /// Exports logs through `exporter`, for tests until the log layer
    /// brings the public option.
    #[cfg(test)]
    pub(crate) fn log_exporter<E>(mut self, exporter: E) -> Self
    where
        E: opentelemetry_sdk::logs::LogExporter + 'static,
    {
        self.settings.log_exporter = Some(Box::new(PendingLog(exporter)));
        self
    }

    /// Resolves the options into an SDK without touching any process-global
    /// state, in the Go library's order: the PII key, the application
    /// registries and the policy, the resource, the propagator, the
    /// exporters, the meter provider and the violation counter (which then
    /// counts the resource's violations), the tracer provider, the logger
    /// provider.
    ///
    /// Every exporter is built before any provider, so a build that fails
    /// leaves nothing running.
    ///
    /// # Errors
    ///
    /// [`Error::PiiHashKey`] for a short hash key; the registry errors of
    /// [`AppRegistry::from_path`] and [`Error::DuplicateAppNamespace`];
    /// under strict identity, [`Error::NoServiceName`],
    /// [`Error::NoEnvironment`] and [`Error::InvalidEnvironment`];
    /// [`Error::UnknownPropagator`] and [`Error::UnsupportedPropagator`] for
    /// `OTEL_PROPAGATORS`; [`Error::UnknownExporter`],
    /// [`Error::UnsupportedExporter`], [`Error::InvalidOtlpProtocol`] and
    /// [`Error::OtlpFeatureDisabled`] for the exporter variables; and
    /// [`Error::BuildingSpanExporter`] and [`Error::BuildingLogExporter`]
    /// when an exporter cannot be built, such as for an unreadable
    /// certificate file or OTLP over gRPC outside a Tokio runtime.
    pub fn build(self) -> Result<Sdk, Error> {
        build_sdk(self.settings)
    }

    /// Builds the SDK as [`Builder::build`] does and installs it as the
    /// process default: the OpenTelemetry global tracer provider, meter
    /// provider and text map propagator, then the global `tracing`
    /// subscriber (unless [`Builder::without_tracing_default`]), whose
    /// layers are [`Sdk::tracing_layer`]'s. Third-party code on the
    /// OpenTelemetry globals and on `tracing` works untouched afterwards.
    ///
    /// One global SDK may be active at a time. Shutting it down lets setup
    /// run again; its providers stay installed until then. A setup that
    /// fails installs nothing.
    ///
    /// # Errors
    ///
    /// [`Error::AlreadySetup`] while a global SDK is active or being set
    /// up; [`Error::ForeignTracingSubscriber`] when some other code set the
    /// global `tracing` subscriber; and every error of [`Builder::build`].
    pub fn setup(self) -> Result<Sdk, Error> {
        crate::setup::setup(self.settings)
    }
}

/// Builds the SDK from `settings`.
pub(crate) fn build_sdk(mut settings: Settings) -> Result<Sdk, Error> {
    if settings.pii_mode == PiiMode::Hash && settings.pii_hash_key.len() < MIN_PII_HASH_KEY_LEN {
        return Err(Error::PiiHashKey);
    }
    let registries = std::mem::take(&mut settings.registries)
        .into_iter()
        .map(|source| match source {
            RegistrySource::Loaded(registry) => Ok(registry),
            RegistrySource::File(path) => AppRegistry::from_path(path),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let classes = merge_classes(&registries)?;
    let policy = Policy::new(settings.pii_mode, &settings.pii_hash_key, classes)?;
    let env = if settings.ignore_env {
        EnvLookup::empty()
    } else {
        settings.env.clone().unwrap_or_default()
    };
    let disabled_value = env.get(SDK_DISABLED).unwrap_or_default();
    let disabled = disabled_value.eq_ignore_ascii_case("true");
    let detected = settings
        .detected
        .take()
        .unwrap_or_else(Detected::from_system);
    let resolved = build_resource(&settings, &policy, &env, &detected)?;
    let propagator = Propagator::resolve(std::mem::take(&mut settings.propagators), &env, None)?;
    let selection = Selection::resolve(
        &env,
        SelectionInputs {
            ignore_env: settings.ignore_env,
            disabled,
            traces_injected: settings.span_exporter.is_some() || settings.span_processor.is_some(),
            metrics_injected: settings.metric_exporter.is_some(),
            logs_injected: settings.log_exporter.is_some(),
            logs_off: false,
        },
    )?;
    let handler = settings
        .error_handler
        .take()
        .unwrap_or_else(default_handler);

    // The exporters can fail; the providers cannot, and run threads once
    // built.
    let exporters = exporters(&mut settings, &selection)?;

    let metric_failures = ExportFailures::default();
    let meter_provider = build_meter_provider(
        resolved.resource.clone(),
        &env,
        settings.metric_exporter.take(),
        metric_failures.clone(),
        disabled,
    );
    let violations = ViolationRecorder::new(&meter_provider);
    // The resource was classified before the counter existed.
    violations.add_all(Signal::Resource, &resolved.violations);

    let sampler = SamplerChoice::resolve(settings.sampler.take(), &env, &*handler);
    let span_failures = ExportFailures::default();
    let tracer_provider = build_tracer_provider(TraceParts {
        resource: resolved.resource.clone(),
        sampler: sampler.sampler,
        limits: span_limits(&env),
        batch: batch_config(&env),
        processor: settings.span_processor.take(),
        exporter: exporters.spans,
        policy: policy.clone(),
        recorder: violations.clone(),
        failures: span_failures.clone(),
        disabled,
    });

    let log_failures = ExportFailures::default();
    let logger_provider = build_logger_provider(
        resolved.resource.clone(),
        &env,
        exporters.logs,
        log_failures.clone(),
    );

    warn_on_disabled_value(&disabled_value, &handler);

    let parts = Arc::new(Parts {
        tracer: opentelemetry::trace::TracerProvider::tracer_with_scope(&tracer_provider, scope()),
        handler: Arc::clone(&handler),
    });
    Ok(Sdk(Arc::new(Inner {
        resource: resolved.resource,
        resource_violations: resolved.violations,
        version_fallback: resolved.version_fallback,
        policy,
        propagator,
        selection,
        sampler_report: sampler.report,
        disabled,
        tracer_provider,
        span_failures,
        meter_provider,
        metric_failures,
        logger_provider,
        log_failures,
        parts,
        handler,
        violations,
        tracing_default: settings.tracing_default,
        global: AtomicBool::new(false),
        shutdown: ShutdownCell::default(),
        busy: Default::default(),
    })))
}

/// The span and log exporters the selection names.
struct Exporters {
    spans: Option<Box<dyn PendingSpanExporter>>,
    logs: Option<Box<dyn PendingLogExporter>>,
}

/// The span and log exporters the selection names: the injected ones, or
/// ones built from the environment.
///
/// An injected exporter the selection does not use (the SDK is disabled,
/// or log export is off) is shut down now: the SDK owns what it was given.
fn exporters(settings: &mut Settings, selection: &Selection) -> Result<Exporters, Error> {
    let spans = match selection.traces.route {
        Route::Injected => settings.span_exporter.take(),
        route => {
            if let Some(unused) = settings.span_exporter.take() {
                unused.discard();
            }
            span_exporter_for(route, &selection.traces)?
        }
    };
    let logs = match selection.logs.route {
        Route::Injected => settings.log_exporter.take(),
        route => {
            if let Some(unused) = settings.log_exporter.take() {
                unused.discard();
            }
            log_exporter_for(route, &selection.logs)?
        }
    };
    Ok(Exporters { spans, logs })
}

/// Warns, as the specification asks for a boolean variable, when
/// `OTEL_SDK_DISABLED` is neither true nor false. Such a value counts as
/// false.
fn warn_on_disabled_value(value: &str, handler: &ErrorHandler) {
    if !value.is_empty()
        && !value.eq_ignore_ascii_case("true")
        && !value.eq_ignore_ascii_case("false")
    {
        handler(&TelemetryError::new(format!(
            "o11y: {SDK_DISABLED}={} is neither true nor false; the SDK stays enabled",
            go_quote(value)
        )));
    }
}

/// The span exporter a route selects from the environment.
fn span_exporter_for(
    route: Route,
    export: &SignalExport,
) -> Result<Option<Box<dyn PendingSpanExporter>>, Error> {
    Ok(match route {
        Route::Otlp => Some(otlp_span_exporter(export)?),
        Route::Console => Some(Box::new(Pending(
            opentelemetry_stdout::SpanExporter::default(),
        ))),
        Route::None | Route::Injected => None,
    })
}

/// The log exporter a route selects from the environment.
fn log_exporter_for(
    route: Route,
    export: &SignalExport,
) -> Result<Option<Box<dyn PendingLogExporter>>, Error> {
    Ok(match route {
        Route::Otlp => Some(otlp_log_exporter(export)?),
        Route::Console => Some(Box::new(PendingLog(
            opentelemetry_stdout::LogExporter::default(),
        ))),
        Route::None | Route::Injected => None,
    })
}

#[cfg(any(feature = "otlp-http", feature = "otlp-grpc"))]
fn otlp_span_exporter(export: &SignalExport) -> Result<Box<dyn PendingSpanExporter>, Error> {
    crate::export::otlp::span_exporter(export)
        .map(|exporter| Box::new(Pending(exporter)) as Box<dyn PendingSpanExporter>)
        .map_err(Error::BuildingSpanExporter)
}

#[cfg(any(feature = "otlp-http", feature = "otlp-grpc"))]
fn otlp_log_exporter(export: &SignalExport) -> Result<Box<dyn PendingLogExporter>, Error> {
    crate::export::otlp::log_exporter(export)
        .map(|exporter| Box::new(PendingLog(exporter)) as Box<dyn PendingLogExporter>)
        .map_err(Error::BuildingLogExporter)
}

/// Selection refuses an OTLP route this build cannot carry, so this is
/// never reached; it keeps a build without transports compiling.
#[cfg(not(any(feature = "otlp-http", feature = "otlp-grpc")))]
fn otlp_span_exporter(export: &SignalExport) -> Result<Box<dyn PendingSpanExporter>, Error> {
    Err(Error::OtlpFeatureDisabled {
        signal: Signal::Traces,
        protocol: export.protocol,
    })
}

#[cfg(not(any(feature = "otlp-http", feature = "otlp-grpc")))]
fn otlp_log_exporter(export: &SignalExport) -> Result<Box<dyn PendingLogExporter>, Error> {
    Err(Error::OtlpFeatureDisabled {
        signal: Signal::Logs,
        protocol: export.protocol,
    })
}
