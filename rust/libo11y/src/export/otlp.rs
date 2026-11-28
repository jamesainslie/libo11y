//! Builds upstream's OTLP span and log exporters for a resolved
//! [`SignalExport`]: the protocol, endpoint, timeout, headers, compression,
//! insecure flag and TLS material resolved through [`EnvLookup`].
//!
//! Upstream's exporters also read the header variables from the process
//! environment and lay them over the headers given in code. A lookup other
//! than the process environment would then send the process's headers,
//! which may hold another collector's credentials, to the collector the
//! lookup names. [`header_corrections`] lists what upstream adds, and the
//! exporter's transport undoes it on every request.

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

/// Every header variable upstream's exporter may read from the process
/// environment for a signal: both the signal's own and the general one, so
/// neither a blank signal variable nor disjoint keys can leak ambient values.
fn ambient_headers(upper: &str) -> Vec<String> {
    [
        format!("OTEL_EXPORTER_OTLP_{upper}_HEADERS"),
        "OTEL_EXPORTER_OTLP_HEADERS".to_owned(),
    ]
    .into_iter()
    .filter_map(|var| std::env::var(var).ok())
    .filter(|val| !val.trim().is_empty())
    .collect()
}

/// The header variable the lookup resolves for a signal, untrimmed names
/// and percent-decoded values, as the metric exporter reads it.
fn lookup_headers(env: &EnvLookup, upper: &str) -> Vec<(String, String)> {
    env.trimmed(&format!("OTEL_EXPORTER_OTLP_{upper}_HEADERS"))
        .or_else(|| env.trimmed("OTEL_EXPORTER_OTLP_HEADERS"))
        .map(|raw| crate::metrics::sink::parse_headers(&raw))
        .unwrap_or_default()
}

/// What to do about each header upstream may add from `ambient`, the process
/// environment's header variables: the lowercase name, with the value the
/// lookup resolved for it, or `None` when the lookup resolved none and the
/// header must not be sent. Empty when the process environment sets no
/// header.
fn header_corrections(
    ambient: &[String],
    resolved: &[(String, String)],
) -> Vec<(String, Option<String>)> {
    let mut corrections: Vec<(String, Option<String>)> = Vec::new();
    for raw in ambient {
        for (name, _) in crate::metrics::sink::parse_headers(raw) {
            let name = name.to_ascii_lowercase();
            if corrections.iter().any(|(seen, _)| *seen == name) {
                continue;
            }
            // The last entry of a repeated name wins, as in a header map.
            let value = resolved
                .iter()
                .rev()
                .find(|(key, _)| key.eq_ignore_ascii_case(&name))
                .map(|(_, value)| value.clone());
            corrections.push((name, value));
        }
    }
    corrections
}

/// An HTTP client that puts the lookup's headers back over the ones
/// upstream's exporter took from the process environment.
#[cfg(feature = "otlp-http")]
#[derive(Debug)]
struct LookupHeaders<C> {
    inner: C,
    corrections: Vec<(http::HeaderName, Option<http::HeaderValue>)>,
}

#[cfg(feature = "otlp-http")]
impl<C> LookupHeaders<C> {
    /// Wraps `inner`. A correction whose name or value is not a valid
    /// header removes the header, so nothing ambient is sent in its place.
    fn new(inner: C, corrections: Vec<(String, Option<String>)>) -> Self {
        let corrections = corrections
            .into_iter()
            .filter_map(|(name, value)| {
                let name = http::HeaderName::from_bytes(name.as_bytes()).ok()?;
                let value = value.and_then(|value| http::HeaderValue::from_str(&value).ok());
                Some((name, value))
            })
            .collect();
        Self { inner, corrections }
    }
}

#[cfg(feature = "otlp-http")]
#[async_trait::async_trait]
impl<C: opentelemetry_http::HttpClient> opentelemetry_http::HttpClient for LookupHeaders<C> {
    async fn send_bytes(
        &self,
        mut request: opentelemetry_http::Request<opentelemetry_http::Bytes>,
    ) -> Result<
        opentelemetry_http::Response<opentelemetry_http::Bytes>,
        opentelemetry_http::HttpError,
    > {
        for (name, value) in &self.corrections {
            match value {
                Some(value) => {
                    request.headers_mut().insert(name, value.clone());
                }
                None => {
                    request.headers_mut().remove(name);
                }
            }
        }
        self.inner.send_bytes(request).await
    }
}

