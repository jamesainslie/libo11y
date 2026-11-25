//! The compiled binary's identity: its version and the version control
//! stamp, recorded at compile time in the application's crate.

use opentelemetry::KeyValue;

use libo11y_spec::attr;

/// The key the build version lands under.
const SERVICE_VERSION: &str = "service.version";

/// The identity of the compiled application: its version and the version
/// control stamp the build recorded.
///
/// [`build_info!`](crate::build_info) fills it in the application's crate
/// at compile time. On the resource, the version becomes `service.version`
/// (below the builder and the environment), the revision
/// `vcs.ref.head.revision`, the commit time `o11y.build.time`, and the dirty
/// flag `o11y.build.modified`, as the Go library maps Go's build info.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BuildInfo {
    version: Option<String>,
    revision: Option<String>,
    time: Option<String>,
    modified: Option<bool>,
}

impl BuildInfo {
    /// Build info with only a version.
    #[must_use]
    pub fn new(version: impl Into<String>) -> Self {
        Self {
            version: Some(version.into()),
            ..Self::default()
        }
    }

    /// Build info from the compile-time values [`build_info!`](crate::build_info)
    /// reads: the package version and the vergen-standard `VERGEN_GIT_SHA`,
    /// `VERGEN_GIT_COMMIT_TIMESTAMP` and `VERGEN_GIT_DIRTY` (`true` or
    /// `false`). Empty values are skipped.
    #[must_use]
    pub fn from_build_values(
        version: &str,
        revision: Option<&str>,
        time: Option<&str>,
        dirty: Option<&str>,
    ) -> Self {
        let present = |value: Option<&str>| value.filter(|v| !v.is_empty()).map(str::to_owned);
        Self {
            version: present(Some(version)),
            revision: present(revision),
            time: present(time),
            modified: dirty.filter(|v| !v.is_empty()).map(|v| v == "true"),
        }
    }

    /// Sets the version control revision.
    #[must_use]
    pub fn with_revision(mut self, revision: impl Into<String>) -> Self {
        self.revision = Some(revision.into());
        self
    }

    /// Sets the commit time.
    #[must_use]
    pub fn with_time(mut self, time: impl Into<String>) -> Self {
        self.time = Some(time.into());
        self
    }

    /// Sets whether the working tree had uncommitted changes.
    #[must_use]
    pub fn with_modified(mut self, modified: bool) -> Self {
        self.modified = Some(modified);
        self
    }

    /// The version, when the build recorded one.
    #[must_use]
    pub fn version(&self) -> Option<&str> {
        self.version.as_deref()
    }

    /// The resource attributes the build info sets.
    pub(crate) fn attributes(&self) -> Vec<KeyValue> {
        let mut attrs = Vec::new();
        if let Some(version) = &self.version {
            attrs.push(KeyValue::new(SERVICE_VERSION, version.clone()));
        }
        if let Some(revision) = &self.revision {
            attrs.push(KeyValue::new(attr::VCS_REF_HEAD_REVISION, revision.clone()));
        }
        if let Some(time) = &self.time {
            attrs.push(KeyValue::new(attr::BUILD_TIME, time.clone()));
        }
        if let Some(modified) = self.modified {
            attrs.push(KeyValue::new(attr::BUILD_MODIFIED, modified));
        }
        attrs
    }
}

/// Records the calling crate's [`BuildInfo`] at compile time: its
/// `CARGO_PKG_VERSION` and, when the build script sets them (as
/// [vergen](https://docs.rs/vergen) does), `VERGEN_GIT_SHA`,
/// `VERGEN_GIT_COMMIT_TIMESTAMP` and `VERGEN_GIT_DIRTY`. These are read
/// when the application compiles, not from the runtime environment.
///
/// ```
/// let info = libo11y::build_info!();
/// assert_eq!(info.version(), Some(env!("CARGO_PKG_VERSION")));
/// ```
#[macro_export]
macro_rules! build_info {
    () => {
        $crate::BuildInfo::from_build_values(
            ::core::env!("CARGO_PKG_VERSION"),
            ::core::option_env!("VERGEN_GIT_SHA"),
            ::core::option_env!("VERGEN_GIT_COMMIT_TIMESTAMP"),
            ::core::option_env!("VERGEN_GIT_DIRTY"),
        )
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    // go/buildinfo_test.go TestBuildInfoAttrs.
    #[test]
    fn maps_build_values_to_spec_keys() {
        let info = BuildInfo::from_build_values(
            "1.2.3",
            Some("abc123"),
            Some("2026-11-01T10:00:00Z"),
            Some("true"),
        );
        assert_eq!(
            info.attributes(),
            vec![
                KeyValue::new("service.version", "1.2.3"),
                KeyValue::new("vcs.ref.head.revision", "abc123"),
                KeyValue::new("o11y.build.time", "2026-11-01T10:00:00Z"),
                KeyValue::new("o11y.build.modified", true),
            ]
        );
        let clean = BuildInfo::from_build_values("1.2.3", None, None, Some("false"));
        assert_eq!(
            clean.attributes(),
            vec![
                KeyValue::new("service.version", "1.2.3"),
                KeyValue::new("o11y.build.modified", false),
            ]
        );
    }

    // TestBuildInfoAttrsEmptyInfo: empty values are skipped.
    #[test]
    fn skips_empty_values() {
        let info = BuildInfo::from_build_values("", Some(""), Some(""), Some(""));
        assert!(info.attributes().is_empty());
        assert_eq!(info.version(), None);
    }

    #[test]
    fn builder_methods_set_each_value() {
        let info = BuildInfo::new("2.0.0")
            .with_revision("def")
            .with_time("t")
            .with_modified(false);
        assert_eq!(info.attributes().len(), 4);
        assert_eq!(info.version(), Some("2.0.0"));
    }

    #[test]
    fn the_macro_records_the_package_version() {
        assert_eq!(
            crate::build_info!().version(),
            Some(env!("CARGO_PKG_VERSION"))
        );
    }
}
