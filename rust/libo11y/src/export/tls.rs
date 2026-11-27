//! The TLS material the certificate variables name, which upstream's
//! exporters do not read: `OTEL_EXPORTER_OTLP_[SIGNAL_]CERTIFICATE` (the
//! trusted roots, which replace the built-in ones, as Go's exporters use
//! them), `OTEL_EXPORTER_OTLP_[SIGNAL_]CLIENT_CERTIFICATE` and
//! `OTEL_EXPORTER_OTLP_[SIGNAL_]CLIENT_KEY` (a client identity for mutual
//! TLS, both or neither).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::env::EnvLookup;

/// The PEM files one signal's OTLP exporter uses, each read from its
/// signal's variable, else the general one. Two are equal when they name
/// the same files.
#[derive(Debug, Clone, Default)]
pub(crate) struct TlsFiles {
    pub(crate) certificate: Option<PathBuf>,
    pub(crate) client_certificate: Option<PathBuf>,
    pub(crate) client_key: Option<PathBuf>,
    /// The variables the paths came from, for messages.
    vars: TlsVars,
}

impl PartialEq for TlsFiles {
    fn eq(&self, other: &Self) -> bool {
        self.certificate == other.certificate
            && self.client_certificate == other.client_certificate
            && self.client_key == other.client_key
    }
}

impl Eq for TlsFiles {}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct TlsVars {
    certificate: String,
    client_certificate: String,
    client_key: String,
}

/// Why the TLS material could not be used.
#[derive(Debug, thiserror::Error)]
pub(crate) enum TlsError {
    /// A file a variable names cannot be read.
    #[error("reading {var} {}: {source}", libo11y_spec::go_quote(&path.display().to_string()))]
    Read {
        var: String,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    /// Only one half of the client identity is set.
    #[error("{present} is set without {missing}")]
    HalfIdentity { present: String, missing: String },
    /// A file holds no usable PEM material.
    #[cfg_attr(
        not(feature = "otlp-http"),
        allow(dead_code, reason = "only the HTTP client parses PEM")
    )]
    #[error("{var}: {detail}")]
    Invalid { var: String, detail: String },
}

/// The PEM bytes of the files, read.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct TlsMaterial {
    /// The trusted roots, replacing the built-in ones.
    pub(crate) certificate: Option<Vec<u8>>,
    /// The client certificate and its key.
    pub(crate) identity: Option<(Vec<u8>, Vec<u8>)>,
    vars: TlsVars,
}

impl std::fmt::Debug for TlsMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The key never reaches a debug print.
        f.debug_struct("TlsMaterial")
            .field("certificate", &self.certificate.as_ref().map(Vec::len))
            .field("identity", &self.identity.is_some())
            .finish_non_exhaustive()
    }
}

impl TlsFiles {
    /// Reads the variables of the signal `upper` (`TRACES`, `METRICS` or
    /// `LOGS`). A blank variable is unset. The roots come from the signal's
    /// variable, else the general one. The client identity is a pair read
    /// at one level, as Go reads it, so a signal's certificate never meets
    /// the general key: the signal's pair when either half is set there,
    /// else the general pair.
    pub(crate) fn from_env(env: &EnvLookup, upper: &str) -> Self {
        let signal_prefix = format!("OTEL_EXPORTER_OTLP_{upper}_");
        let signal = |suffix: &str| format!("{signal_prefix}{suffix}");
        let general = |suffix: &str| format!("OTEL_EXPORTER_OTLP_{suffix}");
        let read = |var: String| env.trimmed(&var).map(|v| (var, PathBuf::from(v)));
        let mut vars = TlsVars::default();
        let certificate = read(signal("CERTIFICATE"))
            .or_else(|| read(general("CERTIFICATE")))
            .map(|(var, path)| {
                vars.certificate = var;
                path
            });
        let signal_level =
            read(signal("CLIENT_CERTIFICATE")).is_some() || read(signal("CLIENT_KEY")).is_some();
        let level = |suffix: &str| {
            if signal_level {
                signal(suffix)
            } else {
                general(suffix)
            }
        };
        vars.client_certificate = level("CLIENT_CERTIFICATE");
        vars.client_key = level("CLIENT_KEY");
        let client_certificate = read(level("CLIENT_CERTIFICATE")).map(|(_, path)| path);
        let client_key = read(level("CLIENT_KEY")).map(|(_, path)| path);
        Self {
            certificate,
            client_certificate,
            client_key,
            vars,
        }
    }

