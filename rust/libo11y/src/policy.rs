//! The sensitivity policy: the one place that decides what happens to an
//! attribute the specification, or an application registry, classifies.
//!
//! Classification is by key. The specification's table comes first, and an
//! application registry is consulted only for keys the specification leaves
//! unclassified. A secret is dropped on every signal. A PII attribute is
//! dropped, rewritten to a keyed token, or kept, according to the
//! [`PiiMode`]; on metrics it is dropped under every mode but
//! [`PiiMode::Allow`], because a token per value would multiply series.
//! Every other attribute is kept.
//!
//! Values under unclassified keys are outside this layer; protect those at
//! capture time.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::Arc;

use hmac::{Hmac, KeyInit, Mac};
use libo11y_spec::{Sensitivity, sensitivity_of};
use opentelemetry::logs::AnyValue;
use opentelemetry::{Key, KeyValue, Value};
use sha2::Sha256;

use crate::Error;
use crate::canonical::{canonical_any, canonical_value};

/// The shortest key [`PiiMode::Hash`] accepts: 256 bits, the SHA-256 output
/// size, so the key is never the weakest part of a token.
pub const MIN_PII_HASH_KEY_LEN: usize = 32;

/// How attributes classified as PII are handled.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum PiiMode {
    /// Remove PII attributes. The default.
    #[default]
    Drop,
    /// Replace a PII value with a keyed HMAC-SHA256 token, so values stay
    /// joinable across records without being reversible by anyone who
    /// lacks the key. Needs a key of at least [`MIN_PII_HASH_KEY_LEN`]
    /// bytes. Metrics still drop PII under this mode.
    Hash,
    /// Emit PII attributes unchanged. Never the default; it needs an
    /// explicit opt-in and a data-handling justification.
    Allow,
}

/// A specification rule a telemetry record broke, as the
/// `o11y.schema.violations` counter's `o11y.rule` attribute names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum Rule {
    /// A secret attribute was dropped.
    SecretAttribute,
    /// A PII attribute was dropped or rewritten to a token.
    PiiAttribute,
    /// No usable service name resolved, and strict identity is off.
    IdentityServiceName,
    /// No deployment environment resolved, and strict identity is off.
    IdentityEnvironment,
    /// The deployment environment is outside the allowed set, and strict
    /// identity is off.
    IdentityEnvironmentInvalid,
}

impl Rule {
    /// Returns the rule's name, the value of `o11y.rule`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SecretAttribute => "secret_attribute",
            Self::PiiAttribute => "pii_attribute",
            Self::IdentityServiceName => "identity_service_name",
            Self::IdentityEnvironment => "identity_environment",
            Self::IdentityEnvironmentInvalid => "identity_environment_invalid",
        }
    }
}

impl fmt::Display for Rule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// How many times each rule was broken.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Violations(BTreeMap<Rule, u64>);

impl Violations {
    /// Counts one more violation of `rule`.
    pub fn add(&mut self, rule: Rule) {
        *self.0.entry(rule).or_insert(0) += 1;
    }

    /// Returns how many times `rule` was broken.
    #[must_use]
    pub fn get(&self, rule: Rule) -> u64 {
        self.0.get(&rule).copied().unwrap_or(0)
    }

    /// Reports whether no rule was broken.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Returns each broken rule with its count, in rule order.
    pub fn iter(&self) -> impl Iterator<Item = (Rule, u64)> + '_ {
        self.0.iter().map(|(rule, n)| (*rule, *n))
    }
}

/// What the policy does with an attribute under a given key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Decision {
    /// The attribute passes unchanged.
    Keep,
    /// The value is replaced with its PII token, a string.
    Rewrite(Rule),
    /// The attribute is removed.
    Drop(Rule),
}

impl Decision {
    /// Returns the rule a rewrite or a drop counts against, or `None` for
    /// [`Decision::Keep`].
    #[must_use]
    pub const fn rule(self) -> Option<Rule> {
        match self {
            Self::Keep => None,
            Self::Rewrite(rule) | Self::Drop(rule) => Some(rule),
        }
    }
}

