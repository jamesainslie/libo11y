//! The SDK builder: every option libo11y takes, resolved into the resource,
//! the sensitivity policy and the propagator.

use std::collections::BTreeSet;
use std::fmt;
use std::path::PathBuf;

use opentelemetry::KeyValue;
use opentelemetry_sdk::Resource;

use crate::appregistry::merge_classes;
use crate::detect::Detected;
use crate::propagation::{BoxedPropagator, Propagator};
use crate::resource::build_resource;
use crate::{
    AppRegistry, BuildInfo, EnvLookup, Error, MIN_PII_HASH_KEY_LEN, PiiMode, Policy, Violations,
};

/// A configured libo11y SDK.
///
/// It holds the telemetry resource every signal carries, the sensitivity
/// policy every signal applies, and the propagator for every carrier.
#[derive(Debug, Clone)]
pub struct Sdk {
    resource: Resource,
    resource_violations: Violations,
    version_fallback: bool,
    policy: Policy,
    propagator: Propagator,
}

impl Sdk {
    /// Starts building an SDK.
    pub fn builder() -> Builder {
        Builder::default()
    }

    /// The telemetry resource, stamped with the libo11y schema URL.
    #[must_use]
    pub fn resource(&self) -> &Resource {
        &self.resource
    }

    /// How many resource attributes the policy dropped or tokenized, and the
    /// identity rules broken under [`Builder::without_strict_identity`], per
    /// rule. These count on the resource signal of `o11y.schema.violations`.
    #[must_use]
    pub fn resource_violations(&self) -> &Violations {
        &self.resource_violations
    }

    /// Whether `service.version` fell back to `0.0.0-unknown` because no
    /// version resolved.
    #[must_use]
    pub fn service_version_fallback(&self) -> bool {
        self.version_fallback
    }

    /// The sensitivity policy.
    #[must_use]
    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    /// The propagator, wrapped by the baggage egress filter.
    #[must_use]
    pub fn propagator(&self) -> &Propagator {
        &self.propagator
    }
}

/// Where an application registry comes from.
#[derive(Debug, Clone)]
enum RegistrySource {
    Loaded(AppRegistry),
    File(PathBuf),
}

/// Everything the builder was told.
#[derive(Default)]
pub(crate) struct Settings {
    pub(crate) service_name: Option<String>,
    pub(crate) service_version: Option<String>,
    pub(crate) service_namespace: Option<String>,
    pub(crate) environment: Option<String>,
    pub(crate) extra_environments: BTreeSet<String>,
    pub(crate) lax_identity: bool,
    pub(crate) resource_attributes: Vec<KeyValue>,
    pub(crate) build_info: Option<BuildInfo>,
    pub(crate) ignore_env: bool,
    env: Option<EnvLookup>,
    pii_mode: PiiMode,
    pii_hash_key: Vec<u8>,
    registries: Vec<RegistrySource>,
    propagators: Vec<BoxedPropagator>,
    detected: Option<Detected>,
}

impl fmt::Debug for Settings {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Settings")
            .field("service_name", &self.service_name)
            .field("environment", &self.environment)
            .field("ignore_env", &self.ignore_env)
            .field("pii_mode", &self.pii_mode)
            .field("propagators", &self.propagators.len())
            .finish_non_exhaustive()
    }
}

/// Builds an [`Sdk`]. Options override the standard `OTEL_*` environment
/// variables, which override libo11y's defaults; [`Builder::without_otel_env`]
/// removes the environment layer.
#[derive(Debug, Default)]
#[must_use = "a builder does nothing until it builds"]
pub struct Builder {
    settings: Settings,
}

impl Builder {
    /// Sets `service.name`. A service name is required: when neither this
    /// nor `OTEL_SERVICE_NAME` (nor `service.name` in
    /// `OTEL_RESOURCE_ATTRIBUTES`) provides a usable one, building fails with
    /// [`Error::NoServiceName`]. Surrounding white space is trimmed, and a
    /// blank name is no name.
    pub fn service_name(mut self, name: impl Into<String>) -> Self {
        self.settings.service_name = Some(name.into());
        self
    }

    /// Sets `service.version`. Without it the version comes from
    /// `OTEL_RESOURCE_ATTRIBUTES`, then from [`Builder::build_info`], then
    /// falls back to `0.0.0-unknown`.
    pub fn service_version(mut self, version: impl Into<String>) -> Self {
        self.settings.service_version = Some(version.into());
        self
    }

    /// Sets `service.namespace`, the grouping key that tells services of
    /// different teams or domains apart.
    pub fn service_namespace(mut self, namespace: impl Into<String>) -> Self {
        self.settings.service_namespace = Some(namespace.into());
        self
    }

    /// Sets `deployment.environment.name`, such as
    /// [`Environment::Production`](libo11y_spec::Environment::Production) or
    /// a value added with [`Builder::environment_values`]. An environment is
    /// required: without this or `deployment.environment.name` in
    /// `OTEL_RESOURCE_ATTRIBUTES`, building fails with
    /// [`Error::NoEnvironment`], and with [`Error::InvalidEnvironment`] when
    /// the value is outside the allowed set.
    pub fn environment(mut self, environment: impl fmt::Display) -> Self {
        self.settings.environment = Some(environment.to_string());
        self
    }

