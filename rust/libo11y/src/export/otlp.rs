//! Builds upstream's OTLP span and log exporters for a resolved
//! [`SignalExport`]: the protocol, endpoint, timeout, headers, compression,
//! insecure flag and TLS material resolved through [`EnvLookup`].

#[cfg(feature = "otlp-http")]
use std::collections::HashMap;

use crate::BoxError;
use crate::env::EnvLookup;
use crate::export::tls::TlsMaterial;
use crate::export::{Protocol, SignalExport};

/// Resolves `OTEL_EXPORTER_OTLP_<SIGNAL>_COMPRESSION`, else
/// `OTEL_EXPORTER_OTLP_COMPRESSION`, through `env`.
fn signal_compression(env: &EnvLookup, upper: &str) -> Option<opentelemetry_otlp::Compression> {
    let raw = env
        .trimmed(&format!("OTEL_EXPORTER_OTLP_{upper}_COMPRESSION"))
        .or_else(|| env.trimmed("OTEL_EXPORTER_OTLP_COMPRESSION"));
    match raw.as_deref().map(str::to_ascii_lowercase).as_deref() {
        Some("gzip") => Some(opentelemetry_otlp::Compression::Gzip),
        _ => None,
    }
}

/// Resolves raw `key=value` header entries from
/// `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS`, else `OTEL_EXPORTER_OTLP_HEADERS`,
/// without percent-decoding (for `WithHttpConfig::with_headers`, which
/// percent-decodes values itself).
#[cfg(feature = "otlp-http")]
fn signal_http_headers(env: &EnvLookup, upper: &str) -> HashMap<String, String> {
    let Some(raw) = env
        .trimmed(&format!("OTEL_EXPORTER_OTLP_{upper}_HEADERS"))
        .or_else(|| env.trimmed("OTEL_EXPORTER_OTLP_HEADERS"))
    else {
        return HashMap::new();
    };
    raw.split(',')
        .filter_map(|entry| {
            let (key, value) = entry.trim().split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some((key.to_owned(), value.trim().to_owned()))
        })
        .collect()
}

/// Resolves `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS`, else
/// `OTEL_EXPORTER_OTLP_HEADERS`, into a tonic `MetadataMap`.
#[cfg(feature = "otlp-grpc")]
fn signal_grpc_metadata(env: &EnvLookup, upper: &str) -> tonic::metadata::MetadataMap {
    let mut map = tonic::metadata::MetadataMap::new();
    let Some(raw) = env
        .trimmed(&format!("OTEL_EXPORTER_OTLP_{upper}_HEADERS"))
        .or_else(|| env.trimmed("OTEL_EXPORTER_OTLP_HEADERS"))
    else {
        return map;
    };
    for (name, value) in crate::metrics::sink::parse_headers(&raw) {
        let lower = name.to_ascii_lowercase();
        if let (Ok(k), Ok(v)) = (
            tonic::metadata::MetadataKey::<tonic::metadata::Ascii>::from_bytes(lower.as_bytes()),
            tonic::metadata::MetadataValue::try_from(value.as_str()),
        ) {
            map.insert(k, v);
        }
    }
    map
}

/// Resolves `OTEL_EXPORTER_OTLP_<SIGNAL>_INSECURE`, else
/// `OTEL_EXPORTER_OTLP_INSECURE`, through `env`.
#[cfg(feature = "otlp-grpc")]
fn signal_insecure(env: &EnvLookup, upper: &str) -> bool {
    let raw = env
        .trimmed(&format!("OTEL_EXPORTER_OTLP_{upper}_INSECURE"))
        .or_else(|| env.trimmed("OTEL_EXPORTER_OTLP_INSECURE"));
    raw.is_some_and(|v| v.eq_ignore_ascii_case("true"))
}

