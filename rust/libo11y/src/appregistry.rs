//! Application attribute registries: the file in which a service declares
//! its own namespaced attributes with their sensitivity, type and
//! cardinality, so the sensitivity policy classifies them exactly like
//! specification keys (`docs/SPEC.md` section 5a, schema
//! `libo11y.app-registry/v1`).
//!
//! [`Registry::parse`] decodes a registry file the way the Go library's
//! `appregistry.Parse` does with gopkg.in/yaml.v3, and
//! [`Registry::validate`] applies the registry rules with Go's violation
//! texts, so every libo11y implementation makes the same of one file
//! (`conformance/appregistry`). [`AppRegistry`] is a registry that parsed
//! and validated, ready for the SDK builder.

mod scalar;
mod yaml;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::path::Path;

use libo11y_spec::{APP_REGISTRY_SCHEMA, Sensitivity, go_quote, is_reserved_namespace};

use crate::Error;

/// A decoded application registry, before the registry rules apply.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Registry {
    /// The registry schema, `libo11y.app-registry/v1`.
    pub schema: String,
    /// The one `snake_case` namespace every attribute sits under.
    pub namespace: String,
    /// The declared attributes by name, in name order.
    pub attributes: BTreeMap<String, Attribute>,
}

/// One declared application attribute.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct Attribute {
    /// The semconv attribute type, such as `string` or `int[]`.
    pub r#type: String,
    /// The sensitivity class: `public`, `internal`, `pii` or `secret`.
    pub sensitivity: String,
    /// The cardinality budget: `enum`, `bounded` or `unbounded`.
    pub cardinality: String,
    /// The values of an enum attribute.
    pub values: Vec<String>,
    /// A one-line description.
    pub brief: String,
}

/// Why a registry file did not decode. The kinds match the `parse:` kinds of
/// the conformance cases.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ParseErrorKind {
    /// The file holds no YAML document.
    Empty,
    /// The file holds more than one YAML document.
    SecondDocument,
    /// A mapping repeats a key.
    DuplicateKey,
    /// A key the registry schema does not define.
    UnknownKey,
    /// A value of the wrong YAML type.
    Type,
    /// The file is not YAML that gopkg.in/yaml.v3 reads.
    Syntax,
}

impl ParseErrorKind {
    /// Returns the kind as the conformance cases name it, such as
    /// `duplicate-key`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::SecondDocument => "second-document",
            Self::DuplicateKey => "duplicate-key",
            Self::UnknownKey => "unknown-key",
            Self::Type => "type",
            Self::Syntax => "syntax",
        }
    }
}

impl fmt::Display for ParseErrorKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A registry file that did not decode.
///
/// The two failures whose wording the Go library fixes read as Go's: an
/// empty file is `application registry is empty`, and a second document is
/// `parsing application registry: an application registry holds one YAML
/// document, found a second`. The others name their kind and a detail,
/// `parsing application registry: <kind>: <detail>`, as the TypeScript
/// library does, because Go's text there is yaml.v3's own.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub struct ParseError {
    kind: ParseErrorKind,
    detail: String,
}

impl ParseError {
    pub(crate) fn new(kind: ParseErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }

    /// Returns why the file did not decode.
    #[must_use]
    pub fn kind(&self) -> ParseErrorKind {
        self.kind
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.kind {
            ParseErrorKind::Empty => f.write_str("application registry is empty"),
            ParseErrorKind::SecondDocument => f.write_str(
                "parsing application registry: an application registry holds one YAML document, found a second",
            ),
            kind => write!(f, "parsing application registry: {kind}: {}", self.detail),
        }
    }
}

/// One rule a registry breaks.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub struct Violation {
    /// The rule's ID, such as `libo11y_attr_naming`.
    pub rule_id: &'static str,
    /// The attribute the rule is about, or `None` for a rule about the
    /// registry as a whole.
    pub attribute: Option<String>,
    /// What is wrong.
    pub detail: String,
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.attribute {
            None => write!(f, "{}: {}", self.rule_id, self.detail),
            Some(name) => write!(f, "{}: attribute {name}: {}", self.rule_id, self.detail),
        }
    }
}

impl Registry {
    /// Decodes a registry file strictly, as Go's `appregistry.Parse` does:
    /// an unknown key, a duplicate key, a value of the wrong type, a second
    /// YAML document and an empty file are errors. The bytes are UTF-8, or
    /// UTF-16 after a byte order mark. The registry rules are not applied;
    /// [`Registry::validate`] applies them.
    ///
    /// # Errors
    ///
    /// Returns a [`ParseError`] naming why the file did not decode.
    pub fn parse(bytes: &[u8]) -> Result<Self, ParseError> {
        yaml::parse(bytes)
    }

