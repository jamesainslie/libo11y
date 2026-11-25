//! Which exporter each signal uses, resolved from the standard `OTEL_*`
//! variables, as upstream opentelemetry-rust does not.
//!
//! `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` and `OTEL_LOGS_EXPORTER`
//! name the exporter (`otlp` by default, `console` or `none`); a list uses
//! its first value. The OTLP protocol of each signal comes from
//! `OTEL_EXPORTER_OTLP_<SIGNAL>_PROTOCOL`, then `OTEL_EXPORTER_OTLP_PROTOCOL`,
//! then `http/protobuf`, as Go's autoexport chooses it. The certificate
//! variables name the TLS material an OTLP exporter uses. Under hermetic mode
//! nothing is read and a signal with nothing injected is off, and while
//! `OTEL_SDK_DISABLED` is true every signal is off.

pub(crate) mod failures;
#[cfg(any(feature = "otlp-http", feature = "otlp-grpc"))]
pub(crate) mod otlp;
#[cfg_attr(
    not(any(feature = "otlp-http", feature = "otlp-grpc")),
    allow(dead_code, reason = "only an OTLP exporter reads the TLS files")
)]
pub(crate) mod tls;

use std::fmt;
use std::time::Duration;

use libo11y_spec::Signal;

use crate::Error;
use crate::env::EnvLookup;

pub(crate) use tls::TlsFiles;

/// The default OTLP export timeout, as the OpenTelemetry specification and
/// upstream's exporters set it.
const DEFAULT_OTLP_TIMEOUT: Duration = Duration::from_secs(10);

/// Where a signal's telemetry goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Route {
    /// To the exporter, processor or reader the builder was given.
    Injected,
    /// To an OTLP exporter libo11y builds.
    Otlp,
    /// To upstream's stdout exporter.
    Console,
    /// Nowhere.
    None,
}

impl Route {
    /// The route as the effective configuration reports it.
    #[cfg_attr(not(test), allow(dead_code, reason = "R3b's startup summary reads it"))]
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Injected => "injected",
            Self::Otlp => "otlp",
            Self::Console => "console",
            Self::None => "none",
        }
    }
}

/// An OTLP transport and encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protocol {
    /// Protobuf over HTTP, the default.
    HttpProtobuf,
    /// JSON over HTTP.
    HttpJson,
    /// Protobuf over gRPC.
    Grpc,
}

impl Protocol {
    /// The protocol as `OTEL_EXPORTER_OTLP_PROTOCOL` spells it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::HttpProtobuf => "http/protobuf",
            Self::HttpJson => "http/json",
            Self::Grpc => "grpc",
        }
    }

    /// The libo11y cargo feature that carries the protocol.
    pub(crate) const fn feature(self) -> &'static str {
        match self {
            Self::HttpProtobuf | Self::HttpJson => "otlp-http",
            Self::Grpc => "otlp-grpc",
        }
    }

    /// Whether this build carries the protocol.
    pub(crate) const fn is_built_in(self) -> bool {
        match self {
            Self::HttpProtobuf | Self::HttpJson => cfg!(feature = "otlp-http"),
            Self::Grpc => cfg!(feature = "otlp-grpc"),
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "http/protobuf" => Some(Self::HttpProtobuf),
            "http/json" => Some(Self::HttpJson),
            "grpc" => Some(Self::Grpc),
            _ => None,
        }
    }
}

impl fmt::Display for Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What one signal exports through: the route and, for an OTLP route, the
/// protocol, the request timeout and the TLS files. The metric exporter
/// libo11y builds for itself reads the same values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SignalExport {
    pub(crate) route: Route,
    pub(crate) protocol: Protocol,
    /// `OTEL_EXPORTER_OTLP_[SIGNAL_]TIMEOUT`, for a client libo11y builds.
    pub(crate) timeout: Duration,
    pub(crate) tls: TlsFiles,
}

impl SignalExport {
    fn off() -> Self {
        Self {
            route: Route::None,
            protocol: Protocol::HttpProtobuf,
            timeout: DEFAULT_OTLP_TIMEOUT,
            tls: TlsFiles::default(),
        }
    }

    fn injected() -> Self {
        Self {
            route: Route::Injected,
            ..Self::off()
        }
    }
}

/// The resolved export of every signal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Selection {
    pub(crate) traces: SignalExport,
    pub(crate) metrics: SignalExport,
    pub(crate) logs: SignalExport,
}

