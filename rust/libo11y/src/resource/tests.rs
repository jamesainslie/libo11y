use std::collections::HashMap;

use opentelemetry::{Key, KeyValue, Value};

use libo11y_spec::{Environment, SCHEMA_URL};

use super::*;
use crate::{BuildInfo, EnvLookup, Error, PiiMode, Rule, Sdk};

const TEST_KEY: [u8; 32] = [7; 32];

fn detected() -> Detected {
    Detected {
        telemetry_sdk: vec![
            KeyValue::new("telemetry.sdk.name", "opentelemetry"),
            KeyValue::new("telemetry.sdk.language", "rust"),
            KeyValue::new("telemetry.sdk.version", "0.33.1"),
        ],
        host_name: Some("detected-host".to_owned()),
        runtime_version: "1.95.0".to_owned(),
        container_id: None,
    }
}

/// A builder that reads only the given environment and detects only the
/// fixed layers above.
fn with_env(vars: &[(&str, &str)]) -> crate::Builder {
    let vars: Vec<(String, String)> = vars
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    Sdk::builder()
        .env_lookup(EnvLookup::from_pairs(vars))
        .detected(detected())
}

fn identified() -> crate::Builder {
    with_env(&[])
        .service_name("svc")
        .environment(Environment::Test)
}

fn attrs(sdk: &Sdk) -> HashMap<String, Value> {
    sdk.resource()
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect()
}

fn string(sdk: &Sdk, key: &str) -> Option<String> {
    sdk.resource()
        .get(&Key::from(key.to_owned()))
        .map(|v| v.to_string())
}

// go/identity_test.go TestEnvironmentRequired.
#[test]
fn an_environment_is_required() {
    let err = with_env(&[])
        .service_name("svc")
        .build()
        .expect_err("no environment");
    assert!(matches!(err, Error::NoEnvironment), "{err}");
}

// TestEnvironmentFromOption.
#[test]
fn the_environment_comes_from_the_option() {
    let sdk = with_env(&[])
        .service_name("svc")
        .environment(Environment::Production)
        .build()
        .expect("valid identity");
    assert_eq!(
        string(&sdk, "deployment.environment.name").as_deref(),
        Some("production")
    );
}

// TestEnvironmentFromResourceAttributes.
#[test]
fn the_environment_comes_from_resource_attributes() {
    let sdk = with_env(&[(
        "OTEL_RESOURCE_ATTRIBUTES",
        "deployment.environment.name=staging",
    )])
    .service_name("svc")
    .build()
    .expect("valid identity");
    assert_eq!(
        string(&sdk, "deployment.environment.name").as_deref(),
        Some("staging")
    );
}

// TestEnvironmentInvalidRejected.
#[test]
fn an_environment_outside_the_set_is_rejected() {
    let err = with_env(&[])
        .service_name("svc")
        .environment("prod")
        .build()
        .expect_err("prod is not allowed");
    assert!(matches!(err, Error::InvalidEnvironment { .. }), "{err}");
    assert_eq!(
        err.to_string(),
        "o11y: deployment environment not in the allowed set: \"prod\" (allowed: development, production, staging, test)"
    );

    let extended = with_env(&[])
        .service_name("svc")
        .environment("prod")
        .environment_values(["qa", "production"])
        .build()
        .expect_err("prod is still not allowed");
    assert_eq!(
        extended.to_string(),
        "o11y: deployment environment not in the allowed set: \"prod\" (allowed: development, production, production, qa, staging, test)"
    );
}

// TestEnvironmentExtensionAccepted.
#[test]
fn an_added_environment_is_accepted() {
    let sdk = with_env(&[])
        .service_name("svc")
        .environment("perf")
        .environment_values(["perf"])
        .build()
        .expect("perf is allowed");
    assert_eq!(
        string(&sdk, "deployment.environment.name").as_deref(),
        Some("perf")
    );
}

// TestWithoutStrictIdentityDowngradesToWarning.
#[test]
fn lax_identity_counts_violations_instead() {
    let sdk = with_env(&[])
        .without_strict_identity()
        .build()
        .expect("lax identity");
    let violations = sdk.resource_violations();
    assert_eq!(violations.get(Rule::IdentityServiceName), 1);
    assert_eq!(violations.get(Rule::IdentityEnvironment), 1);
}

// TestWithoutStrictIdentityCountsInvalidEnvironment.
#[test]
fn lax_identity_counts_an_invalid_environment() {
    let sdk = with_env(&[])
        .service_name("svc")
        .environment("not-an-environment")
        .without_strict_identity()
        .build()
        .expect("lax identity");
    let violations = sdk.resource_violations();
    assert_eq!(violations.get(Rule::IdentityEnvironmentInvalid), 1);
    assert_eq!(violations.get(Rule::IdentityServiceName), 0);
    assert_eq!(violations.get(Rule::IdentityEnvironment), 0);
}

