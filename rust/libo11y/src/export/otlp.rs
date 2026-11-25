//! Builds upstream's OTLP span and log exporters for a resolved
//! [`SignalExport`]: the protocol libo11y chose, a reqwest client or a tonic
//! TLS configuration from the certificate variables, and upstream's own
//! reading of the endpoint, header, timeout, compression and insecure
//! variables.

use crate::BoxError;
use crate::export::tls::TlsMaterial;
use crate::export::{Protocol, SignalExport};

/// Builds `$builder` (`SpanExporter::builder()` or `LogExporter::builder()`)
/// over the transport `$export` names.
macro_rules! build_otlp {
    ($builder:expr, $export:expr) => {{
        let export: &SignalExport = $export;
        let tls: Option<TlsMaterial> = export.tls.load()?;
        match export.protocol {
            #[cfg(feature = "otlp-http")]
            Protocol::HttpProtobuf | Protocol::HttpJson => {
                use opentelemetry_otlp::{WithExportConfig as _, WithHttpConfig as _};
                let protocol = if export.protocol == Protocol::HttpJson {
                    opentelemetry_otlp::Protocol::HttpJson
                } else {
                    opentelemetry_otlp::Protocol::HttpBinary
                };
                let mut builder = $builder.with_http().with_protocol(protocol);
                if let Some(tls) = &tls {
                    builder = builder.with_http_client(tls.blocking_client(export.timeout)?);
                }
                Ok(builder.build()?)
            }
            #[cfg(feature = "otlp-grpc")]
            Protocol::Grpc => {
                use opentelemetry_otlp::{WithExportConfig as _, WithTonicConfig as _};
                require_tokio()?;
                Ok($builder
                    .with_tonic()
                    .with_protocol(opentelemetry_otlp::Protocol::Grpc)
                    .with_tls_config(TlsMaterial::tonic_config(tls.as_ref()))
                    .build()?)
            }
            // Selection refuses a protocol this build does not carry, so
            // this arm exists only for builds with one transport.
            #[allow(unreachable_patterns, reason = "reachable with one transport feature")]
            other => Err(format!(
                "OTLP protocol {other} needs the libo11y feature {}",
                other.feature()
            )
            .into()),
        }
    }};
}

/// Builds the OTLP span exporter.
pub(crate) fn span_exporter(
    export: &SignalExport,
) -> Result<opentelemetry_otlp::SpanExporter, BoxError> {
    build_otlp!(opentelemetry_otlp::SpanExporter::builder(), export)
}

/// Builds the OTLP log exporter.
pub(crate) fn log_exporter(
    export: &SignalExport,
) -> Result<opentelemetry_otlp::LogExporter, BoxError> {
    build_otlp!(opentelemetry_otlp::LogExporter::builder(), export)
}

/// Upstream's tonic exporter dials lazily on a Tokio runtime, which must be
/// running when the exporter is built; without one it would panic.
#[cfg(feature = "otlp-grpc")]
fn require_tokio() -> Result<(), BoxError> {
    tokio::runtime::Handle::try_current().map(|_| ()).map_err(|_| {
        "OTLP over grpc needs a Tokio runtime: build the SDK inside one and keep it running while the SDK exports"
            .into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::EnvLookup;
    use crate::export::tls::tests::{TempDir, pki};
    use crate::export::{Selection, SelectionInputs};

    fn traces(vars: &[(String, String)]) -> SignalExport {
        Selection::resolve(
            &EnvLookup::from_pairs(vars.iter().cloned()),
            SelectionInputs::default(),
        )
        .expect("resolves")
        .traces
    }

    fn pairs(vars: &[(&str, &str)]) -> Vec<(String, String)> {
        vars.iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[cfg(feature = "otlp-http")]
    #[test]
    fn http_exporters_build_for_both_encodings() {
        for protocol in ["http/protobuf", "http/json"] {
            let export = traces(&pairs(&[("OTEL_EXPORTER_OTLP_PROTOCOL", protocol)]));
            assert_eq!(export.route, crate::export::Route::Otlp);
            span_exporter(&export).expect("a span exporter");
            log_exporter(&export).expect("a log exporter");
        }
    }

    #[cfg(feature = "otlp-http")]
    #[test]
    fn an_http_exporter_takes_the_certificate_files() {
        let dir = TempDir::new("otlp-http-tls");
        let pki = pki();
        let ca = dir.write("ca.pem", pki.ca.as_bytes());
        let cert = dir.write("client.pem", pki.client_cert.as_bytes());
        let key = dir.write("client.key", pki.client_key.as_bytes());
        let export = traces(&[
            (
                "OTEL_EXPORTER_OTLP_CERTIFICATE".to_owned(),
                ca.display().to_string(),
            ),
            (
                "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE".to_owned(),
                cert.display().to_string(),
            ),
            (
                "OTEL_EXPORTER_OTLP_CLIENT_KEY".to_owned(),
                key.display().to_string(),
            ),
        ]);
        span_exporter(&export).expect("a span exporter with TLS");
    }

    #[test]
    fn an_unreadable_certificate_fails_the_build() {
        let export = traces(&pairs(&[(
            "OTEL_EXPORTER_OTLP_CERTIFICATE",
            "/no/such/ca.pem",
        )]));
        let err = span_exporter(&export).expect_err("unreadable");
        assert!(
            err.to_string()
                .starts_with("reading OTEL_EXPORTER_OTLP_CERTIFICATE \"/no/such/ca.pem\""),
            "{err}"
        );
    }

    #[cfg(feature = "otlp-grpc")]
    #[test]
    fn grpc_needs_a_tokio_runtime() {
        let export = traces(&pairs(&[("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")]));
        let err = span_exporter(&export).expect_err("no runtime");
        assert!(
            err.to_string()
                .starts_with("OTLP over grpc needs a Tokio runtime"),
            "{err}"
        );
    }

    #[cfg(feature = "otlp-grpc")]
    #[tokio::test]
    async fn grpc_exporters_build_with_the_certificate_files() {
        let dir = TempDir::new("otlp-grpc-tls");
        let pki = pki();
        let ca = dir.write("ca.pem", pki.ca.as_bytes());
        let cert = dir.write("client.pem", pki.client_cert.as_bytes());
        let key = dir.write("client.key", pki.client_key.as_bytes());
        let export = traces(&[
            ("OTEL_EXPORTER_OTLP_PROTOCOL".to_owned(), "grpc".to_owned()),
            (
                "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE".to_owned(),
                ca.display().to_string(),
            ),
            (
                "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE".to_owned(),
                cert.display().to_string(),
            ),
            (
                "OTEL_EXPORTER_OTLP_CLIENT_KEY".to_owned(),
                key.display().to_string(),
            ),
        ]);
        span_exporter(&export).expect("a gRPC span exporter with TLS");
        log_exporter(&export).expect("a gRPC log exporter with TLS");
    }
}
