//! The telemetry resource: the detected and environment layers under the
//! builder's attributes, the tier-0 identity contract, the version fallback,
//! `service.instance.id`, the sensitivity policy, and one schema URL.

use std::collections::BTreeMap;

use opentelemetry::{KeyValue, Value};
use opentelemetry_sdk::Resource;

use libo11y_spec::{ENVIRONMENT_VALUES, Environment, SCHEMA_URL, attr};

use crate::builder::Settings;
use crate::detect::Detected;
use crate::env::{self, EnvLookup};
use crate::{Error, Policy, Rule, Violations};

/// The version recorded, and flagged, when none resolves.
pub(crate) const SERVICE_VERSION_FALLBACK: &str = "0.0.0-unknown";

/// The semconv-sanctioned version 5 UUID namespace for `service.instance.id`.
const INSTANCE_ID_NAMESPACE: uuid::Uuid = uuid::uuid!("4d63009a-8d0f-11ee-aad7-4c796ed8e320");

const SERVICE_NAME: &str = "service.name";
const SERVICE_VERSION: &str = "service.version";
const SERVICE_NAMESPACE: &str = "service.namespace";
const SERVICE_INSTANCE_ID: &str = "service.instance.id";

/// The resource and what building it found.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedResource {
    pub(crate) resource: Resource,
    /// Resource violations per rule, for the violation counter.
    pub(crate) violations: Violations,
    /// Whether `service.version` fell back to `0.0.0-unknown`.
    pub(crate) version_fallback: bool,
}

/// Builds the resource from `settings`, reading the environment through
/// `env` (which is empty under hermetic mode).
///
/// The layers, lowest precedence first, are the build info, the telemetry
/// SDK, `host.name`, the process runtime and `container.id`, then the
/// environment (`OTEL_RESOURCE_ATTRIBUTES` with `OTEL_SERVICE_NAME` on
/// top), then the builder: the non-blank identity options, then the
/// resource attributes. Then the identity contract applies, the version
/// falls back, `service.instance.id` is derived, the policy classifies
/// every attribute, and one schema URL is stamped on an empty builder, so
/// no upstream detector adds keys back.
pub(crate) fn build_resource(
    settings: &Settings,
    policy: &Policy,
    env: &EnvLookup,
    detected: &Detected,
) -> Result<ResolvedResource, Error> {
    let mut layers = Layers::default();
    if let Some(info) = &settings.build_info {
        layers.extend(info.attributes());
    }
    layers.extend(detected.attributes());
    layers.extend(
        env::resource_attributes(env)
            .into_iter()
            .map(|(key, value)| KeyValue::new(key, value)),
    );
    let trimmed = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let version_option = trimmed(&settings.service_version);
    for (key, value) in [
        (SERVICE_NAME, trimmed(&settings.service_name)),
        (SERVICE_VERSION, version_option.clone()),
        (SERVICE_NAMESPACE, trimmed(&settings.service_namespace)),
        (Environment::KEY, trimmed(&settings.environment)),
    ] {
        if let Some(value) = value {
            layers.set(KeyValue::new(key, value));
        }
    }
    layers.extend(settings.resource_attributes.iter().cloned());

    let mut violations = Violations::default();
    for rule in enforce_identity(&layers, settings)? {
        violations.add(rule);
    }
    let version_fallback = version_option.is_none() && layers.string(SERVICE_VERSION).is_empty();
    if version_fallback {
        layers.set(KeyValue::new(SERVICE_VERSION, SERVICE_VERSION_FALLBACK));
    }
    if layers.string(SERVICE_INSTANCE_ID).is_empty() {
        let id = instance_id_for(
            layers.string(attr::K8S_POD_UID),
            layers.string(attr::K8S_POD_NAME),
            layers.string(attr::K8S_NAMESPACE_NAME),
        );
        layers.set(KeyValue::new(SERVICE_INSTANCE_ID, id));
    }

    let (kept, counts) = policy.classify_all(layers.into_attributes());
    for (rule, n) in counts.iter() {
        for _ in 0..n {
            violations.add(rule);
        }
    }
    Ok(ResolvedResource {
        resource: Resource::builder_empty()
            .with_schema_url(kept, SCHEMA_URL)
            .build(),
        violations,
        version_fallback,
    })
}