/// What classification made of one attribute.
#[derive(Debug, Clone, PartialEq)]
pub enum Classified<T> {
    /// The attribute passes unchanged.
    Kept(T),
    /// The attribute's value was replaced with its PII token.
    Rewritten(T, Rule),
    /// The attribute was removed.
    Dropped(Rule),
}

impl<T> Classified<T> {
    /// Returns the attribute to emit, or `None` when it was dropped.
    #[must_use]
    pub fn into_kept(self) -> Option<T> {
        match self {
            Self::Kept(value) | Self::Rewritten(value, _) => Some(value),
            Self::Dropped(_) => None,
        }
    }

    /// Returns the rule the attribute broke, or `None` when it was kept.
    #[must_use]
    pub fn violation(&self) -> Option<Rule> {
        match self {
            Self::Kept(_) => None,
            Self::Rewritten(_, rule) | Self::Dropped(rule) => Some(*rule),
        }
    }
}

/// The sensitivity policy one SDK applies on every signal.
///
/// Cloning is cheap: clones share one table and one key, so the log, span
/// and metric pipelines and the resource all ask the same policy and cannot
/// drift apart.
#[derive(Clone)]
pub struct Policy(Arc<Inner>);

struct Inner {
    /// Classes the application registries declare.
    app: HashMap<String, Sensitivity>,
    mode: PiiMode,
    /// The keyed MAC, present only under [`PiiMode::Hash`].
    mac: Option<Hmac<Sha256>>,
}