/// Validates a gRPC metadata entry (ASCII or `*-bin` base64) and returns it as
/// an `http::HeaderName`/`http::HeaderValue` pair suitable for
/// `tonic::metadata::MetadataMap::from_headers`.
#[cfg(feature = "otlp-grpc")]
pub(crate) fn parse_grpc_header(
    name: &str,
    value: &str,
) -> Option<(http::HeaderName, http::HeaderValue)> {
    let lower = name.to_ascii_lowercase();
    let hname = http::HeaderName::from_bytes(lower.as_bytes()).ok()?;
    let hval = parse_grpc_header_value(&hname, value)?;
    Some((hname, hval))
}

/// Validates a gRPC metadata value for `name`: `*-bin` keys must be valid gRPC
/// binary keys with valid base64 values; ASCII keys must be valid gRPC ASCII
/// keys and values.
#[cfg(feature = "otlp-grpc")]
fn parse_grpc_header_value(name: &http::HeaderName, value: &str) -> Option<http::HeaderValue> {
    let key_str = name.as_str();
    if key_str.ends_with("-bin") {
        let bin_key =
            tonic::metadata::MetadataKey::<tonic::metadata::Binary>::from_bytes(key_str.as_bytes())
                .ok()?;
        let hval = http::HeaderValue::from_str(value).ok()?;
        let mut check = http::HeaderMap::new();
        check.insert(name.clone(), hval.clone());
        let map = tonic::metadata::MetadataMap::from_headers(check);
        map.get_bin(&bin_key)?.to_bytes().ok()?;
        Some(hval)
    } else {
        tonic::metadata::MetadataKey::<tonic::metadata::Ascii>::from_bytes(key_str.as_bytes())
            .ok()?;
        tonic::metadata::MetadataValue::<tonic::metadata::Ascii>::try_from(value).ok()?;
        http::HeaderValue::from_str(value).ok()
    }
}

/// A tonic interceptor that puts the lookup's metadata back over the
/// entries upstream's exporter took from the process environment. Upstream
/// constructs its metadata with `MetadataMap::from_headers` (which admits both
/// ASCII and `*-bin` binary entries) and runs a caller's interceptor after
/// adding its own metadata. Operating on the underlying `http::HeaderMap`
/// ensures both ASCII and binary metadata entries are replaced or removed.
#[cfg(feature = "otlp-grpc")]
#[derive(Debug, Clone)]
struct LookupMetadata {
    corrections: std::sync::Arc<[(http::HeaderName, Option<http::HeaderValue>)]>,
}

#[cfg(feature = "otlp-grpc")]
impl LookupMetadata {
    /// A correction whose value is not valid gRPC metadata removes the entry,
    /// so nothing ambient or malformed is sent in its place.
    fn new(corrections: Vec<(String, Option<String>)>) -> Self {
        let corrections = corrections
            .into_iter()
            .filter_map(|(name, value)| {
                let name = http::HeaderName::from_bytes(name.as_bytes()).ok()?;
                let value = value.and_then(|value| parse_grpc_header_value(&name, &value));
                Some((name, value))
            })
            .collect();
        Self { corrections }
    }
}

#[cfg(feature = "otlp-grpc")]
impl tonic::service::Interceptor for LookupMetadata {
    fn call(
        &mut self,
        mut request: tonic::Request<()>,
    ) -> Result<tonic::Request<()>, tonic::Status> {
        let mut headers =
            std::mem::replace(request.metadata_mut(), tonic::metadata::MetadataMap::new())
                .into_headers();
        for (name, value) in self.corrections.iter() {
            match value {
                Some(value) => {
                    headers.insert(name, value.clone());
                }
                None => {
                    headers.remove(name);
                }
            }
        }
        *request.metadata_mut() = tonic::metadata::MetadataMap::from_headers(headers);
        Ok(request)
    }
}