/// The resource attributes being composed: a later value for a key
/// replaces an earlier one.
#[derive(Debug, Default)]
struct Layers(BTreeMap<String, Value>);

impl Layers {
    fn set(&mut self, kv: KeyValue) {
        self.0.insert(kv.key.as_str().to_owned(), kv.value);
    }

    fn extend(&mut self, attrs: impl IntoIterator<Item = KeyValue>) {
        for kv in attrs {
            // OpenTelemetry drops an attribute with an empty key.
            if !kv.key.as_str().is_empty() {
                self.set(kv);
            }
        }
    }

    /// The value of `key` when it is a string, as Go's
    /// `attribute.Value.AsString` reads it: empty otherwise.
    fn string(&self, key: &str) -> &str {
        match self.0.get(key) {
            Some(Value::String(s)) => s.as_str(),
            _ => "",
        }
    }

    fn into_attributes(self) -> Vec<KeyValue> {
        self.0
            .into_iter()
            .map(|(key, value)| KeyValue::new(key, value))
            .collect()
    }
}

/// Applies the tier-0 identity contract: a usable `service.name` and an
/// allowed `deployment.environment.name`. Under strict identity a problem
/// is an error; otherwise each comes back as the rule it breaks.
fn enforce_identity(layers: &Layers, settings: &Settings) -> Result<Vec<Rule>, Error> {
    let strict = !settings.lax_identity;
    let mut problems = Vec::new();
    if !is_usable_service_name(layers.string(SERVICE_NAME)) {
        if strict {
            return Err(Error::NoServiceName);
        }
        problems.push(Rule::IdentityServiceName);
    }
    let environment = layers.string(Environment::KEY);
    if environment.is_empty() {
        if strict {
            return Err(Error::NoEnvironment);
        }
        problems.push(Rule::IdentityEnvironment);
    } else if !ENVIRONMENT_VALUES.contains(&environment)
        && !settings.extra_environments.contains(environment)
    {
        if strict {
            // As in Go: the base values and the extra ones, sorted, a value
            // in both sets listed twice.
            let mut allowed: Vec<String> = ENVIRONMENT_VALUES
                .iter()
                .map(|v| (*v).to_owned())
                .chain(settings.extra_environments.iter().cloned())
                .collect();
            allowed.sort();
            return Err(Error::InvalidEnvironment {
                value: environment.to_owned(),
                allowed,
            });
        }
        problems.push(Rule::IdentityEnvironmentInvalid);
    }
    Ok(problems)
}

/// Reports whether `name` is a usable service identity: not blank after
/// trimming and not the SDK's `unknown_service` fallback shape.
fn is_usable_service_name(name: &str) -> bool {
    let name = name.trim();
    !(name.is_empty() || name == "unknown_service" || name.starts_with("unknown_service:"))
}

/// Derives `service.instance.id` from Kubernetes pod identity: a version 5
/// UUID of the pod UID, else of `<namespace>/<pod name>`, else a random
/// version 4 UUID. Every libo11y implementation derives the same ID from the
/// same identity (`conformance/vectors/instance-id.json`).
pub(crate) fn instance_id_for(pod_uid: &str, pod_name: &str, namespace: &str) -> String {
    let id = if !pod_uid.is_empty() {
        uuid::Uuid::new_v5(&INSTANCE_ID_NAMESPACE, pod_uid.as_bytes())
    } else if !pod_name.is_empty() {
        uuid::Uuid::new_v5(
            &INSTANCE_ID_NAMESPACE,
            format!("{namespace}/{pod_name}").as_bytes(),
        )
    } else {
        uuid::Uuid::new_v4()
    };
    id.hyphenated().to_string()
}

#[cfg(test)]
mod tests;
