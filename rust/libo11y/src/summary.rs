//! Effective configuration rendering and the startup summary canary
//! (`o11y.telemetry.configured`), matching Go's `summary.go` key order and
//! endpoint sanitization.

use std::fmt::Write as _;

use opentelemetry::{Context, Key, KeyValue};
use opentelemetry_sdk::Resource;

use libo11y_spec::{attr, event};

use crate::BoxError;
use crate::console::{ConsoleFormat, level_str};
use crate::env::EnvLookup;
use crate::export::Selection;
use crate::propagation::Propagator;
use crate::sanitize::sanitize_endpoint;
use crate::sdk::Sdk;

/// Inputs needed to compute the resolved effective configuration and startup
/// summary attributes.
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent resolved configuration flags passed into summary rendering"
)]
pub(crate) struct SummaryInputs<'a> {
    pub(crate) resource: &'a Resource,
    pub(crate) selection: &'a Selection,
    pub(crate) console_enabled: bool,
    pub(crate) console_format: ConsoleFormat,
    pub(crate) level: tracing::Level,
    pub(crate) sampler: &'a str,
    pub(crate) propagator: &'a Propagator,
    pub(crate) runtime_metrics: bool,
    pub(crate) disabled: bool,
    pub(crate) version_fallback: bool,
    pub(crate) env: &'a EnvLookup,
}

/// The precomputed startup summary attributes and one-line `EffectiveConfig`.
#[derive(Debug, Clone)]
pub(crate) struct Summary {
    pub(crate) attrs: Vec<KeyValue>,
    pub(crate) line: String,
}