    /// Applies the registry rules and returns every violation: the rules
    /// about the registry first, then each attribute in name order, each
    /// attribute's rules in a fixed order.
    #[must_use]
    pub fn validate(&self) -> Vec<Violation> {
        let mut out = Vec::new();
        self.validate_registry(&mut out);
        let prefix = format!("{}.", self.namespace);
        for (name, attr) in &self.attributes {
            let mut fail = |rule_id, detail: String| {
                out.push(Violation {
                    rule_id,
                    attribute: Some(name.clone()),
                    detail,
                });
            };
            if !name.starts_with(&prefix) {
                fail(
                    "libo11y_app_attr_outside_namespace",
                    format!("not under the {} namespace", self.namespace),
                );
            }
            if !valid_name(name) {
                fail(
                    "libo11y_attr_naming",
                    "not a dotted snake_case name with at least two segments".to_owned(),
                );
            }
            attr.validate(&mut fail);
        }
        out
    }

    /// The rules about the registry as a whole.
    fn validate_registry(&self, out: &mut Vec<Violation>) {
        let mut fail = |rule_id, detail: String| {
            out.push(Violation {
                rule_id,
                attribute: None,
                detail,
            });
        };
        if self.schema != APP_REGISTRY_SCHEMA {
            fail(
                "libo11y_app_schema_unknown",
                format!(
                    "schema {}, want {}",
                    go_quote(&self.schema),
                    go_quote(APP_REGISTRY_SCHEMA)
                ),
            );
        }
        if !valid_segment(&self.namespace) {
            fail(
                "libo11y_app_namespace_invalid",
                format!(
                    "namespace {} is not one snake_case segment",
                    go_quote(&self.namespace)
                ),
            );
        } else if is_reserved_namespace(&self.namespace) {
            fail(
                "libo11y_app_namespace_reserved",
                format!(
                    "namespace {} belongs to libo11y, OpenTelemetry, or semconv",
                    go_quote(&self.namespace)
                ),
            );
        }
        if self.attributes.is_empty() {
            fail(
                "libo11y_app_attributes_empty",
                "the registry declares no attributes".to_owned(),
            );
        }
    }
}

