//! The errors libo11y returns, with the Go implementation's messages.
//!
//! Every message matches the Go library byte for byte, including the ones
//! that name a Go option such as `WithServiceName`, so the two libraries
//! report the same failure the same way (the TypeScript port keeps them
//! verbatim too). Match on the [`Error`] variant to tell the failures apart.

use std::io;

use libo11y_spec::{Signal, go_quote};

use crate::appregistry::{ParseError, Violation};
use crate::export::{Protocol, component};

/// A boxed error from a component libo11y builds on, such as an exporter.
pub type BoxError = Box<dyn std::error::Error + Send + Sync + 'static>;

/// What went wrong while building or running libo11y.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// A process-global SDK is already installed. Go's `ErrAlreadySetup`.
    #[error("o11y: already set up")]
    AlreadySetup,

    /// No service name resolved from the builder, `OTEL_SERVICE_NAME` or
    /// `service.name` in `OTEL_RESOURCE_ATTRIBUTES`, and strict identity is
    /// on. Go's `ErrNoServiceName`.
    #[error("o11y: service name required: set WithServiceName or OTEL_SERVICE_NAME")]
    NoServiceName,

    /// No deployment environment resolved from the builder or
    /// `deployment.environment.name` in `OTEL_RESOURCE_ATTRIBUTES`, and
    /// strict identity is on. Go's `ErrNoEnvironment`.
    #[error(
        "o11y: deployment environment required: set WithEnvironment or deployment.environment.name"
    )]
    NoEnvironment,

    /// The deployment environment is not in the allowed set, and strict
    /// identity is on. Go's `ErrInvalidEnvironment`, wrapped with the value
    /// and the allowed set.
    #[error(
        "o11y: deployment environment not in the allowed set: {} (allowed: {})",
        go_quote(value),
        allowed.join(", ")
    )]
    InvalidEnvironment {
        /// The environment that resolved.
        value: String,
        /// The allowed environments, sorted.
        allowed: Vec<String>,
    },

    /// The PII mode is hash and the key is shorter than 32 bytes. Go's
    /// `ErrPIIHashKey`.
    #[error("o11y: PIIHash requires WithPIIHashKey with a key of at least 32 bytes")]
    PiiHashKey,

    /// An application registry file could not be read.
    #[error("o11y: reading application registry: {}", go_read_error(path, source))]
    ReadAppRegistry {
        /// The file that could not be read.
        path: String,
        /// The read error.
        #[source]
        source: io::Error,
    },

    /// An application registry file is not a registry document.
    #[error("o11y: {path}: {source}")]
    ParseAppRegistry {
        /// The registry's file name.
        path: String,
        /// Why the file did not decode.
        #[source]
        source: ParseError,
    },

    /// An application registry breaks one or more registry rules. Go's
    /// `ErrInvalidAppRegistry`, wrapped with every violation.
    #[error(
        "o11y: invalid application registry: {path}: {}",
        violations.iter().map(ToString::to_string).collect::<Vec<_>>().join("; ")
    )]
    InvalidAppRegistry {
        /// The registry's file name.
        path: String,
        /// The rules the registry breaks, in the validator's order.
        violations: Vec<Violation>,
    },

    /// Two application registries declare the same namespace. Go's
    /// `ErrInvalidAppRegistry`, wrapped with both file names.
    #[error(
        "o11y: invalid application registry: {first} and {second} both declare namespace {}",
        go_quote(namespace)
    )]
    DuplicateAppNamespace {
        /// The registry that declared the namespace first.
        first: String,
        /// The registry that declared it again.
        second: String,
        /// The namespace both declare.
        namespace: String,
    },

    /// Serialized carrier text cannot be restored. Go's `ErrInvalidCarrier`,
    /// wrapped with the reason.
    #[error("o11y: invalid carrier: {detail}")]
    InvalidCarrier {
        /// Why the text is not a carrier.
        detail: String,
    },

    /// The telemetry resource could not be built.
    #[error("o11y: building resource: {0}")]
    BuildingResource(#[source] BoxError),

    /// The span exporter could not be built.
    #[error("o11y: building span exporter: {0}")]
    BuildingSpanExporter(#[source] BoxError),

    /// The metric reader or exporter could not be built.
    #[error("o11y: building metric reader: {0}")]
    BuildingMetricReader(#[source] BoxError),

    /// The log exporter could not be built.
    #[error("o11y: building log exporter: {0}")]
    BuildingLogExporter(#[source] BoxError),

    /// `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` or
    /// `OTEL_LOGS_EXPORTER` names an exporter libo11y does not know. The
    /// message is Go's autoexport's.
    #[error("o11y: building {}: unknown exporter or metrics producer", component(*signal))]
    UnknownExporter {
        /// The signal whose variable is wrong.
        signal: Signal,
        /// The exporter it names, trimmed and lowercased.
        value: String,
    },

    /// An exporter variable names an exporter the Rust library does not
    /// ship, such as `prometheus` for metrics.
    #[error(
        "o11y: building {}: {} is not supported by libo11y for Rust: use otlp, console or none",
        component(*signal),
        go_quote(value)
    )]
    UnsupportedExporter {
        /// The signal whose variable names it.
        signal: Signal,
        /// The exporter it names.
        value: String,
    },

    /// `OTEL_EXPORTER_OTLP_PROTOCOL` or a signal's own protocol variable
    /// names no OTLP protocol. The message is Go's autoexport's, with
    /// `http/json`, which the Rust library also ships.
    #[error(
        "o11y: building {}: invalid OTLP protocol - should be one of ['grpc', 'http/protobuf', 'http/json']",
        component(*signal)
    )]
    InvalidOtlpProtocol {
        /// The signal routed to OTLP.
        signal: Signal,
        /// The protocol the variable names.
        value: String,
    },

    /// A signal is routed to OTLP over a protocol whose cargo feature
    /// (`otlp-http` or `otlp-grpc`) this build leaves out.
    #[error(
        "o11y: building {}: OTLP protocol {} needs the libo11y feature {}",
        component(*signal),
        go_quote(protocol.as_str()),
        go_quote(protocol.feature())
    )]
    OtlpFeatureDisabled {
        /// The signal routed to OTLP.
        signal: Signal,
        /// The protocol it uses.
        protocol: Protocol,
    },

    /// `OTEL_PROPAGATORS` names a propagator nobody ships. The message is
    /// Go's, which wraps the contrib registry's.
    #[error(
        "o11y: building propagator: {}: unknown propagator: {name}",
        go_quote(name)
    )]
    UnknownPropagator {
        /// The name, trimmed.
        name: String,
    },

    /// `OTEL_PROPAGATORS` names a propagator Go resolves through its contrib
    /// registry but the Rust library does not ship: `b3`, `b3multi`,
    /// `jaeger`, `xray` or `ottrace`.
    #[error(
        "o11y: building propagator: {}: not shipped by libo11y for Rust: use tracecontext, baggage or none, or Builder::propagators",
        go_quote(name)
    )]
    UnsupportedPropagator {
        /// The name.
        name: String,
    },

    /// [`Builder::setup`](crate::Builder::setup) found a global `tracing`
    /// subscriber that libo11y did not install. `tracing` allows one global
    /// subscriber per process, so libo11y cannot install its own.
    #[error(
        "o11y: a global tracing subscriber is already set: set up with Builder::without_tracing_default and add Sdk::tracing_layer to that subscriber"
    )]
    ForeignTracingSubscriber,
}