/// What the builder was given that decides the selection.
#[derive(Debug, Clone, Copy, Default)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent facts the builder reports, not a state machine"
)]
pub(crate) struct SelectionInputs {
    /// Hermetic mode: nothing is read, and a signal with nothing injected
    /// is off.
    pub(crate) ignore_env: bool,
    /// `OTEL_SDK_DISABLED` switched every signal off.
    pub(crate) disabled: bool,
    pub(crate) traces_injected: bool,
    pub(crate) metrics_injected: bool,
    pub(crate) logs_injected: bool,
    /// Log export is off altogether.
    pub(crate) logs_off: bool,
}

impl Selection {
    /// Resolves every signal's export, the metrics first, then the traces,
    /// then the logs, the order in which Go builds them and so reports the
    /// first broken variable.
    ///
    /// An injected signal reads no variable, so an unusable
    /// `OTEL_TRACES_EXPORTER` cannot fail an SDK whose traces go to an
    /// injected exporter, as in Go.
    pub(crate) fn resolve(env: &EnvLookup, inputs: SelectionInputs) -> Result<Self, Error> {
        if inputs.disabled {
            return Ok(Self {
                traces: SignalExport::off(),
                metrics: SignalExport::off(),
                logs: SignalExport::off(),
            });
        }
        let resolve = |signal: Signal, injected: bool, off: bool| {
            if off {
                Ok(SignalExport::off())
            } else if injected {
                Ok(SignalExport::injected())
            } else if inputs.ignore_env {
                Ok(SignalExport::off())
            } else {
                signal_export(env, signal)
            }
        };
        let metrics = resolve(Signal::Metrics, inputs.metrics_injected, false)?;
        let traces = resolve(Signal::Traces, inputs.traces_injected, false)?;
        let logs = resolve(Signal::Logs, inputs.logs_injected, inputs.logs_off)?;
        Ok(Self {
            traces,
            metrics,
            logs,
        })
    }
}

/// The `OTEL_<SIGNAL>_EXPORTER` variable, `TRACES`, `METRICS` or `LOGS`.
fn signal_upper(signal: Signal) -> &'static str {
    match signal {
        Signal::Traces => "TRACES",
        Signal::Metrics => "METRICS",
        // The resource is no export signal; the selection never asks.
        _ => "LOGS",
    }
}

/// Reads one signal's export from the environment.
fn signal_export(env: &EnvLookup, signal: Signal) -> Result<SignalExport, Error> {
    let upper = signal_upper(signal);
    let route = route_from(env, signal)?;
    let mut export = SignalExport {
        route,
        tls: TlsFiles::from_env(env, upper),
        timeout: timeout_from(env, upper),
        ..SignalExport::off()
    };
    if route == Route::Otlp {
        let value = env
            .trimmed(&format!("OTEL_EXPORTER_OTLP_{upper}_PROTOCOL"))
            .or_else(|| env.trimmed("OTEL_EXPORTER_OTLP_PROTOCOL"));
        export.protocol = match value {
            None => Protocol::HttpProtobuf,
            Some(value) => {
                Protocol::parse(&value).ok_or(Error::InvalidOtlpProtocol { signal, value })?
            }
        };
        if !export.protocol.is_built_in() {
            return Err(Error::OtlpFeatureDisabled {
                signal,
                protocol: export.protocol,
            });
        }
    }
    Ok(export)
}

/// Reads `OTEL_<SIGNAL>_EXPORTER`: the first non-blank entry of its comma
/// list, trimmed and lowercased, `otlp` when there is none.
fn route_from(env: &EnvLookup, signal: Signal) -> Result<Route, Error> {
    let raw = env
        .get(&format!("OTEL_{}_EXPORTER", signal_upper(signal)))
        .unwrap_or_default();
    let first = raw
        .split(',')
        .map(|entry| entry.trim().to_lowercase())
        .find(|entry| !entry.is_empty());
    match first.as_deref() {
        None | Some("otlp") => Ok(Route::Otlp),
        Some("console") => Ok(Route::Console),
        Some("none") => Ok(Route::None),
        Some("prometheus") if signal == Signal::Metrics => Err(Error::UnsupportedExporter {
            signal,
            value: "prometheus".to_owned(),
        }),
        Some(other) => Err(Error::UnknownExporter {
            signal,
            value: other.to_owned(),
        }),
    }
}

/// Reads `OTEL_EXPORTER_OTLP_[SIGNAL_]TIMEOUT` in milliseconds, as
/// upstream's exporters do: the signal's variable first, a value that is not
/// a whole number is skipped, and the default is ten seconds.
fn timeout_from(env: &EnvLookup, upper: &str) -> Duration {
    [
        format!("OTEL_EXPORTER_OTLP_{upper}_TIMEOUT"),
        "OTEL_EXPORTER_OTLP_TIMEOUT".to_owned(),
    ]
    .iter()
    .find_map(|key| env.trimmed(key).and_then(|v| v.parse::<u64>().ok()))
    .map_or(DEFAULT_OTLP_TIMEOUT, Duration::from_millis)
}

