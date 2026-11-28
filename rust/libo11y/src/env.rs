//! Where libo11y reads `OTEL_*` variables from.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

type LookupFn = dyn Fn(&str) -> Option<String> + Send + Sync;

/// A source of environment variables.
///
/// Every libo11y reader of an `OTEL_*` variable takes its value from one
/// `EnvLookup`. The default is the process environment. Hermetic mode
/// ([`Builder::without_otel_env`](crate::Builder::without_otel_env)) uses
/// [`EnvLookup::empty`], and a test can supply its own variables with
/// [`EnvLookup::from_pairs`] instead of changing the process environment.
///
/// One exception: upstream's OTLP trace and log exporters still fall back to
/// `OTEL_EXPORTER_OTLP_[SIGNAL_]COMPRESSION` in the process environment when
/// the lookup leaves compression unset (the setting carries no credentials).
/// libo11y resolves the exporter, protocol, endpoint, timeout, certificate
/// files, insecure flag, and headers through the lookup and makes the
/// lookup's headers authoritative over any ambient header variables. Hermetic
/// mode builds no OTLP exporter, so it reads none of them.
#[derive(Clone)]
pub struct EnvLookup(Arc<LookupFn>);

impl EnvLookup {
    /// Reads the process environment. A variable that is unset or not valid
    /// Unicode reads as absent.
    #[must_use]
    pub fn process() -> Self {
        Self::from_fn(|key| std::env::var(key).ok())
    }

    /// Reads nothing: every variable is absent.
    #[must_use]
    pub fn empty() -> Self {
        Self::from_fn(|_| None)
    }

    /// Reads variables through `lookup`.
    #[must_use]
    pub fn from_fn<F>(lookup: F) -> Self
    where
        F: Fn(&str) -> Option<String> + Send + Sync + 'static,
    {
        Self(Arc::new(lookup))
    }

    /// Reads variables from `pairs`. A later pair replaces an earlier one
    /// with the same name.
    #[must_use]
    pub fn from_pairs<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        let vars: HashMap<String, String> = pairs
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
        Self::from_fn(move |key| vars.get(key).cloned())
    }

    /// Returns the value of the variable `key`, or `None` when it is absent.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<String> {
        (self.0)(key)
    }

    /// Returns the value of `key` with surrounding white space removed, or
    /// `None` when it is absent or blank. Go reads an unset variable as the
    /// empty string, so absent and blank are the same to every Go reader.
    pub(crate) fn trimmed(&self, key: &str) -> Option<String> {
        self.get(key)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
    }
}

impl Default for EnvLookup {
    fn default() -> Self {
        Self::process()
    }
}

impl fmt::Debug for EnvLookup {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("EnvLookup(..)")
    }
}

/// The variable OpenTelemetry resource attributes are read from.
pub(crate) const RESOURCE_ATTRIBUTES: &str = "OTEL_RESOURCE_ATTRIBUTES";

/// The variable the service name is read from.
pub(crate) const SERVICE_NAME: &str = "OTEL_SERVICE_NAME";

/// The resource attributes the environment sets: `OTEL_RESOURCE_ATTRIBUTES`,
/// then `service.name` from `OTEL_SERVICE_NAME` on top, as OpenTelemetry Go's
/// `resource.WithFromEnv` reads them. Later pairs win over earlier ones.
pub(crate) fn resource_attributes(env: &EnvLookup) -> Vec<(String, String)> {
    let mut attrs = env
        .get(RESOURCE_ATTRIBUTES)
        .map(|raw| parse_resource_attributes(&raw))
        .unwrap_or_default();
    if let Some(name) = env.trimmed(SERVICE_NAME) {
        attrs.push(("service.name".to_owned(), name));
    }
    attrs
}

/// Parses an `OTEL_RESOURCE_ATTRIBUTES` value as OpenTelemetry Go's
/// `resource.WithFromEnv` does: the value is trimmed and split on commas,
/// each entry on its first `=`. An entry without `=` is skipped, as is one
/// whose trimmed key is empty. The key is trimmed and the trimmed value is
/// percent-decoded (`url.PathUnescape`). When decoding fails the raw,
/// untrimmed value is kept, as Go keeps it; a value that decodes to bytes
/// that are not UTF-8 is kept raw too, since a Rust string cannot hold them.
pub(crate) fn parse_resource_attributes(raw: &str) -> Vec<(String, String)> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    raw.split(',')
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            let value = path_unescape(value.trim()).unwrap_or_else(|| value.to_owned());
            Some((key.to_owned(), value))
        })
        .collect()
}

/// Go's `url.PathUnescape`: every `%` must start a two-digit hex escape,
/// and `+` stays as it is. Returns `None` when an escape is malformed or
/// the decoded bytes are not UTF-8.
fn path_unescape(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = hex_digit(*bytes.get(i + 1)?)?;
            let lo = hex_digit(*bytes.get(i + 2)?)?;
            out.push(hi << 4 | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_digit(b: u8) -> Option<u8> {
    char::from(b)
        .to_digit(16)
        .and_then(|d| u8::try_from(d).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect()
    }

    #[test]
    fn lookups_read_their_source() {
        let env = EnvLookup::from_pairs([("A", "1"), ("A", "2")]);
        assert_eq!(env.get("A").as_deref(), Some("2"));
        assert_eq!(env.get("B"), None);
        assert_eq!(EnvLookup::empty().get("PATH"), None);
        let blank = EnvLookup::from_pairs([("A", "  ")]);
        assert_eq!(blank.trimmed("A"), None);
    }

    #[test]
    fn parses_pairs_and_percent_decodes_values() {
        assert_eq!(
            parse_resource_attributes(" k8s.pod.name = web%2D1 ,team=a%20b+c"),
            pairs(&[("k8s.pod.name", "web-1"), ("team", "a b+c")])
        );
    }

    #[test]
    fn skips_entries_without_a_value_and_empty_keys() {
        assert_eq!(
            parse_resource_attributes("a=1,broken,=x, b = 2 ,"),
            pairs(&[("a", "1"), ("b", "2")])
        );
    }

    #[test]
    fn keeps_the_raw_value_when_decoding_fails() {
        assert_eq!(
            parse_resource_attributes("a= 100% ,b=%zz"),
            pairs(&[("a", " 100% "), ("b", "%zz")])
        );
    }

    #[test]
    fn splits_on_the_first_equals_sign() {
        assert_eq!(parse_resource_attributes("a=b=c"), pairs(&[("a", "b=c")]));
    }

    #[test]
    fn blank_value_is_no_attributes() {
        assert!(parse_resource_attributes("   ").is_empty());
    }

    #[test]
    fn service_name_variable_wins_over_resource_attributes() {
        let env = EnvLookup::from_pairs([
            (RESOURCE_ATTRIBUTES, "service.name=from-attrs,a=1"),
            (SERVICE_NAME, " from-var "),
        ]);
        assert_eq!(
            resource_attributes(&env),
            pairs(&[
                ("service.name", "from-attrs"),
                ("a", "1"),
                ("service.name", "from-var")
            ])
        );
    }
}