// TestSchemaURLStamped.
#[test]
fn one_schema_url_is_stamped() {
    let sdk = identified().build().expect("valid identity");
    assert_eq!(sdk.resource().schema_url(), Some(SCHEMA_URL));
}

// TestInstanceIDDerivedUUIDv4.
#[test]
fn the_instance_id_is_a_random_uuid_without_a_pod() {
    let first = string(&identified().build().expect("valid"), "service.instance.id")
        .expect("an instance id");
    let second = string(&identified().build().expect("valid"), "service.instance.id")
        .expect("an instance id");
    assert_eq!(first.len(), 36);
    assert_eq!(first.matches('-').count(), 4);
    assert_eq!(&first[14..15], "4", "a version 4 UUID: {first}");
    assert_ne!(first, second);
}

// TestInstanceIDDerivedFromPodStable and TestInstanceIDDerivedFromPodName.
#[test]
fn the_instance_id_derives_from_the_pod() {
    let from_uid = || {
        let sdk = with_env(&[(
            "OTEL_RESOURCE_ATTRIBUTES",
            "k8s.pod.uid=pod-uid-1234,k8s.namespace.name=default",
        )])
        .service_name("svc")
        .environment(Environment::Test)
        .build()
        .expect("valid");
        string(&sdk, "service.instance.id")
    };
    assert_eq!(from_uid(), from_uid());

    let sdk = with_env(&[(
        "OTEL_RESOURCE_ATTRIBUTES",
        "k8s.pod.name=lor-site-7d9f8-abcde,k8s.namespace.name=lor-site",
    )])
    .service_name("svc")
    .environment(Environment::Test)
    .build()
    .expect("valid");
    assert_eq!(
        string(&sdk, "service.instance.id").as_deref(),
        Some("620f09d7-0486-5b08-8412-83628da94a0f")
    );

    let kept = identified()
        .resource_attributes([KeyValue::new("service.instance.id", "mine")])
        .build()
        .expect("valid");
    assert_eq!(
        string(&kept, "service.instance.id").as_deref(),
        Some("mine")
    );
}

#[test]
fn the_instance_id_matches_the_conformance_vectors() {
    #[derive(serde::Deserialize)]
    struct Vector {
        name: String,
        k8s_pod_uid: String,
        k8s_pod_name: String,
        k8s_namespace_name: String,
        want: String,
    }
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/vectors/instance-id.json"
    );
    let raw = std::fs::read_to_string(path).expect("the conformance vectors are readable");
    let vectors: Vec<Vector> = serde_json::from_str(&raw).expect("the vectors are JSON");
    assert!(vectors.len() >= 4);
    for v in vectors {
        assert_eq!(
            instance_id_for(&v.k8s_pod_uid, &v.k8s_pod_name, &v.k8s_namespace_name),
            v.want,
            "{}",
            v.name
        );
    }
}

// TestServiceVersionFallback and the summary's version-fallback flag.
#[test]
fn the_version_falls_back_and_says_so() {
    let sdk = identified().build().expect("valid");
    assert_eq!(
        string(&sdk, "service.version").as_deref(),
        Some(SERVICE_VERSION_FALLBACK)
    );
    assert!(sdk.service_version_fallback());

    let set = identified()
        .service_version(" 1.2.3 ")
        .build()
        .expect("valid");
    assert_eq!(string(&set, "service.version").as_deref(), Some("1.2.3"));
    assert!(!set.service_version_fallback());
}

#[test]
fn the_version_comes_from_the_option_then_the_environment_then_the_build() {
    let build = BuildInfo::new("0.9.0").with_revision("abc");
    let from_build = identified()
        .build_info(build.clone())
        .build()
        .expect("valid");
    assert_eq!(
        string(&from_build, "service.version").as_deref(),
        Some("0.9.0")
    );
    assert_eq!(
        string(&from_build, "vcs.ref.head.revision").as_deref(),
        Some("abc")
    );
    assert!(!from_build.service_version_fallback());

    let from_env = with_env(&[("OTEL_RESOURCE_ATTRIBUTES", "service.version=1.0.0")])
        .service_name("svc")
        .environment(Environment::Test)
        .build_info(build.clone())
        .build()
        .expect("valid");
    assert_eq!(
        string(&from_env, "service.version").as_deref(),
        Some("1.0.0")
    );

    let from_option = with_env(&[("OTEL_RESOURCE_ATTRIBUTES", "service.version=1.0.0")])
        .service_name("svc")
        .environment(Environment::Test)
        .build_info(build)
        .service_version("2.0.0")
        .build()
        .expect("valid");
    assert_eq!(
        string(&from_option, "service.version").as_deref(),
        Some("2.0.0")
    );
}