impl Error {
    /// Reports whether the error is one Go wraps in `ErrInvalidAppRegistry`:
    /// a registry that breaks a rule, or two registries that declare one
    /// namespace. A file that cannot be read or decoded is not, as in Go.
    #[must_use]
    pub fn is_invalid_app_registry(&self) -> bool {
        matches!(
            self,
            Self::InvalidAppRegistry { .. } | Self::DuplicateAppNamespace { .. }
        )
    }
}

/// Renders a read error the way Go's `os.ReadFile` reports it, as the
/// TypeScript port does: the operation, the path, and Go's text for the
/// common errno values.
fn go_read_error(path: &str, err: &io::Error) -> String {
    match err.kind() {
        io::ErrorKind::NotFound => format!("open {path}: no such file or directory"),
        io::ErrorKind::PermissionDenied => format!("open {path}: permission denied"),
        io::ErrorKind::IsADirectory => format!("read {path}: is a directory"),
        _ => format!("open {path}: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_messages_match_go() {
        assert_eq!(Error::AlreadySetup.to_string(), "o11y: already set up");
        assert_eq!(
            Error::NoServiceName.to_string(),
            "o11y: service name required: set WithServiceName or OTEL_SERVICE_NAME"
        );
        assert_eq!(
            Error::NoEnvironment.to_string(),
            "o11y: deployment environment required: set WithEnvironment or deployment.environment.name"
        );
        assert_eq!(
            Error::PiiHashKey.to_string(),
            "o11y: PIIHash requires WithPIIHashKey with a key of at least 32 bytes"
        );
    }

    #[test]
    fn invalid_environment_quotes_as_go() {
        let err = Error::InvalidEnvironment {
            value: "pr\"od\t".to_owned(),
            allowed: vec!["development".into(), "production".into()],
        };
        assert_eq!(
            err.to_string(),
            "o11y: deployment environment not in the allowed set: \"pr\\\"od\\t\" (allowed: development, production)"
        );
    }

    #[test]
    fn export_and_propagator_messages() {
        assert_eq!(
            Error::OtlpFeatureDisabled {
                signal: Signal::Logs,
                protocol: Protocol::Grpc,
            }
            .to_string(),
            "o11y: building log exporter: OTLP protocol \"grpc\" needs the libo11y feature \"otlp-grpc\""
        );
        assert_eq!(
            Error::UnknownPropagator {
                name: "bogus".into()
            }
            .to_string(),
            "o11y: building propagator: \"bogus\": unknown propagator: bogus"
        );
        assert_eq!(
            Error::UnsupportedPropagator { name: "b3".into() }.to_string(),
            "o11y: building propagator: \"b3\": not shipped by libo11y for Rust: use tracecontext, baggage or none, or Builder::propagators"
        );
        assert!(
            Error::ForeignTracingSubscriber
                .to_string()
                .contains("without_tracing_default")
        );
    }

    #[test]
    fn carrier_and_wrapping_messages_match_go() {
        let carrier = Error::InvalidCarrier {
            detail: "no valid traceparent".into(),
        };
        assert_eq!(
            carrier.to_string(),
            "o11y: invalid carrier: no valid traceparent"
        );
        assert_eq!(
            Error::BuildingSpanExporter("boom".into()).to_string(),
            "o11y: building span exporter: boom"
        );
        assert_eq!(
            Error::BuildingMetricReader("x".into()).to_string(),
            "o11y: building metric reader: x"
        );
        assert_eq!(
            Error::BuildingLogExporter("x".into()).to_string(),
            "o11y: building log exporter: x"
        );
        assert_eq!(
            Error::BuildingResource("x".into()).to_string(),
            "o11y: building resource: x"
        );
    }
}