impl Policy {
    /// Builds a policy. `app` holds the classes the application registries
    /// declare. Fails with [`Error::PiiHashKey`] when `mode` is
    /// [`PiiMode::Hash`] and `key` is shorter than
    /// [`MIN_PII_HASH_KEY_LEN`] bytes.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the builder constructs the policy")
    )]
    pub(crate) fn new(
        mode: PiiMode,
        key: &[u8],
        app: HashMap<String, Sensitivity>,
    ) -> Result<Self, Error> {
        let mac = match mode {
            PiiMode::Hash if key.len() < MIN_PII_HASH_KEY_LEN => return Err(Error::PiiHashKey),
            // HMAC accepts a key of any length, so this cannot fail.
            PiiMode::Hash => {
                Some(Hmac::<Sha256>::new_from_slice(key).map_err(|_| Error::PiiHashKey)?)
            }
            PiiMode::Drop | PiiMode::Allow => None,
        };
        Ok(Self(Arc::new(Inner { app, mode, mac })))
    }

    /// Returns the PII mode.
    #[must_use]
    pub fn pii_mode(&self) -> PiiMode {
        self.0.mode
    }

    /// Returns the class of `key`: the specification's, else the one an
    /// application registry declares, else `None`.
    #[must_use]
    pub fn class_of(&self, key: &str) -> Option<Sensitivity> {
        // Registry namespaces are disjoint from the specification's (the
        // validator refuses every reserved namespace), so a spec answer never
        // contradicts a registry.
        sensitivity_of(key).or_else(|| self.0.app.get(key).copied())
    }

    /// Decides what happens to an attribute under `key` on logs, spans and
    /// the resource.
    #[must_use]
    pub fn decide(&self, key: &str) -> Decision {
        match self.class_of(key) {
            Some(Sensitivity::Secret) => Decision::Drop(Rule::SecretAttribute),
            Some(Sensitivity::Pii) => match self.0.mode {
                PiiMode::Drop => Decision::Drop(Rule::PiiAttribute),
                PiiMode::Hash => Decision::Rewrite(Rule::PiiAttribute),
                PiiMode::Allow => Decision::Keep,
            },
            Some(Sensitivity::Public | Sensitivity::Internal) | None => Decision::Keep,
        }
    }

    /// Reports whether a metric data point or exemplar may carry an
    /// attribute under `key`. Secrets and PII are dropped, PII even under
    /// [`PiiMode::Hash`]. Metric drops are not violations.
    #[must_use]
    pub fn keeps_on_metrics(&self, key: &str) -> bool {
        match self.class_of(key) {
            Some(Sensitivity::Secret) => false,
            Some(Sensitivity::Pii) => self.0.mode == PiiMode::Allow,
            Some(Sensitivity::Public | Sensitivity::Internal) | None => true,
        }
    }

    /// Returns the PII token of `value`, or `None` when the mode is not
    /// [`PiiMode::Hash`].
    #[must_use]
    pub fn token(&self, value: &Value) -> Option<String> {
        self.0
            .mac
            .as_ref()
            .map(|mac| token_of(mac, &canonical_value(value)))
    }

    /// Returns the PII token of a log attribute value, or `None` when the
    /// mode is not [`PiiMode::Hash`]. A value that an attribute value can
    /// also hold has the same token on both paths.
    #[must_use]
    pub fn token_any(&self, value: &AnyValue) -> Option<String> {
        self.0
            .mac
            .as_ref()
            .map(|mac| token_of(mac, &canonical_any(value)))
    }

    /// Classifies one attribute.
    #[must_use]
    pub fn classify(&self, kv: KeyValue) -> Classified<KeyValue> {
        match self.decide(kv.key.as_str()) {
            Decision::Keep => Classified::Kept(kv),
            Decision::Drop(rule) => Classified::Dropped(rule),
            Decision::Rewrite(rule) => match self.token(&kv.value) {
                Some(token) => Classified::Rewritten(KeyValue::new(kv.key, token), rule),
                None => Classified::Dropped(rule),
            },
        }
    }

    /// Classifies one log attribute.
    #[must_use]
    pub fn classify_any(&self, key: Key, value: AnyValue) -> Classified<(Key, AnyValue)> {
        match self.decide(key.as_str()) {
            Decision::Keep => Classified::Kept((key, value)),
            Decision::Drop(rule) => Classified::Dropped(rule),
            Decision::Rewrite(rule) => match self.token_any(&value) {
                Some(token) => Classified::Rewritten((key, AnyValue::from(token)), rule),
                None => Classified::Dropped(rule),
            },
        }
    }

    /// Classifies every attribute in `attrs`, returning the ones to emit,
    /// in order, and how many broke each rule.
    pub fn classify_all<I>(&self, attrs: I) -> (Vec<KeyValue>, Violations)
    where
        I: IntoIterator<Item = KeyValue>,
    {
        let mut violations = Violations::default();
        let kept = attrs
            .into_iter()
            .filter_map(|kv| {
                let classified = self.classify(kv);
                if let Some(rule) = classified.violation() {
                    violations.add(rule);
                }
                classified.into_kept()
            })
            .collect();
        (kept, violations)
    }
}

/// The token of a canonical rendering: `hmac-sha256:` and the lowercase hex
/// of the first 16 bytes of HMAC-SHA256 over it, 128 bits that keep tokens
/// joinable while making collisions negligible.
fn token_of(mac: &Hmac<Sha256>, canonical: &str) -> String {
    use std::fmt::Write as _;

    let digest = mac
        .clone()
        .chain_update(canonical.as_bytes())
        .finalize()
        .into_bytes();
    let mut token = String::with_capacity("hmac-sha256:".len() + 32);
    token.push_str("hmac-sha256:");
    for byte in &digest[..16] {
        // Writing to a String cannot fail.
        let _ = write!(token, "{byte:02x}");
    }
    token
}