impl Attribute {
    /// The rules about one attribute's declaration, after its name.
    fn validate(&self, fail: &mut impl FnMut(&'static str, String)) {
        if !ATTRIBUTE_TYPES.contains(&self.r#type.as_str()) {
            fail(
                "libo11y_app_type_unknown",
                format!("type {}", go_quote(&self.r#type)),
            );
        }
        if self.sensitivity.is_empty() {
            fail(
                "libo11y_sensitivity_missing",
                "no sensitivity class".to_owned(),
            );
        } else if self.sensitivity.parse::<Sensitivity>().is_err() {
            fail(
                "libo11y_sensitivity_unknown",
                format!("sensitivity {}", go_quote(&self.sensitivity)),
            );
        }
        if self.cardinality.is_empty() {
            fail(
                "libo11y_cardinality_missing",
                "no cardinality budget".to_owned(),
            );
        } else if !CARDINALITIES.contains(&self.cardinality.as_str()) {
            fail(
                "libo11y_cardinality_unknown",
                format!("cardinality {}", go_quote(&self.cardinality)),
            );
        }
        let is_enum = self.cardinality == "enum";
        if is_enum && self.values.is_empty() {
            fail(
                "libo11y_app_enum_values_missing",
                "an enum declares its values".to_owned(),
            );
        } else if !is_enum && !self.values.is_empty() {
            fail(
                "libo11y_app_values_without_enum",
                "values need cardinality enum".to_owned(),
            );
        }
        let mut seen = HashSet::new();
        for value in &self.values {
            // Go's strings.TrimSpace and Rust's str::trim both remove the
            // Unicode White_Space property.
            let trimmed = value.trim();
            if trimmed != value {
                fail(
                    "libo11y_enum_value_whitespace",
                    format!("value {}", go_quote(value)),
                );
            }
            if !seen.insert(trimmed) {
                fail(
                    "libo11y_enum_duplicate_value",
                    format!("value {}", go_quote(value)),
                );
            }
        }
    }
}

/// The semconv attribute types an application may use.
const ATTRIBUTE_TYPES: &[&str] = &[
    "string",
    "boolean",
    "int",
    "double",
    "string[]",
    "boolean[]",
    "int[]",
    "double[]",
];

/// The cardinality budgets.
const CARDINALITIES: &[&str] = &["enum", "bounded", "unbounded"];

/// An application registry that parsed and validated, ready for the
/// sensitivity policy. Only sensitivity applies at runtime: types,
/// cardinality budgets and enum values are checked here and by
/// `libo11y registry check`, not on emitted telemetry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppRegistry {
    source: String,
    namespace: String,
    classes: BTreeMap<String, Sensitivity>,
}

impl AppRegistry {
    /// Reads, parses and validates the registry file at `path`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::ReadAppRegistry`] when the file cannot be read,
    /// [`Error::ParseAppRegistry`] when it does not decode, and
    /// [`Error::InvalidAppRegistry`] when it breaks a registry rule.
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self, Error> {
        let path = path.as_ref();
        let source = path.display().to_string();
        let bytes = std::fs::read(path).map_err(|err| Error::ReadAppRegistry {
            path: source.clone(),
            source: err,
        })?;
        Self::from_bytes(source, &bytes)
    }

    /// Parses and validates registry file contents. `source` names the
    /// registry in error messages, as a file name does.
    ///
    /// # Errors
    ///
    /// Returns [`Error::ParseAppRegistry`] when the bytes do not decode and
    /// [`Error::InvalidAppRegistry`] when they break a registry rule.
    pub fn from_bytes(source: impl Into<String>, bytes: &[u8]) -> Result<Self, Error> {
        let source = source.into();
        let registry = Registry::parse(bytes).map_err(|err| Error::ParseAppRegistry {
            path: source.clone(),
            source: err,
        })?;
        let violations = registry.validate();
        if !violations.is_empty() {
            return Err(Error::InvalidAppRegistry {
                path: source,
                violations,
            });
        }
        let classes = registry
            .attributes
            .iter()
            .filter_map(|(name, attr)| Some((name.clone(), attr.sensitivity.parse().ok()?)))
            .collect();
        Ok(Self {
            source,
            namespace: registry.namespace,
            classes,
        })
    }

    /// Returns the name the registry was loaded under.
    #[must_use]
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Returns the namespace the registry declares.
    #[must_use]
    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    /// Returns the class the registry declares for `key`.
    #[must_use]
    pub fn sensitivity_of(&self, key: &str) -> Option<Sensitivity> {
        self.classes.get(key).copied()
    }

    /// Returns every declared attribute with its class, in name order.
    pub fn classes(&self) -> impl Iterator<Item = (&str, Sensitivity)> + '_ {
        self.classes
            .iter()
            .map(|(name, class)| (name.as_str(), *class))
    }
}

/// Joins the classes of several registries into one table. Fails, as Go
/// does, when two registries declare the same namespace.
pub(crate) fn merge_classes(
    registries: &[AppRegistry],
) -> Result<HashMap<String, Sensitivity>, Error> {
    let mut classes = HashMap::new();
    let mut declared_by: HashMap<&str, &str> = HashMap::new();
    for registry in registries {
        if let Some(first) = declared_by.insert(&registry.namespace, &registry.source) {
            return Err(Error::DuplicateAppNamespace {
                first: first.to_owned(),
                second: registry.source.clone(),
                namespace: registry.namespace.clone(),
            });
        }
        classes.extend(
            registry
                .classes
                .iter()
                .map(|(name, class)| (name.clone(), *class)),
        );
    }
    Ok(classes)
}

/// Reports whether `name` is a dotted `snake_case` name with at least two
/// segments, `^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$`
/// (go/internal/specrules).
fn valid_name(name: &str) -> bool {
    let mut segments = 0;
    for segment in name.split('.') {
        if !valid_segment(segment) {
            return false;
        }
        segments += 1;
    }
    segments >= 2
}

/// Reports whether `s` is one `snake_case` segment,
/// `^[a-z][a-z0-9]*(_[a-z0-9]+)*$`: a lowercase letter, then lowercase
/// letters and digits, where each underscore is followed by at least one of
/// them.
fn valid_segment(s: &str) -> bool {
    let bytes = s.as_bytes();
    let Some(first) = bytes.first() else {
        return false;
    };
    first.is_ascii_lowercase()
        && !s.ends_with('_')
        && !s.contains("__")
        && bytes
            .iter()
            .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

#[cfg(test)]
mod tests;