/// Resolves `OTEL_EXPORTER_OTLP_<SIGNAL>_HEADERS`, else
/// `OTEL_EXPORTER_OTLP_HEADERS`, into a tonic `MetadataMap`, preserving both
/// ASCII and `*-bin` binary metadata entries.
#[cfg(feature = "otlp-grpc")]
fn signal_grpc_metadata(env: &EnvLookup, upper: &str) -> tonic::metadata::MetadataMap {
    let mut headers = http::HeaderMap::new();
    let Some(raw) = env
        .trimmed(&format!("OTEL_EXPORTER_OTLP_{upper}_HEADERS"))
        .or_else(|| env.trimmed("OTEL_EXPORTER_OTLP_HEADERS"))
    else {
        return tonic::metadata::MetadataMap::new();
    };
    for (name, value) in crate::metrics::sink::parse_headers(&raw) {
        if let Some((k, v)) = parse_grpc_header(&name, &value) {
            headers.insert(k, v);
        }
    }
    tonic::metadata::MetadataMap::from_headers(headers)
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
    ($builder:expr, $export:expr, $env:expr, $upper:expr, $signal:expr) => {{
        let export: &SignalExport = $export;
        let env: &EnvLookup = $env;
        let upper: &str = $upper;
        let signal: &str = $signal;
        let tls: Option<TlsMaterial> = export.tls.load()?;
        let compression = signal_compression(env, upper);
        let corrections = header_corrections(&ambient_headers(upper), &lookup_headers(env, upper));
        match export.protocol {
            #[cfg(feature = "otlp-http")]
            Protocol::HttpProtobuf | Protocol::HttpJson => {
                use opentelemetry_otlp::{WithExportConfig as _, WithHttpConfig as _};
                crate::metrics::sink::validate_http_endpoint(signal, &export.endpoint)?;
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
                if corrections.is_empty() {
                    if let Some(tls) = &tls {
                        builder = builder.with_http_client(tls.blocking_client(export.timeout)?);
                    }
                } else {
                    let client = match &tls {
                        Some(tls) => tls.blocking_client(export.timeout)?,
                        None => crate::export::tls::blocking_client(None, None, export.timeout)?,
                    };
                    builder = builder.with_http_client(LookupHeaders::new(client, corrections));
                }
                Ok(builder.build()?)
            }
            #[cfg(feature = "otlp-grpc")]
            Protocol::Grpc => {
                use opentelemetry_otlp::{WithExportConfig as _, WithTonicConfig as _};
                let _ = signal;
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
                if !corrections.is_empty() {
                    builder = builder.with_interceptor(LookupMetadata::new(corrections));
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
            other => {
                let _ = signal;
                Err(format!(
                    "OTLP protocol {other} needs the libo11y feature {}",
                    other.feature()
                )
                .into())
            }
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
        "TRACES",
        "traces"
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
        "LOGS",
        "logs"
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

    #[test]
    fn no_ambient_headers_need_no_correction() {
        let resolved = pairs(&[("authorization", "Bearer explicit")]);
        assert!(header_corrections(&[], &resolved).is_empty());
        assert!(header_corrections(&[String::new()], &resolved).is_empty());
        assert!(header_corrections(&[" , =x".to_owned()], &resolved).is_empty());
    }

    #[test]
    fn an_ambient_header_takes_the_lookups_value_or_is_removed() {
        let resolved = pairs(&[
            ("Authorization", "Bearer stale"),
            ("authorization", "Bearer explicit"),
            ("x-explicit", "1"),
        ]);
        assert_eq!(
            header_corrections(
                &[
                    "AUTHORIZATION=Bearer%20ambient, x-ambient=1,authorization=again".to_owned(),
                    "x-general=2".to_owned(),
                ],
                &resolved
            ),
            vec![
                (
                    "authorization".to_owned(),
                    Some("Bearer explicit".to_owned())
                ),
                ("x-ambient".to_owned(), None),
                ("x-general".to_owned(), None),
            ]
        );
        assert_eq!(
            header_corrections(&["authorization=Bearer%20ambient".to_owned()], &[]),
            vec![("authorization".to_owned(), None)]
        );
    }

    #[cfg(feature = "otlp-grpc")]
    #[test]
    fn the_interceptor_restores_the_lookups_metadata() {
        use tonic::service::Interceptor as _;

        let mut interceptor = LookupMetadata::new(vec![
            (
                "authorization".to_owned(),
                Some("Bearer explicit".to_owned()),
            ),
            ("x-ambient".to_owned(), None),
            ("x-bad-value".to_owned(), Some("line\nbreak".to_owned())),
            ("x-token-bin".to_owned(), Some("ZXhwbGljaXQ=".to_owned())),
            ("x-ambient-bin".to_owned(), None),
            ("x-bad-bin".to_owned(), Some("not!valid!base64".to_owned())),
        ]);
        let mut request = tonic::Request::new(());
        for (key, value) in [
            ("authorization", "Bearer ambient"),
            ("x-ambient", "1"),
            ("x-bad-value", "ambient"),
            ("x-kept", "yes"),
        ] {
            request
                .metadata_mut()
                .append(key, value.parse().expect("metadata value"));
        }
        request.metadata_mut().append_bin(
            "x-token-bin",
            tonic::metadata::MetadataValue::from_bytes(b"ambient"),
        );
        request.metadata_mut().append_bin(
            "x-ambient-bin",
            tonic::metadata::MetadataValue::from_bytes(b"secret"),
        );
        request.metadata_mut().append_bin(
            "x-bad-bin",
            tonic::metadata::MetadataValue::from_bytes(b"ambient-bad"),
        );
        let request = interceptor.call(request).expect("intercepted");
        let metadata = request.metadata();
        let get = |key: &str| metadata.get(key).and_then(|value| value.to_str().ok());
        assert_eq!(get("authorization"), Some("Bearer explicit"));
        assert_eq!(get("x-ambient"), None);
        assert_eq!(get("x-bad-value"), None, "an ambient value survived");
        assert_eq!(get("x-kept"), Some("yes"));
        assert_eq!(
            metadata
                .get_bin("x-token-bin")
                .and_then(|value| value.to_bytes().ok())
                .as_deref(),
            Some(&b"explicit"[..])
        );
        assert_eq!(
            metadata.get_bin("x-ambient-bin"),
            None,
            "an ambient binary credential survived"
        );
        assert_eq!(
            metadata.get_bin("x-bad-bin"),
            None,
            "invalid base64 must remove the ambient binary value instead of sending malformed metadata"
        );
    }

    #[cfg(feature = "otlp-http")]
    #[test]
    fn http_exporters_reject_malformed_endpoints_without_leaking_credentials() {
        for bad in [
            "not-a-url",
            "://missing-scheme",
            "ftp://user:secret@collector:4318/v1/traces?api_key=tok",
            "http://",
        ] {
            let export = SignalExport {
                route: crate::export::Route::Otlp,
                protocol: Protocol::HttpProtobuf,
                endpoint: bad.to_owned(),
                timeout: std::time::Duration::from_secs(5),
                tls: crate::export::tls::TlsFiles::default(),
            };
            let span_err =
                span_exporter(&export, &EnvLookup::empty()).expect_err("malformed span endpoint");
            let span_msg = span_err.to_string();
            assert!(
                span_msg.contains("invalid OTLP/HTTP traces endpoint"),
                "for {bad}: {span_msg}"
            );
            assert!(
                !span_msg.contains("secret"),
                "credential leaked: {span_msg}"
            );
            assert!(!span_msg.contains("tok"), "query token leaked: {span_msg}");

            let log_err =
                log_exporter(&export, &EnvLookup::empty()).expect_err("malformed log endpoint");
            let log_msg = log_err.to_string();
            assert!(
                log_msg.contains("invalid OTLP/HTTP logs endpoint"),
                "for {bad}: {log_msg}"
            );
            assert!(!log_msg.contains("secret"), "credential leaked: {log_msg}");
            assert!(!log_msg.contains("tok"), "query token leaked: {log_msg}");
        }
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

    #[cfg(feature = "otlp-http")]
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