impl fmt::Debug for Policy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Policy")
            .field("pii_mode", &self.0.mode)
            .field("app_keys", &self.0.app.len())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use opentelemetry::{Array, StringValue};

    fn test_key() -> Vec<u8> {
        (0..32).collect()
    }

    fn hashing() -> Policy {
        Policy::new(PiiMode::Hash, &test_key(), HashMap::new()).expect("a 32-byte key")
    }

    fn with_mode(mode: PiiMode) -> Policy {
        Policy::new(mode, &[], HashMap::new()).expect("no key needed")
    }

    #[test]
    fn hash_mode_requires_a_long_key() {
        assert!(matches!(
            Policy::new(PiiMode::Hash, &[], HashMap::new()),
            Err(Error::PiiHashKey)
        ));
        assert!(matches!(
            Policy::new(PiiMode::Hash, &[7; 31], HashMap::new()),
            Err(Error::PiiHashKey)
        ));
        assert!(Policy::new(PiiMode::Hash, &[7; 32], HashMap::new()).is_ok());
        assert!(Policy::new(PiiMode::Drop, &[], HashMap::new()).is_ok());
    }

    #[test]
    fn secrets_drop_under_every_mode() {
        for policy in [
            with_mode(PiiMode::Drop),
            with_mode(PiiMode::Allow),
            hashing(),
        ] {
            assert_eq!(
                policy.decide("http.request.header.authorization"),
                Decision::Drop(Rule::SecretAttribute)
            );
            assert!(!policy.keeps_on_metrics("http.request.header.cookie"));
        }
    }

    #[test]
    fn pii_follows_the_mode() {
        assert_eq!(
            with_mode(PiiMode::Drop).decide("host.ip"),
            Decision::Drop(Rule::PiiAttribute)
        );
        assert_eq!(
            hashing().decide("host.ip"),
            Decision::Rewrite(Rule::PiiAttribute)
        );
        assert_eq!(with_mode(PiiMode::Allow).decide("host.ip"), Decision::Keep);
        assert_eq!(PiiMode::default(), PiiMode::Drop);
    }

    #[test]
    fn metrics_drop_pii_even_when_hashing() {
        assert!(!hashing().keeps_on_metrics("host.ip"));
        assert!(!with_mode(PiiMode::Drop).keeps_on_metrics("host.ip"));
        assert!(with_mode(PiiMode::Allow).keeps_on_metrics("host.ip"));
        assert!(hashing().keeps_on_metrics("service.name"));
    }

    #[test]
    fn other_keys_pass() {
        let policy = hashing();
        assert_eq!(policy.decide("service.name"), Decision::Keep);
        assert_eq!(policy.decide("unlisted.key"), Decision::Keep);
    }

    // go/policy_test.go TestPolicyFallsBackToAppClasses.
    #[test]
    fn app_classes_apply_only_to_unclassified_keys() {
        let app = HashMap::from([
            ("lor.api.token".to_owned(), Sensitivity::Secret),
            ("lor.user.id".to_owned(), Sensitivity::Internal),
            ("service.name".to_owned(), Sensitivity::Secret),
            ("lor.client.mail".to_owned(), Sensitivity::Pii),
        ]);
        let policy = Policy::new(PiiMode::Drop, &[], app).expect("drop needs no key");
        assert_eq!(
            policy.decide("lor.api.token"),
            Decision::Drop(Rule::SecretAttribute)
        );
        assert_eq!(
            policy.decide("lor.client.mail"),
            Decision::Drop(Rule::PiiAttribute)
        );
        assert_eq!(policy.decide("lor.user.id"), Decision::Keep);
        assert_eq!(policy.decide("service.name"), Decision::Keep);
        assert_eq!(policy.decide("lor.unlisted"), Decision::Keep);
        assert_eq!(policy.class_of("lor.user.id"), Some(Sensitivity::Internal));
        assert_eq!(policy.class_of("service.name"), Some(Sensitivity::Public));
        assert_eq!(policy.class_of("lor.unlisted"), None);
    }

    #[test]
    fn tokens_are_keyed_and_stable() {
        let a = hashing();
        let b = Policy::new(PiiMode::Hash, &[9; 32], HashMap::new()).expect("a 32-byte key");
        let value = Value::from("10.0.0.1");
        let token = a.token(&value).expect("hash mode tokenizes");
        assert!(token.starts_with("hmac-sha256:"));
        assert_eq!(token.len(), "hmac-sha256:".len() + 32);
        assert_eq!(a.token(&value), Some(token.clone()));
        assert_ne!(b.token(&value), Some(token));
        assert_eq!(with_mode(PiiMode::Drop).token(&value), None);
    }

    #[test]
    fn tokens_agree_across_value_kinds() {
        let policy = hashing();
        let list = Value::Array(Array::String(vec![
            StringValue::from("10.0.0.1"),
            StringValue::from("10.0.0.2"),
        ]));
        let any = AnyValue::ListAny(Box::new(vec!["10.0.0.1".into(), "10.0.0.2".into()]));
        assert_eq!(policy.token(&list), policy.token_any(&any));
        assert_eq!(
            policy.token(&Value::I64(1)),
            policy.token(&Value::from("1"))
        );
    }

    #[test]
    fn classify_rewrites_to_a_string_token() {
        let policy = hashing();
        let classified = policy.classify(KeyValue::new("host.ip", "10.0.0.1"));
        let token = policy.token(&Value::from("10.0.0.1")).expect("hash mode");
        assert_eq!(
            classified,
            Classified::Rewritten(KeyValue::new("host.ip", token), Rule::PiiAttribute)
        );
        assert_eq!(classified.violation(), Some(Rule::PiiAttribute));

        let dropped = policy.classify(KeyValue::new("http.request.header.cookie", "c"));
        assert_eq!(dropped, Classified::Dropped(Rule::SecretAttribute));
        assert_eq!(dropped.into_kept(), None);

        let kept = policy.classify(KeyValue::new("service.name", "svc"));
        assert_eq!(kept.violation(), None);
        assert_eq!(kept.into_kept(), Some(KeyValue::new("service.name", "svc")));
    }

    #[test]
    fn classify_any_tokenizes_composites() {
        let policy = hashing();
        let value = AnyValue::ListAny(Box::new(vec!["10.0.0.1".into()]));
        let token = policy.token_any(&value).expect("hash mode");
        assert_eq!(
            policy.classify_any(Key::from("host.ip"), value),
            Classified::Rewritten(
                (Key::from("host.ip"), AnyValue::from(token)),
                Rule::PiiAttribute
            )
        );
    }

    // go/policy_test.go TestClassifyResourceAttrsCountsPerRule.
    #[test]
    fn classify_all_counts_per_rule() {
        let app = HashMap::from([("test.secret".to_owned(), Sensitivity::Secret)]);
        let policy = Policy::new(PiiMode::Hash, &test_key(), app).expect("a 32-byte key");
        let (kept, counts) = policy.classify_all([
            KeyValue::new("service.name", "svc"),
            KeyValue::new("test.secret", "s3cr3t"),
            KeyValue::new("host.ip", "10.0.0.1"),
            KeyValue::new("host.mac", "aa:bb"),
        ]);
        assert_eq!(counts.get(Rule::SecretAttribute), 1);
        assert_eq!(counts.get(Rule::PiiAttribute), 2);
        assert_eq!(counts.iter().count(), 2);
        let token = |v: &str| policy.token(&Value::from(v.to_owned())).expect("hash mode");
        assert_eq!(
            kept,
            vec![
                KeyValue::new("service.name", "svc"),
                KeyValue::new("host.ip", token("10.0.0.1")),
                KeyValue::new("host.mac", token("aa:bb")),
            ]
        );
    }

    #[test]
    fn rules_are_named_as_go_names_them() {
        let names: Vec<_> = [
            Rule::SecretAttribute,
            Rule::PiiAttribute,
            Rule::IdentityServiceName,
            Rule::IdentityEnvironment,
            Rule::IdentityEnvironmentInvalid,
        ]
        .iter()
        .map(ToString::to_string)
        .collect();
        assert_eq!(
            names,
            [
                "secret_attribute",
                "pii_attribute",
                "identity_service_name",
                "identity_environment",
                "identity_environment_invalid"
            ]
        );
    }

    mod vectors {
        use super::*;

        #[derive(serde::Deserialize)]
        struct File {
            key_hex: String,
            cases: Vec<Case>,
        }

        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            kind: String,
            value: serde_json::Value,
            canonical: String,
            token: String,
        }

        fn decode_hex(hex: &str) -> Vec<u8> {
            (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
                .collect()
        }

        fn decode_base64(text: &str) -> Vec<u8> {
            const ALPHABET: &[u8] =
                b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut bits = 0u32;
            let mut n = 0;
            let mut out = Vec::new();
            for c in text.bytes().filter(|&c| c != b'=') {
                let v = ALPHABET.iter().position(|&a| a == c).expect("base64");
                bits = bits << 6 | u32::try_from(v).expect("six bits");
                n += 6;
                if n >= 8 {
                    n -= 8;
                    out.push(u8::try_from(bits >> n & 0xff).expect("a byte"));
                }
            }
            out
        }

        fn any(value: &serde_json::Value) -> AnyValue {
            match value {
                serde_json::Value::Bool(b) => AnyValue::Boolean(*b),
                serde_json::Value::Number(n) => n.as_i64().map_or_else(
                    || AnyValue::Double(n.as_f64().expect("a number")),
                    AnyValue::Int,
                ),
                serde_json::Value::String(s) => AnyValue::from(s.clone()),
                serde_json::Value::Array(items) => {
                    AnyValue::ListAny(Box::new(items.iter().map(any).collect()))
                }
                serde_json::Value::Object(members) => AnyValue::Map(Box::new(
                    members
                        .iter()
                        .map(|(k, v)| (Key::from(k.clone()), any(v)))
                        .collect(),
                )),
                serde_json::Value::Null => panic!("no vector holds null"),
            }
        }

        /// The attribute value a scalar or scalar-array case describes.
        fn attribute(kind: &str, value: &serde_json::Value) -> Option<Value> {
            let items = || value.as_array().expect("an array case");
            Some(match kind {
                "string" => Value::from(value.as_str()?.to_owned()),
                "int" => Value::I64(value.as_i64()?),
                "float" => Value::F64(value.as_f64()?),
                "bool" => Value::Bool(value.as_bool()?),
                "string_array" => Value::Array(Array::String(
                    items()
                        .iter()
                        .map(|v| StringValue::from(v.as_str().expect("a string").to_owned()))
                        .collect(),
                )),
                "int_array" => Value::Array(Array::I64(
                    items()
                        .iter()
                        .map(|v| v.as_i64().expect("an int"))
                        .collect(),
                )),
                "float_array" => Value::Array(Array::F64(
                    items()
                        .iter()
                        .map(|v| v.as_f64().expect("a float"))
                        .collect(),
                )),
                "bool_array" => Value::Array(Array::Bool(
                    items()
                        .iter()
                        .map(|v| v.as_bool().expect("a bool"))
                        .collect(),
                )),
                _ => return None,
            })
        }

        #[test]
        fn match_the_conformance_vectors() {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../conformance/vectors/pii-hash.json"
            );
            let raw = std::fs::read_to_string(path).expect("the conformance vectors are readable");
            let file: File = serde_json::from_str(&raw).expect("the vectors are JSON");
            let policy = Policy::new(PiiMode::Hash, &decode_hex(&file.key_hex), HashMap::new())
                .expect("a 32-byte key");
            assert!(file.cases.len() >= 30, "found {} cases", file.cases.len());
            for case in &file.cases {
                let (canonical, token) = match case.kind.as_str() {
                    "bytes" => {
                        let bytes = decode_base64(case.value.as_str().expect("base64 text"));
                        let value = AnyValue::Bytes(Box::new(bytes));
                        (canonical_any(&value), policy.token_any(&value))
                    }
                    "map" => {
                        let value = any(&case.value);
                        (canonical_any(&value), policy.token_any(&value))
                    }
                    kind => {
                        let value = attribute(kind, &case.value)
                            .unwrap_or_else(|| panic!("{}: unknown kind {kind}", case.name));
                        // Both paths must give the same rendering.
                        assert_eq!(
                            canonical_any(&any(&case.value)),
                            case.canonical,
                            "{}",
                            case.name
                        );
                        (canonical_value(&value), policy.token(&value))
                    }
                };
                assert_eq!(canonical, case.canonical, "{}", case.name);
                assert_eq!(token.as_deref(), Some(case.token.as_str()), "{}", case.name);
            }
        }
    }
}