/// Builds the summary attributes and single-line effective config string in
/// Go's exact key order.
pub(crate) fn build_summary(inputs: &SummaryInputs<'_>) -> Summary {
    let service_name = inputs
        .resource
        .get(&Key::from_static_str("service.name"))
        .map(|v| v.to_string())
        .unwrap_or_default();
    let service_version = inputs
        .resource
        .get(&Key::from_static_str("service.version"))
        .map(|v| v.to_string())
        .unwrap_or_default();

    let console = if inputs.console_enabled {
        inputs.console_format.as_str()
    } else {
        "off"
    };
    let runtime_metrics = if inputs.runtime_metrics && !inputs.disabled {
        "true"
    } else {
        "false"
    };

    let mut attrs = Vec::with_capacity(14);
    attrs.push(KeyValue::new("service.name", service_name));
    if !service_version.is_empty() {
        attrs.push(KeyValue::new("service.version", service_version));
    }
    attrs.push(config_attr(
        "traces",
        inputs.selection.traces.route.as_str(),
    ));
    attrs.push(config_attr(
        "metrics",
        inputs.selection.metrics.route.as_str(),
    ));
    attrs.push(config_attr("logs", inputs.selection.logs.route.as_str()));
    attrs.push(config_attr("console", console));
    attrs.push(config_attr("level", level_str(inputs.level)));
    attrs.push(config_attr("sampler", inputs.sampler.to_owned()));
    attrs.push(config_attr(
        "propagators",
        inputs.propagator.reported_fields().to_owned(),
    ));
    attrs.push(config_attr("runtime_metrics", runtime_metrics));
    if inputs.version_fallback {
        attrs.push(config_attr("service_version_fallback", "true"));
    }

    for (key, var) in [
        ("endpoint", "OTEL_EXPORTER_OTLP_ENDPOINT"),
        ("traces_endpoint", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
        ("metrics_endpoint", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"),
        ("logs_endpoint", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"),
    ] {
        if let Some(raw) = inputs.env.get(var)
            && !raw.is_empty()
        {
            attrs.push(config_attr(key, sanitize_endpoint(&raw)));
        }
    }

    let mut line = String::new();
    for (i, kv) in attrs.iter().enumerate() {
        if i > 0 {
            line.push(' ');
        }
        // Writing to a String cannot fail.
        let _ = write!(line, "{}={}", kv.key, kv.value);
    }

    Summary { attrs, line }
}

fn config_attr(key: &str, value: impl Into<opentelemetry::Value>) -> KeyValue {
    KeyValue::new(format!("{}.{key}", attr::CONFIG), value.into())
}

impl Sdk {
    /// Returns a single-line rendering of the fully resolved configuration:
    /// service identity, exporter routes, console setting, log level, sampler,
    /// propagator fields, runtime metrics flag, and sanitized endpoints.
    ///
    /// Available on SDKs created with both [`Builder::build`](crate::Builder::build)
    /// and [`Builder::setup`](crate::Builder::setup).
    #[must_use]
    pub fn effective_config(&self) -> &str {
        &self.0.summary.line
    }

    /// Force-emits the `o11y.telemetry.configured` startup summary canary
    /// through the full log pipeline, returning any sink error so setup can
    /// fail fast before installing globals.
    pub(crate) fn emit_startup_summary(&self) -> Result<(), BoxError> {
        self.emit_event(
            &Context::new(),
            event::TELEMETRY_CONFIGURED,
            self.0.summary.attrs.iter().cloned(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::{Environment, Sdk};

    #[test]
    fn effective_config_reports_exact_go_key_order_and_sanitized_endpoints() {
        let env = EnvLookup::from_pairs([
            ("OTEL_TRACES_EXPORTER", "none"),
            ("OTEL_METRICS_EXPORTER", "none"),
            ("OTEL_LOGS_EXPORTER", "none"),
            (
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "https://user:tok3n@collector.example:4318/v1?api_key=k3y#frag",
            ),
            (
                "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                "collector.example:4317",
            ),
            (
                "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
                "https://m:pw1@metrics.example:4318/v1/metrics?token=t1",
            ),
            (
                "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
                "https://logs.example:4318/v1/logs#l0g",
            ),
        ]);
        let sdk = Sdk::builder()
            .service_name("orders")
            .service_version("1.2.3")
            .environment(Environment::Production)
            .env_lookup(env)
            .console_format(ConsoleFormat::Text)
            .log_level(tracing::Level::DEBUG)
            .without_runtime_metrics()
            .build()
            .expect("SDK");
        let cfg = sdk.effective_config();
        assert_eq!(
            cfg,
            concat!(
                "service.name=orders ",
                "service.version=1.2.3 ",
                "o11y.config.traces=none ",
                "o11y.config.metrics=none ",
                "o11y.config.logs=none ",
                "o11y.config.console=text ",
                "o11y.config.level=DEBUG ",
                "o11y.config.sampler=parentbased_always_on ",
                "o11y.config.propagators=traceparent,tracestate,baggage ",
                "o11y.config.runtime_metrics=false ",
                "o11y.config.endpoint=https://collector.example:4318/v1 ",
                "o11y.config.traces_endpoint=collector.example:4317 ",
                "o11y.config.metrics_endpoint=https://metrics.example:4318/v1/metrics ",
                "o11y.config.logs_endpoint=https://logs.example:4318/v1/logs"
            )
        );
        for leak in ["tok3n", "k3y", "frag", "pw1", "t1", "l0g"] {
            assert!(!cfg.contains(leak), "leaked {leak}: {cfg}");
        }
    }

    #[test]
    fn effective_config_flags_version_fallback_and_hides_endpoints_when_hermetic() {
        let env = EnvLookup::from_pairs([(
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "https://collector.example:4318",
        )]);
        let sdk = Sdk::builder()
            .service_name("svc")
            .environment(Environment::Test)
            .env_lookup(env)
            .without_otel_env()
            .without_console_log()
            .build()
            .expect("SDK");
        let cfg = sdk.effective_config();
        assert!(cfg.contains("o11y.config.console=off"), "{cfg}");
        assert!(
            cfg.contains("o11y.config.service_version_fallback=true"),
            "{cfg}"
        );
        assert!(cfg.contains("o11y.config.runtime_metrics=true"), "{cfg}");
        assert!(!cfg.contains("endpoint="), "{cfg}");
    }
}