    /// Reads the files. `None` when no variable is set, so the exporter
    /// keeps its own defaults.
    pub(crate) fn load(&self) -> Result<Option<TlsMaterial>, TlsError> {
        if self.certificate.is_none()
            && self.client_certificate.is_none()
            && self.client_key.is_none()
        {
            return Ok(None);
        }
        let certificate = self
            .certificate
            .as_deref()
            .map(|path| read(&self.vars.certificate, path))
            .transpose()?;
        let identity = match (&self.client_certificate, &self.client_key) {
            (None, None) => None,
            (Some(cert), Some(key)) => Some((
                read(&self.vars.client_certificate, cert)?,
                read(&self.vars.client_key, key)?,
            )),
            (Some(_), None) => {
                return Err(TlsError::HalfIdentity {
                    present: self.vars.client_certificate.clone(),
                    missing: self.vars.client_certificate.replace("CERTIFICATE", "KEY"),
                });
            }
            (None, Some(_)) => {
                return Err(TlsError::HalfIdentity {
                    present: self.vars.client_key.clone(),
                    missing: self.vars.client_key.replace("KEY", "CERTIFICATE"),
                });
            }
        };
        Ok(Some(TlsMaterial {
            certificate,
            identity,
            vars: self.vars.clone(),
        }))
    }
}

fn read(var: &str, path: &Path) -> Result<Vec<u8>, TlsError> {
    fs::read(path).map_err(|source| TlsError::Read {
        var: var.to_owned(),
        path: path.to_owned(),
        source,
    })
}

#[cfg(feature = "otlp-http")]
impl TlsMaterial {
    /// A blocking reqwest client that trusts only the configured roots, if
    /// any, presents the client identity, if any, and times requests out
    /// after `timeout`. reqwest cannot build a blocking client on a thread
    /// that runs an async runtime, so it is built on a helper thread, as
    /// upstream builds its own.
    pub(crate) fn blocking_client(
        &self,
        timeout: std::time::Duration,
    ) -> Result<reqwest::blocking::Client, crate::BoxError> {
        let roots = self
            .certificate
            .as_deref()
            .map(|pem| {
                reqwest::Certificate::from_pem_bundle(pem).map_err(|e| TlsError::Invalid {
                    var: self.vars.certificate.clone(),
                    detail: e.to_string(),
                })
            })
            .transpose()?;
        let identity = self
            .identity
            .as_ref()
            .map(|(cert, key)| {
                let mut pem = cert.clone();
                pem.push(b'\n');
                pem.extend_from_slice(key);
                reqwest::Identity::from_pem(&pem).map_err(|e| TlsError::Invalid {
                    var: self.vars.client_certificate.clone(),
                    detail: e.to_string(),
                })
            })
            .transpose()?;
        let built = std::thread::Builder::new()
            .name("libo11y-http-client".to_owned())
            .spawn(move || {
                let mut builder = reqwest::blocking::Client::builder().timeout(timeout);
                if let Some(roots) = roots {
                    builder = builder.tls_certs_only(roots);
                }
                if let Some(identity) = identity {
                    builder = builder.identity(identity);
                }
                builder.build()
            })?
            .join()
            .map_err(|_| "the thread building the HTTP client panicked")?;
        Ok(built?)
    }
}