    /// Adds environments to the allowed set beyond the specification's
    /// `production`, `staging`, `development` and `test`, for organizations
    /// that run others, such as `qa` or `perf`.
    pub fn environment_values<I>(mut self, values: I) -> Self
    where
        I: IntoIterator,
        I::Item: fmt::Display,
    {
        self.settings
            .extra_environments
            .extend(values.into_iter().map(|v| v.to_string()));
        self
    }

    /// Downgrades the identity requirements (a service name and a valid
    /// deployment environment) from build errors to violations counted on
    /// the resource signal. For migrations and tests.
    pub fn without_strict_identity(mut self) -> Self {
        self.settings.lax_identity = true;
        self
    }

    /// Adds resource attributes. They are applied after the identity options,
    /// so a duplicate key here wins, and they are classified like every
    /// other attribute.
    pub fn resource_attributes(mut self, attributes: impl IntoIterator<Item = KeyValue>) -> Self {
        self.settings.resource_attributes.extend(attributes);
        self
    }

    /// Records the application's build: see [`build_info!`](crate::build_info).
    pub fn build_info(mut self, info: BuildInfo) -> Self {
        self.settings.build_info = Some(info);
        self
    }

    /// Selects how attributes classified as PII are handled. The default is
    /// [`PiiMode::Drop`]; [`PiiMode::Hash`] needs [`Builder::pii_hash_key`].
    pub fn pii_mode(mut self, mode: PiiMode) -> Self {
        self.settings.pii_mode = mode;
        self
    }

    /// Sets the secret key for [`PiiMode::Hash`] tokens, at least
    /// [`MIN_PII_HASH_KEY_LEN`] bytes. The key is copied.
    pub fn pii_hash_key(mut self, key: impl AsRef<[u8]>) -> Self {
        self.settings.pii_hash_key = key.as_ref().to_vec();
        self
    }

    /// Adds an application registry, whose keys the policy then classifies
    /// like specification keys. May be given more than once for registries
    /// with different namespaces.
    pub fn app_registry(mut self, registry: AppRegistry) -> Self {
        self.settings
            .registries
            .push(RegistrySource::Loaded(registry));
        self
    }

    /// Adds the application registry file at `path`, read when the SDK is
    /// built.
    pub fn app_registry_file(mut self, path: impl Into<PathBuf>) -> Self {
        self.settings
            .registries
            .push(RegistrySource::File(path.into()));
        self
    }

    /// Replaces the default propagator, a composite of W3C Trace Context and
    /// W3C Baggage. No propagators restore the default, one is used as it
    /// is, several form a composite in order. The baggage egress filter
    /// wraps the result either way.
    pub fn propagators(mut self, propagators: impl IntoIterator<Item = BoxedPropagator>) -> Self {
        self.settings.propagators = propagators.into_iter().collect();
        self
    }

    /// Reads no `OTEL_*` variable anywhere: hermetic mode, for tests and for
    /// processes that must not depend on their environment.
    pub fn without_otel_env(mut self) -> Self {
        self.settings.ignore_env = true;
        self
    }

    /// Reads `OTEL_*` variables from `env` instead of the process
    /// environment. [`Builder::without_otel_env`] still wins.
    pub fn env_lookup(mut self, env: EnvLookup) -> Self {
        self.settings.env = Some(env);
        self
    }

    /// Replaces the detected resource layers, for tests.
    #[cfg(test)]
    pub(crate) fn detected(mut self, detected: Detected) -> Self {
        self.settings.detected = Some(detected);
        self
    }

    /// Resolves the options into an SDK: checks the PII key, loads the
    /// application registries, builds the policy, the resource and the
    /// propagator, in the Go library's order.
    ///
    /// # Errors
    ///
    /// [`Error::PiiHashKey`] for a short hash key; the registry errors of
    /// [`AppRegistry::from_path`] and [`Error::DuplicateAppNamespace`]; and,
    /// under strict identity, [`Error::NoServiceName`],
    /// [`Error::NoEnvironment`] and [`Error::InvalidEnvironment`].
    pub fn build(self) -> Result<Sdk, Error> {
        let mut settings = self.settings;
        if settings.pii_mode == PiiMode::Hash && settings.pii_hash_key.len() < MIN_PII_HASH_KEY_LEN
        {
            return Err(Error::PiiHashKey);
        }
        let registries = std::mem::take(&mut settings.registries)
            .into_iter()
            .map(|source| match source {
                RegistrySource::Loaded(registry) => Ok(registry),
                RegistrySource::File(path) => AppRegistry::from_path(path),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let classes = merge_classes(&registries)?;
        let policy = Policy::new(settings.pii_mode, &settings.pii_hash_key, classes)?;
        let env = if settings.ignore_env {
            EnvLookup::empty()
        } else {
            settings.env.clone().unwrap_or_default()
        };
        let detected = settings
            .detected
            .take()
            .unwrap_or_else(Detected::from_system);
        let resolved = build_resource(&settings, &policy, &env, &detected)?;
        let propagator = Propagator::new(std::mem::take(&mut settings.propagators), None);
        Ok(Sdk {
            resource: resolved.resource,
            resource_violations: resolved.violations,
            version_fallback: resolved.version_fallback,
            policy,
            propagator,
        })
    }
}