/// The component Go names in an exporter error: `span exporter`, `metric
/// reader` or `log exporter`.
pub(crate) fn component(signal: Signal) -> &'static str {
    match signal {
        Signal::Traces => "span exporter",
        Signal::Metrics => "metric reader",
        _ => "log exporter",
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn env(vars: &[(&str, &str)]) -> EnvLookup {
        EnvLookup::from_pairs(vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())))
    }

    fn resolve(vars: &[(&str, &str)]) -> Result<Selection, Error> {
        Selection::resolve(&env(vars), SelectionInputs::default())
    }

    #[test]
    fn every_signal_defaults_to_otlp_over_http_protobuf() {
        let selection = resolve(&[]).expect("defaults resolve");
        for export in [&selection.traces, &selection.metrics, &selection.logs] {
            assert_eq!(export.route, Route::Otlp);
            assert_eq!(export.protocol, Protocol::HttpProtobuf);
            assert_eq!(export.timeout, Duration::from_secs(10));
            assert_eq!(export.tls, TlsFiles::default());
        }
    }

    #[test]
    fn exporter_variables_select_each_signal() {
        let table: &[(&str, Route)] = &[
            ("otlp", Route::Otlp),
            ("console", Route::Console),
            ("none", Route::None),
            ("", Route::Otlp),
            ("  ", Route::Otlp),
            (" Console ", Route::Console),
            ("NONE", Route::None),
            ("console,otlp", Route::Console),
            (" , none, otlp", Route::None),
            (",,", Route::Otlp),
        ];
        for (value, want) in table {
            for (var, pick) in [
                ("OTEL_TRACES_EXPORTER", 0),
                ("OTEL_METRICS_EXPORTER", 1),
                ("OTEL_LOGS_EXPORTER", 2),
            ] {
                let selection = resolve(&[(var, value)]).expect("a known exporter");
                let got = [&selection.traces, &selection.metrics, &selection.logs][pick].route;
                assert_eq!(got, *want, "{var}={value:?}");
            }
        }
    }

    #[test]
    fn an_unknown_exporter_is_an_error_with_gos_message() {
        let err = resolve(&[("OTEL_TRACES_EXPORTER", "zipkin")]).expect_err("unknown");
        assert!(matches!(
            &err,
            Error::UnknownExporter { signal: Signal::Traces, value } if value == "zipkin"
        ));
        assert_eq!(
            err.to_string(),
            "o11y: building span exporter: unknown exporter or metrics producer"
        );
        let err = resolve(&[("OTEL_LOGS_EXPORTER", "prometheus")]).expect_err("unknown");
        assert_eq!(
            err.to_string(),
            "o11y: building log exporter: unknown exporter or metrics producer"
        );
    }

    #[test]
    fn prometheus_metrics_are_unsupported() {
        let err = resolve(&[("OTEL_METRICS_EXPORTER", "Prometheus")]).expect_err("unsupported");
        assert!(matches!(
            err,
            Error::UnsupportedExporter {
                signal: Signal::Metrics,
                ..
            }
        ));
        assert_eq!(
            err.to_string(),
            "o11y: building metric reader: \"prometheus\" is not supported by libo11y for Rust: use otlp, console or none"
        );
    }

    #[test]
    fn metrics_are_checked_before_traces_as_go_builds_them() {
        let err = resolve(&[
            ("OTEL_TRACES_EXPORTER", "bogus"),
            ("OTEL_METRICS_EXPORTER", "bogus"),
        ])
        .expect_err("both broken");
        assert!(matches!(
            err,
            Error::UnknownExporter {
                signal: Signal::Metrics,
                ..
            }
        ));
    }

    #[test]
    fn the_signal_protocol_beats_the_general_one() {
        let selection = resolve(&[
            ("OTEL_EXPORTER_OTLP_PROTOCOL", "http/json"),
            ("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "grpc"),
            ("OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", " "),
        ])
        .expect("known protocols");
        assert_eq!(selection.traces.protocol, Protocol::Grpc);
        assert_eq!(selection.metrics.protocol, Protocol::HttpJson);
        assert_eq!(selection.logs.protocol, Protocol::HttpJson);
    }

    #[test]
    fn an_invalid_protocol_fails_only_an_otlp_signal() {
        let err = resolve(&[("OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "http/thrift")])
            .expect_err("invalid");
        assert!(matches!(
            &err,
            Error::InvalidOtlpProtocol { signal: Signal::Metrics, value } if value == "http/thrift"
        ));
        assert_eq!(
            err.to_string(),
            "o11y: building metric reader: invalid OTLP protocol - should be one of ['grpc', 'http/protobuf', 'http/json']"
        );
        let selection = resolve(&[
            ("OTEL_EXPORTER_OTLP_PROTOCOL", "bogus"),
            ("OTEL_TRACES_EXPORTER", "console"),
            ("OTEL_METRICS_EXPORTER", "none"),
            ("OTEL_LOGS_EXPORTER", "none"),
        ])
        .expect("no OTLP signal reads the protocol");
        assert_eq!(selection.traces.route, Route::Console);
    }

    #[test]
    fn protocols_are_case_sensitive() {
        assert!(resolve(&[("OTEL_EXPORTER_OTLP_PROTOCOL", "GRPC")]).is_err());
    }

    #[test]
    fn timeouts_and_tls_files_come_per_signal() {
        let selection = resolve(&[
            ("OTEL_EXPORTER_OTLP_TIMEOUT", "2500"),
            ("OTEL_EXPORTER_OTLP_LOGS_TIMEOUT", "300"),
            ("OTEL_EXPORTER_OTLP_METRICS_TIMEOUT", "soon"),
            ("OTEL_EXPORTER_OTLP_CERTIFICATE", "/etc/ca.pem"),
            (
                "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE",
                "/etc/traces-ca.pem",
            ),
            ("OTEL_EXPORTER_OTLP_CLIENT_KEY", "/etc/key.pem"),
            (
                "OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE",
                "/etc/m.pem",
            ),
        ])
        .expect("resolves");
        assert_eq!(selection.traces.timeout, Duration::from_millis(2500));
        assert_eq!(selection.metrics.timeout, Duration::from_millis(2500));
        assert_eq!(selection.logs.timeout, Duration::from_millis(300));
        assert_eq!(
            selection.traces.tls.certificate,
            Some(PathBuf::from("/etc/traces-ca.pem"))
        );
        assert_eq!(
            selection.logs.tls.certificate,
            Some(PathBuf::from("/etc/ca.pem"))
        );
        assert_eq!(
            selection.metrics.tls.client_key,
            Some(PathBuf::from("/etc/key.pem"))
        );
        assert_eq!(
            selection.metrics.tls.client_certificate,
            Some(PathBuf::from("/etc/m.pem"))
        );
        assert_eq!(selection.logs.tls.client_certificate, None);
    }

    #[test]
    fn an_injected_signal_reads_no_variable() {
        let selection = Selection::resolve(
            &env(&[
                ("OTEL_TRACES_EXPORTER", "no-such-exporter"),
                ("OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "bogus"),
            ]),
            SelectionInputs {
                traces_injected: true,
                ..SelectionInputs::default()
            },
        )
        .expect("the injected signal is not read");
        assert_eq!(selection.traces.route, Route::Injected);
        assert_eq!(selection.metrics.route, Route::Otlp);
    }

    #[test]
    fn hermetic_mode_turns_off_what_is_not_injected() {
        let selection = Selection::resolve(
            &env(&[("OTEL_TRACES_EXPORTER", "bogus")]),
            SelectionInputs {
                ignore_env: true,
                metrics_injected: true,
                ..SelectionInputs::default()
            },
        )
        .expect("hermetic reads nothing");
        assert_eq!(selection.traces.route, Route::None);
        assert_eq!(selection.metrics.route, Route::Injected);
        assert_eq!(selection.logs.route, Route::None);
    }

    #[test]
    fn a_disabled_sdk_exports_nothing_and_reads_no_exporter() {
        let selection = Selection::resolve(
            &env(&[("OTEL_TRACES_EXPORTER", "bogus")]),
            SelectionInputs {
                disabled: true,
                traces_injected: true,
                ..SelectionInputs::default()
            },
        )
        .expect("disabled reads no exporter");
        for export in [&selection.traces, &selection.metrics, &selection.logs] {
            assert_eq!(export.route, Route::None);
        }
    }

    #[test]
    fn logs_turned_off_stay_off_even_when_injected() {
        let selection = Selection::resolve(
            &env(&[("OTEL_LOGS_EXPORTER", "bogus")]),
            SelectionInputs {
                logs_off: true,
                logs_injected: true,
                ..SelectionInputs::default()
            },
        )
        .expect("off reads nothing");
        assert_eq!(selection.logs.route, Route::None);
    }

    #[test]
    fn routes_report_as_the_summary_names_them() {
        assert_eq!(Route::Injected.as_str(), "injected");
        assert_eq!(Route::Otlp.as_str(), "otlp");
        assert_eq!(Route::Console.as_str(), "console");
        assert_eq!(Route::None.as_str(), "none");
    }
}