#[cfg(feature = "otlp-grpc")]
impl TlsMaterial {
    /// The tonic TLS configuration: the configured roots, else the bundled
    /// `WebPKI` roots, and the client identity, if any.
    pub(crate) fn tonic_config(material: Option<&Self>) -> tonic::transport::ClientTlsConfig {
        use tonic::transport::{Certificate, ClientTlsConfig, Identity};

        let config = ClientTlsConfig::new();
        let Some(material) = material else {
            return config.with_webpki_roots();
        };
        let config = match &material.certificate {
            Some(pem) => config.ca_certificate(Certificate::from_pem(pem)),
            None => config.with_webpki_roots(),
        };
        match &material.identity {
            Some((cert, key)) => config.identity(Identity::from_pem(cert, key)),
            None => config,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A directory under the system temporary directory, removed on drop.
    pub(crate) struct TempDir(pub(crate) PathBuf);

    impl TempDir {
        pub(crate) fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "libo11y-{name}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        pub(crate) fn write(&self, name: &str, contents: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, contents).expect("write fixture");
            path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A self-signed CA and a client certificate it issued, as PEM.
    pub(crate) struct Pki {
        pub(crate) ca: String,
        pub(crate) client_cert: String,
        pub(crate) client_key: String,
    }

    pub(crate) fn pki() -> Pki {
        let ca_key = rcgen::KeyPair::generate().expect("ca key");
        let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("params");
        ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        let ca = ca_params.self_signed(&ca_key).expect("ca");
        let issuer = rcgen::Issuer::new(ca_params, ca_key);
        let client_key = rcgen::KeyPair::generate().expect("client key");
        let client = rcgen::CertificateParams::new(vec!["client.test".to_owned()])
            .expect("params")
            .signed_by(&client_key, &issuer)
            .expect("client");
        Pki {
            ca: ca.pem(),
            client_cert: client.pem(),
            client_key: client_key.serialize_pem(),
        }
    }

    fn env(vars: &[(&str, &str)]) -> EnvLookup {
        EnvLookup::from_pairs(vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())))
    }

    #[test]
    fn no_variable_is_no_material() {
        let files = TlsFiles::from_env(&env(&[]), "TRACES");
        assert_eq!(files.load().expect("nothing to read"), None);
    }

    #[test]
    fn the_files_are_read_from_the_signal_variable_first() {
        let dir = TempDir::new("tls-read");
        let pki = pki();
        let ca = dir.write("ca.pem", pki.ca.as_bytes());
        let other = dir.write("other.pem", b"unused");
        let cert = dir.write("client.pem", pki.client_cert.as_bytes());
        let key = dir.write("client.key", pki.client_key.as_bytes());
        let files = TlsFiles::from_env(
            &env(&[
                (
                    "OTEL_EXPORTER_OTLP_CERTIFICATE",
                    other.to_str().expect("utf-8"),
                ),
                (
                    "OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE",
                    ca.to_str().expect("utf-8"),
                ),
                (
                    "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
                    cert.to_str().expect("utf-8"),
                ),
                (
                    "OTEL_EXPORTER_OTLP_CLIENT_KEY",
                    key.to_str().expect("utf-8"),
                ),
            ]),
            "LOGS",
        );
        let material = files.load().expect("readable").expect("configured");
        assert_eq!(material.certificate.as_deref(), Some(pki.ca.as_bytes()));
        let (c, k) = material.identity.expect("both halves");
        assert_eq!(c, pki.client_cert.as_bytes());
        assert_eq!(k, pki.client_key.as_bytes());
    }

    #[test]
    fn a_missing_file_names_the_variable_and_the_path() {
        let files = TlsFiles::from_env(
            &env(&[("OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE", "/no/such/ca.pem")]),
            "TRACES",
        );
        let err = files.load().expect_err("missing");
        let msg = err.to_string();
        assert!(
            msg.starts_with("reading OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE \"/no/such/ca.pem\": "),
            "{msg}"
        );
    }

    #[test]
    fn half_an_identity_is_an_error() {
        let dir = TempDir::new("tls-half");
        let key = dir.write("client.key", b"key");
        let files = TlsFiles::from_env(
            &env(&[(
                "OTEL_EXPORTER_OTLP_CLIENT_KEY",
                key.to_str().expect("utf-8"),
            )]),
            "METRICS",
        );
        assert_eq!(
            files.load().expect_err("half").to_string(),
            "OTEL_EXPORTER_OTLP_CLIENT_KEY is set without OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE"
        );
        let cert = dir.write("client.pem", b"cert");
        let files = TlsFiles::from_env(
            &env(&[(
                "OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE",
                cert.to_str().expect("utf-8"),
            )]),
            "METRICS",
        );
        assert_eq!(
            files.load().expect_err("half").to_string(),
            "OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE is set without OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY"
        );
    }

    #[test]
    fn a_signal_certificate_never_pairs_with_the_general_key() {
        let dir = TempDir::new("tls-pair");
        let cert = dir.write("client.pem", b"cert");
        let key = dir.write("client.key", b"key");
        let files = TlsFiles::from_env(
            &env(&[
                (
                    "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE",
                    cert.to_str().expect("utf-8"),
                ),
                (
                    "OTEL_EXPORTER_OTLP_CLIENT_KEY",
                    key.to_str().expect("utf-8"),
                ),
            ]),
            "TRACES",
        );
        assert_eq!(
            files.load().expect_err("half a signal pair").to_string(),
            "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE is set without OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY"
        );
    }

    #[test]
    fn the_key_stays_out_of_debug_output() {
        let material = TlsMaterial {
            certificate: None,
            identity: Some((b"cert".to_vec(), b"SECRET-KEY".to_vec())),
            vars: TlsVars::default(),
        };
        assert!(!format!("{material:?}").contains("SECRET"));
    }

    #[cfg(feature = "otlp-http")]
    #[test]
    fn the_http_client_takes_the_roots_and_the_identity() {
        let pki = pki();
        let material = TlsMaterial {
            certificate: Some(pki.ca.into_bytes()),
            identity: Some((pki.client_cert.into_bytes(), pki.client_key.into_bytes())),
            vars: TlsVars::default(),
        };
        material
            .blocking_client(std::time::Duration::from_secs(1))
            .expect("a client");
    }

    #[cfg(feature = "otlp-http")]
    #[test]
    fn a_file_without_pem_is_refused_by_the_http_client() {
        let material = TlsMaterial {
            certificate: None,
            identity: Some((b"not pem".to_vec(), b"not pem".to_vec())),
            vars: TlsVars {
                client_certificate: "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE".to_owned(),
                ..TlsVars::default()
            },
        };
        let err = material
            .blocking_client(std::time::Duration::from_secs(1))
            .expect_err("no PEM");
        assert!(
            err.to_string()
                .starts_with("OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: "),
            "{err}"
        );
    }
}