// go/contract_test.go TestEnvResourceAttributesOverrideDetectors.
#[test]
fn the_environment_beats_the_detectors() {
    let sdk = with_env(&[(
        "OTEL_RESOURCE_ATTRIBUTES",
        "host.name=env-host,process.runtime.name=env-runtime",
    )])
    .service_name("svc")
    .environment(Environment::Test)
    .build()
    .expect("valid");
    assert_eq!(string(&sdk, "host.name").as_deref(), Some("env-host"));
    assert_eq!(
        string(&sdk, "process.runtime.name").as_deref(),
        Some("env-runtime")
    );

    let detected_only = identified().build().expect("valid");
    assert_eq!(
        string(&detected_only, "host.name").as_deref(),
        Some("detected-host")
    );
    assert_eq!(
        string(&detected_only, "process.runtime.name").as_deref(),
        Some("rustc")
    );
    assert_eq!(
        string(&detected_only, "process.runtime.version").as_deref(),
        Some("1.95.0")
    );
    assert_eq!(
        string(&detected_only, "telemetry.sdk.language").as_deref(),
        Some("rust")
    );
}

// TestServiceNameRejectsDegenerateForms.
#[test]
fn degenerate_service_names_are_refused() {
    let blank = with_env(&[])
        .service_name("   ")
        .environment(Environment::Test)
        .build();
    assert!(matches!(blank, Err(Error::NoServiceName)));
    let unknown = with_env(&[("OTEL_SERVICE_NAME", "unknown_service")])
        .environment(Environment::Test)
        .build();
    assert!(matches!(unknown, Err(Error::NoServiceName)));
    let prefixed = with_env(&[(
        "OTEL_RESOURCE_ATTRIBUTES",
        "service.name=unknown_service:bash",
    )])
    .environment(Environment::Test)
    .build();
    assert!(matches!(prefixed, Err(Error::NoServiceName)));
}

#[test]
fn the_service_name_option_beats_both_variables() {
    let env = [
        ("OTEL_SERVICE_NAME", "from-var"),
        ("OTEL_RESOURCE_ATTRIBUTES", "service.name=from-attrs"),
    ];
    let var = with_env(&env)
        .environment(Environment::Test)
        .build()
        .expect("valid");
    assert_eq!(string(&var, "service.name").as_deref(), Some("from-var"));
    let option = with_env(&env)
        .service_name(" from-option ")
        .environment(Environment::Test)
        .build()
        .expect("valid");
    assert_eq!(
        string(&option, "service.name").as_deref(),
        Some("from-option")
    );
}

#[test]
fn resource_attributes_win_over_identity_options() {
    let sdk = identified()
        .resource_attributes([KeyValue::new("service.name", "override")])
        .build()
        .expect("valid");
    assert_eq!(string(&sdk, "service.name").as_deref(), Some("override"));
}

#[test]
fn hermetic_mode_reads_no_environment() {
    let built = with_env(&[
        ("OTEL_SERVICE_NAME", "from-var"),
        (
            "OTEL_RESOURCE_ATTRIBUTES",
            "deployment.environment.name=staging,team=x",
        ),
    ])
    .without_otel_env()
    .without_strict_identity()
    .build()
    .expect("lax identity");
    let attrs = attrs(&built);
    assert!(!attrs.contains_key("service.name"));
    assert!(!attrs.contains_key("team"));
    assert_eq!(
        built.resource_violations().get(Rule::IdentityServiceName),
        1
    );
}

#[test]
fn the_resource_never_carries_process_identity() {
    let sdk = Sdk::builder()
        .env_lookup(EnvLookup::empty())
        .service_name("svc")
        .environment(Environment::Test)
        .build()
        .expect("valid");
    let attrs = attrs(&sdk);
    for key in [
        "process.pid",
        "process.command_line",
        "process.command_args",
        "host.id",
    ] {
        assert!(!attrs.contains_key(key), "{key}");
    }
    for key in libo11y_spec::REQUIRED_TIER0 {
        assert!(attrs.contains_key(*key), "{key}");
    }
}

// go/resource_policy_test.go TestResourcePIIEnforcedOnEveryExportedSignal.
#[test]
fn resource_pii_is_dropped_and_counted() {
    let sdk = identified()
        .resource_attributes([
            KeyValue::new("host.ip", "10.9.8.7"),
            KeyValue::new("host.mac", "aa:bb:cc:dd:ee:ff"),
        ])
        .build()
        .expect("valid");
    let attrs = attrs(&sdk);
    assert!(!attrs.contains_key("host.ip") && !attrs.contains_key("host.mac"));
    assert_eq!(sdk.resource_violations().get(Rule::PiiAttribute), 2);
    assert_eq!(sdk.resource_violations().iter().count(), 1);
}

