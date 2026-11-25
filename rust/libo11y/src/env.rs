//! Where libo11y reads `OTEL_*` variables from.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

type LookupFn = dyn Fn(&str) -> Option<String> + Send + Sync;

/// A source of environment variables.
///
/// Every libo11y reader of an `OTEL_*` variable takes its value from one
/// `EnvLookup`. The default is the process environment. Hermetic mode
/// (`Builder::without_otel_env`) uses
/// [`EnvLookup::empty`], and a test can supply its own variables with
/// [`EnvLookup::from_pairs`] instead of changing the process environment.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookups_read_their_source() {
        let env = EnvLookup::from_pairs([("A", "1"), ("A", "2")]);
        assert_eq!(env.get("A").as_deref(), Some("2"));
        assert_eq!(env.get("B"), None);
        assert_eq!(EnvLookup::empty().get("PATH"), None);
    }
}