/// Builds `$builder` (`SpanExporter::builder()` or `LogExporter::builder()`)
/// over the transport `$export` names.
macro_rules! build_otlp {
    ($builder:expr, $export:expr, $env:expr, $upper:expr) => {{
        let export: &SignalExport = $export;
        let env: &EnvLookup = $env;
        let upper: &str = $upper;
        let tls: Option<TlsMaterial> = export.tls.load()?;
        let compression = signal_compression(env, upper);
        match export.protocol {
            #[cfg(feature = "otlp-http")]
            Protocol::HttpProtobuf | Protocol::HttpJson => {
                use opentelemetry_otlp::{WithExportConfig as _, WithHttpConfig as _};
                let protocol = if export.protocol == Protocol::HttpJson {
                    opentelemetry_otlp::Protocol::HttpJson
                } else {
                    opentelemetry_otlp::Protocol::HttpBinary
                };
                let mut builder = $builder
                    .with_http()
                    .with_protocol(protocol)
                    .with_endpoint(export.endpoint.clone())
                    .with_timeout(export.timeout);
                let headers = signal_http_headers(env, upper);
                if !headers.is_empty() {
                    builder = builder.with_headers(headers);
                }
                if let Some(comp) = compression {
                    builder = builder.with_compression(comp);
                }
                if let Some(tls) = &tls {
                    builder = builder.with_http_client(tls.blocking_client(export.timeout)?);
                }
                Ok(builder.build()?)
            }
            #[cfg(feature = "otlp-grpc")]
            Protocol::Grpc => {
                use opentelemetry_otlp::{WithExportConfig as _, WithTonicConfig as _};
                require_tokio()?;
                let endpoint_str = crate::metrics::sink::normalize_grpc_endpoint(
                    &export.endpoint,
                    signal_insecure(env, upper),
                );
                let mut builder = $builder
                    .with_tonic()
                    .with_protocol(opentelemetry_otlp::Protocol::Grpc)
                    .with_endpoint(endpoint_str.clone())
                    .with_timeout(export.timeout);
                let metadata = signal_grpc_metadata(env, upper);
                if !metadata.is_empty() {
                    builder = builder.with_metadata(metadata);
                }
                if let Some(comp) = compression {
                    builder = builder.with_compression(comp);
                }
                // Only attach TLS for https:// endpoints or explicit TLS
                // material; never for plaintext http:// or Unix sockets.
                let is_https = endpoint_str
                    .get(..8)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"));
                if !endpoint_str.starts_with("unix:") && (tls.is_some() || is_https) {
                    builder = builder.with_tls_config(TlsMaterial::tonic_config(tls.as_ref()));
                }
                Ok(builder.build()?)
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
    env: &EnvLookup,
) -> Result<opentelemetry_otlp::SpanExporter, BoxError> {
    build_otlp!(
        opentelemetry_otlp::SpanExporter::builder(),
        export,
        env,
        "TRACES"
    )
}

/// Builds the OTLP log exporter.
pub(crate) fn log_exporter(
    export: &SignalExport,
    env: &EnvLookup,
) -> Result<opentelemetry_otlp::LogExporter, BoxError> {
    build_otlp!(
        opentelemetry_otlp::LogExporter::builder(),
        export,
        env,
        "LOGS"
    )
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
            span_exporter(&export, &EnvLookup::empty()).expect("a span exporter");
            log_exporter(&export, &EnvLookup::empty()).expect("a log exporter");
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
        span_exporter(&export, &EnvLookup::empty()).expect("a span exporter with TLS");
    }

    #[test]
    fn an_unreadable_certificate_fails_the_build() {
        let export = traces(&pairs(&[(
            "OTEL_EXPORTER_OTLP_CERTIFICATE",
            "/no/such/ca.pem",
        )]));
        let err = span_exporter(&export, &EnvLookup::empty()).expect_err("unreadable");
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
        let err = span_exporter(&export, &EnvLookup::empty()).expect_err("no runtime");
        assert!(
            err.to_string()
                .starts_with("OTLP over grpc needs a Tokio runtime"),
            "{err}"
        );
    }

    #[cfg(feature = "otlp-grpc")]
    #[tokio::test]
    async fn a_grpc_exporter_builds_for_a_unix_socket() {
        let export = traces(&pairs(&[
            ("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc"),
            (
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "unix:///tmp/libo11y-no-collector.sock",
            ),
        ]));
        span_exporter(&export, &EnvLookup::empty()).expect("no TLS configuration for a socket");
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
        span_exporter(&export, &EnvLookup::empty()).expect("a gRPC span exporter with TLS");
        log_exporter(&export, &EnvLookup::empty()).expect("a gRPC log exporter with TLS");
    }
}