// TestResourceSecretFromEnvironment.
#[test]
fn a_secret_from_the_environment_never_survives() {
    for mode in [PiiMode::Drop, PiiMode::Allow, PiiMode::Hash] {
        let sdk = with_env(&[(
            "OTEL_RESOURCE_ATTRIBUTES",
            "http.request.header.authorization=s3cr3t",
        )])
        .service_name("svc")
        .environment(Environment::Test)
        .pii_mode(mode)
        .pii_hash_key(TEST_KEY)
        .build()
        .expect("valid");
        for (key, value) in attrs(&sdk) {
            assert!(!value.to_string().contains("s3cr3t"), "{mode:?}: {key}");
        }
        assert_eq!(sdk.resource_violations().get(Rule::SecretAttribute), 1);
    }
}

// TestResourcePIIHashedWithKey and TestResourcePIIFromEnvironment.
#[test]
fn resource_pii_is_tokenized_under_hash() {
    let sdk = with_env(&[(
        "OTEL_RESOURCE_ATTRIBUTES",
        "host.ip=10.9.8.7,o11y.test.env=kept",
    )])
    .service_name("svc")
    .environment(Environment::Test)
    .pii_mode(PiiMode::Hash)
    .pii_hash_key(TEST_KEY)
    .build()
    .expect("valid");
    let token = string(&sdk, "host.ip").expect("a token");
    assert!(token.starts_with("hmac-sha256:") && token.len() == "hmac-sha256:".len() + 32);
    assert_eq!(Some(token), sdk.policy().token(&Value::from("10.9.8.7")));
    assert_eq!(string(&sdk, "o11y.test.env").as_deref(), Some("kept"));
    assert_eq!(sdk.resource_violations().get(Rule::PiiAttribute), 1);

    let dropped = with_env(&[(
        "OTEL_RESOURCE_ATTRIBUTES",
        "host.ip=10.9.8.7,o11y.test.env=kept",
    )])
    .service_name("svc")
    .environment(Environment::Test)
    .build()
    .expect("valid");
    assert_eq!(string(&dropped, "host.ip"), None);
    assert_eq!(string(&dropped, "o11y.test.env").as_deref(), Some("kept"));
}

// go/piihash_test.go TestPIIHashRequiresKey, before any registry loads.
#[test]
fn hashing_without_a_long_key_fails_first() {
    for key in [&[][..], &[1; 31][..]] {
        let err = identified()
            .pii_mode(PiiMode::Hash)
            .pii_hash_key(key)
            .app_registry_file("no-such-registry.yaml")
            .build()
            .expect_err("a short key");
        assert!(matches!(err, Error::PiiHashKey), "{err}");
    }
}

// TestPIIHashKeyIsCopied: the builder copies the key.
#[test]
fn the_hash_key_is_copied() {
    let mut key = TEST_KEY.to_vec();
    let builder = identified().pii_mode(PiiMode::Hash).pii_hash_key(&key);
    key.fill(0);
    let sdk = builder.build().expect("valid");
    let other = identified()
        .pii_mode(PiiMode::Hash)
        .pii_hash_key(TEST_KEY)
        .build()
        .expect("valid");
    let value = Value::from("x");
    assert_eq!(sdk.policy().token(&value), other.policy().token(&value));
}

#[test]
fn registries_load_into_the_policy() {
    let conformance = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/appregistry/valid.yaml"
    );
    let sdk = identified()
        .app_registry_file(conformance)
        .resource_attributes([KeyValue::new("lor.client.email", "a@b.c")])
        .build()
        .expect("a valid registry");
    assert_eq!(string(&sdk, "lor.client.email"), None);
    assert_eq!(sdk.resource_violations().get(Rule::PiiAttribute), 1);

    let missing = identified()
        .app_registry_file("no-such-registry.yaml")
        .build()
        .expect_err("a missing file");
    assert!(
        matches!(missing, Error::ReadAppRegistry { .. }),
        "{missing}"
    );

    let loaded = crate::AppRegistry::from_path(conformance).expect("valid");
    let twice = identified()
        .app_registry(loaded)
        .app_registry_file(conformance)
        .build()
        .expect_err("one namespace twice");
    assert!(twice.is_invalid_app_registry(), "{twice}");
}

#[test]
fn the_sdk_hands_out_the_default_propagator() {
    use opentelemetry::propagation::TextMapPropagator;

    let sdk = identified().build().expect("valid");
    assert_eq!(
        sdk.propagator().fields().collect::<Vec<_>>(),
        ["traceparent", "tracestate", "baggage"]
    );
    let replaced = identified()
        .propagators([
            Box::new(opentelemetry_sdk::propagation::BaggagePropagator::new())
                as crate::BoxedPropagator,
        ])
        .build()
        .expect("valid");
    assert_eq!(
        replaced.propagator().fields().collect::<Vec<_>>(),
        ["baggage"]
    );
}
