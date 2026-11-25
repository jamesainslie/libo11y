use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::*;

/// What the validator makes of one registry file, in the `.want` format of
/// conformance/README.md.
fn outcome(bytes: &[u8]) -> String {
    match Registry::parse(bytes) {
        Err(err) => format!("parse: {}", err.kind()),
        Ok(reg) => {
            let violations = reg.validate();
            if violations.is_empty() {
                format!("ok {} {}", reg.attributes.len(), reg.namespace)
            } else {
                violations
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }
    }
}

fn kind_of(text: &str) -> String {
    match Registry::parse(text.as_bytes()) {
        Err(err) => err.kind().to_string(),
        Ok(_) => "ok".to_owned(),
    }
}

fn rule_ids(text: &str) -> Vec<&'static str> {
    Registry::parse(text.as_bytes())
        .expect("the registry parses")
        .validate()
        .iter()
        .map(|v| v.rule_id)
        .collect()
}

/// The conformance cases, or `None` outside the repository.
fn conformance_dir() -> Option<PathBuf> {
    crate::test_support::conformance("appregistry")
}

#[test]
fn passes_every_conformance_case() {
    let Some(dir) = conformance_dir() else {
        return;
    };
    let mut cases: Vec<PathBuf> = std::fs::read_dir(&dir)
        .expect("the conformance cases are readable")
        .map(|entry| entry.expect("a directory entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "yaml"))
        .collect();
    cases.sort();
    assert!(cases.len() >= 20, "found {} cases", cases.len());
    let mut failures = Vec::new();
    for path in &cases {
        let raw = std::fs::read(path).expect("the case is readable");
        let want =
            std::fs::read_to_string(path.with_extension("want")).expect("the case has a .want");
        let got = outcome(&raw);
        if got != want.trim_end_matches('\n') {
            failures.push(format!("{}:\n got: {got}\nwant: {want}", path.display()));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn every_want_has_a_case() {
    let Some(dir) = conformance_dir() else {
        return;
    };
    for entry in std::fs::read_dir(&dir).expect("the conformance cases are readable") {
        let path = entry.expect("a directory entry").path();
        if path.extension().is_some_and(|ext| ext == "want") {
            assert!(
                path.with_extension("yaml").exists(),
                "{} has no .yaml",
                path.display()
            );
        }
    }
}

const HEAD: &str = "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n";

// go/internal/appregistry/appregistry_test.go TestValidRegistry.
#[test]
fn a_valid_registry_parses() {
    let Some(dir) = conformance_dir() else {
        return;
    };
    let raw = std::fs::read(dir.join("valid.yaml")).expect("the case is readable");
    let reg = Registry::parse(&raw).expect("the registry parses");
    assert!(reg.validate().is_empty());
    assert_eq!(reg.namespace, "lor");
    assert_eq!(reg.attributes.len(), 5);
    assert_eq!(reg.attributes["lor.user.role"].values, ["studio", "client"]);
    assert_eq!(
        reg.attributes["lor.user.id"].brief,
        "The portal's opaque user ID."
    );
}

// TestParseIsStrict.
#[test]
fn parse_is_strict() {
    assert_eq!(
        kind_of("schema: libo11y.app-registry/v1\nnamespace: lor\nnamespaces: [x]\n"),
        "unknown-key"
    );
    assert_eq!(
        kind_of(&format!(
            "{HEAD}  lor.a.b: {{type: string, sensitivty: public}}\n"
        )),
        "unknown-key"
    );
    assert_eq!(
        kind_of("schema: libo11y.app-registry/v1\n---\nschema: x\n"),
        "second-document"
    );
    let malformed = Registry::parse(b"schema: libo11y.app-registry/v1\n---\nschema: [\n")
        .expect_err("a malformed second document fails");
    assert_eq!(malformed.kind(), ParseErrorKind::Syntax);
    assert!(
        malformed
            .to_string()
            .starts_with("parsing application registry:")
    );
    assert_eq!(kind_of(""), "empty");
    assert_eq!(kind_of("# nothing\n"), "empty");
}

#[test]
fn parse_errors_read_as_go_where_go_fixes_the_text() {
    let empty = Registry::parse(b"").expect_err("empty");
    assert_eq!(empty.to_string(), "application registry is empty");
    let second = Registry::parse(b"schema: a\n---\n").expect_err("two documents");
    assert_eq!(
        second.to_string(),
        "parsing application registry: an application registry holds one YAML document, found a second"
    );
    let dup = Registry::parse(b"schema: a\nschema: b\n").expect_err("a duplicate key");
    assert!(
        dup.to_string()
            .starts_with("parsing application registry: duplicate-key: "),
        "{dup}"
    );
}

// TestValidateRules.
#[test]
fn validate_applies_each_rule() {
    let cases: Vec<(String, Vec<&str>)> = vec![
        (
            "schema: libo11y.app-registry/v2\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: bounded}\n".to_owned(),
            vec!["libo11y_app_schema_unknown"],
        ),
        (
            "schema: libo11y.app-registry/v1\nnamespace: lor.portal\nattributes:\n  lor.portal.a: {type: string, sensitivity: public, cardinality: bounded}\n".to_owned(),
            vec!["libo11y_app_namespace_invalid"],
        ),
        (
            "schema: libo11y.app-registry/v1\nnamespace: http\nattributes:\n  http.thing: {type: string, sensitivity: public, cardinality: bounded}\n".to_owned(),
            vec!["libo11y_app_namespace_reserved"],
        ),
        (
            "schema: libo11y.app-registry/v1\nnamespace: oracle\nattributes:\n  oracle.db.name: {type: string, sensitivity: public, cardinality: bounded}\n".to_owned(),
            vec!["libo11y_app_namespace_reserved"],
        ),
        (
            "schema: libo11y.app-registry/v1\nnamespace: state\nattributes:\n  state.thing: {type: string, sensitivity: public, cardinality: bounded}\n".to_owned(),
            vec!["libo11y_app_namespace_reserved"],
        ),
        (
            "schema: libo11y.app-registry/v1\nnamespace: o11y\nattributes:\n  o11y.thing: {type: string, sensitivity: public, cardinality: bounded}\n".to_owned(),
            vec!["libo11y_app_namespace_reserved"],
        ),
        (
            "schema: libo11y.app-registry/v1\nnamespace: lor\n".to_owned(),
            vec!["libo11y_app_attributes_empty"],
        ),
        (
            format!("{HEAD}  acme.a.b: {{type: string, sensitivity: public, cardinality: bounded}}\n"),
            vec!["libo11y_app_attr_outside_namespace"],
        ),
        (
            format!("{HEAD}  lor.User: {{type: string, sensitivity: public, cardinality: bounded}}\n"),
            vec!["libo11y_attr_naming"],
        ),
        (
            format!("{HEAD}  lor.a.b: {{type: uuid, sensitivity: public, cardinality: bounded}}\n"),
            vec!["libo11y_app_type_unknown"],
        ),
        (
            format!("{HEAD}  lor.a.b: {{type: string, cardinality: bounded}}\n"),
            vec!["libo11y_sensitivity_missing"],
        ),
        (
            format!("{HEAD}  lor.a.b: {{type: string, sensitivity: secretish, cardinality: bounded}}\n"),
            vec!["libo11y_sensitivity_unknown"],
        ),
        (
            format!("{HEAD}  lor.a.b: {{type: string, sensitivity: public}}\n"),
            vec!["libo11y_cardinality_missing"],
        ),
        (
            format!("{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: huge}}\n"),
            vec!["libo11y_cardinality_unknown"],
        ),
        (
            format!("{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: enum}}\n"),
            vec!["libo11y_app_enum_values_missing"],
        ),
        (
            format!("{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: bounded, values: [x]}}\n"),
            vec!["libo11y_app_values_without_enum"],
        ),
        (
            format!("{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: enum, values: [\" x\"]}}\n"),
            vec!["libo11y_enum_value_whitespace"],
        ),
        (
            format!("{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: enum, values: [x, x]}}\n"),
            vec!["libo11y_enum_duplicate_value"],
        ),
    ];
    for (doc, want) in cases {
        assert_eq!(rule_ids(&doc), want, "{doc}");
    }
}

// TestValidateOrder.
#[test]
fn validate_reports_in_a_fixed_order() {
    let doc = "schema: libo11y.app-registry/v2\nnamespace: lor\nattributes:\n  lor.a: {type: uuid, cardinality: bounded}\n  lor.B: {type: string, sensitivity: public, cardinality: bounded}\n";
    assert_eq!(
        rule_ids(doc),
        [
            "libo11y_app_schema_unknown",
            "libo11y_attr_naming",
            "libo11y_app_type_unknown",
            "libo11y_sensitivity_missing",
        ]
    );
}

// TestViolationString.
#[test]
fn violations_render_as_go_renders_them() {
    let whole = Violation {
        rule_id: "libo11y_app_attributes_empty",
        attribute: None,
        detail: "the registry declares no attributes".to_owned(),
    };
    assert_eq!(
        whole.to_string(),
        "libo11y_app_attributes_empty: the registry declares no attributes"
    );
    let one = Violation {
        rule_id: "libo11y_attr_naming",
        attribute: Some("lor.User".to_owned()),
        detail: "not a dotted snake_case name".to_owned(),
    };
    assert_eq!(
        one.to_string(),
        "libo11y_attr_naming: attribute lor.User: not a dotted snake_case name"
    );
}

// go/internal/specrules/specrules_test.go TestValidName, through the rule.
#[test]
fn attribute_names_follow_the_spec_rule() {
    for (name, valid) in [
        ("o11y.outcome", true),
        ("lor.user.id", true),
        ("o11y.rum.view.name", true),
        ("o11y.cost_center", true),
        ("outcome", false),
        ("o11y.Outcome", false),
        ("o11y..outcome", false),
        ("o11y.outcome_", false),
        ("o11y.2xx", false),
        ("o11y.rum.view-name", false),
        ("o11y.a__b", false),
    ] {
        assert_eq!(valid_name(name), valid, "{name}");
    }
}

// The cases ts/packages/spec/src/yaml.test.ts decodes, which pin how yaml.v3
// reads scalars, nulls, aliases and merge keys.
#[test]
fn decodes_as_yaml_v3_decodes() {
    let reg = |text: &str| Registry::parse(text.as_bytes()).expect("the registry parses");
    let attr = |ty: &str, sensitivity: &str, cardinality: &str| Attribute {
        r#type: ty.to_owned(),
        sensitivity: sensitivity.to_owned(),
        cardinality: cardinality.to_owned(),
        ..Attribute::default()
    };

    assert_eq!(reg("---\n"), Registry::default());
    assert_eq!(reg("# c\n---\n# c\n"), Registry::default());
    assert_eq!(reg("~\n"), Registry::default());
    assert_eq!(reg("schema: ~\nnamespace: null\n"), Registry::default());
    assert_eq!(reg("~: x\n"), Registry::default());
    assert!(reg(&format!("{HEAD}  lor.a.b: ~\n")).attributes["lor.a.b"] == Attribute::default());
    assert_eq!(reg("schema: |\n  v1\nnamespace: lor\n").schema, "v1\n");
    assert_eq!(reg("schema: a\n  b\n").schema, "a b");
    let tagged = reg("schema: !!str 1.0\nnamespace: !!int 1\n");
    assert_eq!(
        (tagged.schema.as_str(), tagged.namespace.as_str()),
        ("1.0", "1")
    );

    let values = reg(&format!(
        "{HEAD}  lor.a.b: {{type: string, values: [1, true, 1.0, ~, \"q\", 'it''s']}}\n"
    ));
    assert_eq!(
        values.attributes["lor.a.b"].values,
        ["1", "true", "1.0", "q", "it's"]
    );
    assert!(
        reg(&format!("{HEAD}  1: {{type: string}}\n"))
            .attributes
            .contains_key("1")
    );

    let aliased =
        reg("schema: &s v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, brief: *s}\n");
    assert_eq!(aliased.attributes["lor.a.b"].brief, "v1");

    let merged = reg(&format!(
        "{HEAD}  lor.a.b: &base {{type: string, sensitivity: internal, cardinality: unbounded}}\n  lor.a.c: {{<<: *base, cardinality: bounded}}\n"
    ));
    assert_eq!(
        merged.attributes["lor.a.c"],
        attr("string", "internal", "bounded")
    );

    let first_wins = reg(&format!(
        "{HEAD}  lor.a.b: {{<<: [{{type: int, brief: one}}, {{type: string, sensitivity: pii}}], cardinality: bounded}}\n"
    ));
    let mut want = attr("int", "pii", "bounded");
    want.brief = "one".to_owned();
    assert_eq!(first_wins.attributes["lor.a.b"], want);

    let nested = reg(&format!(
        "{HEAD}  lor.a.b: {{<<: {{<<: {{brief: deep}}, type: int}}, cardinality: bounded}}\n"
    ));
    let mut want = attr("int", "", "bounded");
    want.brief = "deep".to_owned();
    assert_eq!(nested.attributes["lor.a.b"], want);

    let into_map = reg(
        "attributes:\n  <<: {lor.a.b: {type: string}, lor.a.c: {type: int}}\n  lor.a.b: {type: double}\n",
    );
    assert_eq!(into_map.attributes["lor.a.b"], attr("double", "", ""));
    assert_eq!(into_map.attributes["lor.a.c"], attr("int", "", ""));
}

#[test]
fn ranks_decode_problems_as_go_does() {
    for (text, want) in [
        ("schema: [libo11y\n", "syntax"),
        ("a: 1\na: 2\nb: [\n", "syntax"),
        ("schema: a\n---\nschema: b\n", "second-document"),
        ("schema: a\n---\n", "second-document"),
        ("schema: a\n---\nb: [\n", "syntax"),
        ("colour: red\n---\nx: 1\n", "unknown-key"),
        ("attributes: [x]\n---\n[\n", "type"),
        ("schema: a\nschema: b\n", "duplicate-key"),
        ("schema: a\n\"schema\": b\n", "duplicate-key"),
        ("attributes:\n  a.b: {}\n  a.b: {}\n", "duplicate-key"),
        ("attributes: [x]\nschema: a\nschema: b\n", "duplicate-key"),
        ("colour: red\nattributes: [x]\n", "unknown-key"),
        ("attributes: [x]\ncolour: red\n", "unknown-key"),
        ("true: x\n", "unknown-key"),
        ("- a\n", "type"),
        ("hello\n", "type"),
        ("schema: {a: 1}\n", "type"),
        ("attributes:\n  lor.a.b: x\n", "type"),
        ("attributes:\n  lor.a.b: {values: x}\n", "type"),
        ("attributes:\n  lor.a.b: {values: [{a: 1}]}\n", "type"),
        ("attributes:\n  lor.a.b: {<<: x, type: string}\n", "syntax"),
        ("attributes:\n  lor.a.b: {<<: ~, type: string}\n", "syntax"),
    ] {
        assert_eq!(kind_of(text), want, "{text:?}");
    }
}

// Generated by the TypeScript port from Go's appregistry.Parse and Validate.
#[test]
#[expect(clippy::too_many_lines, reason = "a table of cases")]
fn matches_go_on_edge_cases() {
    let head = HEAD.trim_end_matches("attributes:\n");
    let enum_values = |values: &str| {
        format!(
            "{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: enum, values: [a, {values}]}}\n"
        )
    };
    let cases: Vec<(String, &str)> = vec![
        (format!("{HEAD}  lor.a.b: &a {{<<: *a}}\n"), "parse: syntax"),
        (format!("{head}a: *x\nb: &x 1\n"), "parse: syntax"),
        (format!("{head}colour: *nope\n"), "parse: syntax"),
        (
            format!(
                "{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: enum, values: &v [a, *v]}}\n"
            ),
            "parse: type",
        ),
        (enum_values("\"b\u{7}\""), "parse: syntax"),
        (enum_values("\"b\u{7f}\""), "parse: syntax"),
        (enum_values("\"b\u{fffe}\""), "parse: syntax"),
        (enum_values("\"b\u{feff}c\""), "ok 1 lor"),
        ("...\n".to_owned(), "parse: syntax"),
        (format!("{head}...\nx: 1\n"), "parse: syntax"),
        (format!("{head}...\n---\n"), "parse: second-document"),
        (
            format!("{head}...\n# trailing\n"),
            "libo11y_app_attributes_empty: the registry declares no attributes",
        ),
        (
            format!("%YAML 1.1\n---\n{head}"),
            "libo11y_app_attributes_empty: the registry declares no attributes",
        ),
        (
            format!(
                "%YAML 1.1\n---\n{head}attributes: {{lor.a.b: {{<<: {{type: string}}, sensitivity: public, cardinality: bounded}}}}\n"
            ),
            "ok 1 lor",
        ),
        (enum_values("!!bool yes"), "parse: syntax"),
        (
            enum_values("!!int 0x1F, !!int \"12\", !!int 1_000, !!int 0o17, !!int -0b11"),
            "ok 1 lor",
        ),
        (
            enum_values("!!int 99999999999999999999999"),
            "parse: syntax",
        ),
        (
            enum_values(
                "!!float 12, !!float .5, !!float 1e3, !!float .inf, !!float -.NaN, !!float 1_0.5",
            ),
            "parse: syntax",
        ),
        (enum_values("!!float 1e400"), "parse: syntax"),
        (enum_values("!!null "), "ok 1 lor"),
        (enum_values("!!timestamp 2001-13-01"), "parse: syntax"),
        (
            enum_values(
                "!!timestamp 2001-12-14, !!timestamp \"2001-12-14t21:59:43.10-05:00\", !!timestamp 2001-2-3 4:05:06",
            ),
            "ok 1 lor",
        ),
        (enum_values("!!timestamp 2001-02-30"), "parse: syntax"),
        (enum_values("!!binary aGVsbG8"), "parse: syntax"),
        (enum_values("!!binary \"aGVs\\nbG8=\""), "ok 1 lor"),
        (enum_values("!foo bar"), "ok 1 lor"),
        (format!("{head}colour: !!int abc\n"), "parse: unknown-key"),
        (
            format!("{HEAD}  !!int abc: {{type: string}}\n"),
            "parse: syntax",
        ),
        (format!("{head}attributes: !!int abc\n"), "parse: syntax"),
        (
            enum_values(r#""\x41\u00e9\U0001F600\N\_\L\P\e\0\ \t\'\"\\\a\b\v\f\r\n""#),
            "libo11y_enum_value_whitespace: attribute lor.a.b: value \"A\u{e9}\u{1f600}\\u0085\\u00a0\\u2028\\u2029\\x1b\\x00 \\t'\\\"\\\\\\a\\b\\v\\f\\r\\n\"",
        ),
        (format!("{head}colour: \"\\/\"\n"), "parse: syntax"),
        (
            format!("{HEAD}  \"lor.\\/\": {{type: string}}\n"),
            "parse: syntax",
        ),
        (enum_values(r#""\U00110000""#), "parse: syntax"),
        (enum_values(r#""\x4""#), "parse: syntax"),
        (enum_values("\"b\\\n     c\""), "ok 1 lor"),
        (
            format!(
                "{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: bounded, brief: &m <<}}\n  *m : {{type: string}}\n"
            ),
            "libo11y_app_attr_outside_namespace: attribute <<: not under the lor namespace\nlibo11y_attr_naming: attribute <<: not a dotted snake_case name with at least two segments\nlibo11y_sensitivity_missing: attribute <<: no sensitivity class\nlibo11y_cardinality_missing: attribute <<: no cardinality budget",
        ),
        (
            format!(
                "%TAG !e! tag:example.com,2000:\n---\n{head}attributes: {{lor.a.b: {{type: !e!foo string, sensitivity: public, cardinality: bounded}}}}\n"
            ),
            "ok 1 lor",
        ),
        (
            format!("%YAML 1.1\n%YAML 1.1\n---\n{head}"),
            "parse: syntax",
        ),
        (
            format!(
                "{HEAD}  lor.a.b: {{<<: !!map {{type: string}}, sensitivity: public, cardinality: bounded}}\n"
            ),
            "ok 1 lor",
        ),
        (
            format!(
                "{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: bounded}}\n  <<: {{1: {{type: int}}}}\n  1: {{type: int}}\n"
            ),
            "libo11y_app_attr_outside_namespace: attribute 1: not under the lor namespace\nlibo11y_attr_naming: attribute 1: not a dotted snake_case name with at least two segments\nlibo11y_sensitivity_missing: attribute 1: no sensitivity class\nlibo11y_cardinality_missing: attribute 1: no cardinality budget",
        ),
    ];
    for (text, want) in cases {
        assert_eq!(outcome(text.as_bytes()), want, "{text:?}");
    }
}

fn utf16(text: &str, little_endian: bool, bom: bool) -> Vec<u8> {
    let units = bom
        .then_some(0xfeff_u16)
        .into_iter()
        .chain(text.encode_utf16());
    units
        .flat_map(|unit| {
            if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            }
        })
        .collect()
}

#[test]
fn reads_the_encodings_yaml_v3_reads() {
    let registry =
        format!("{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: bounded}}\n");
    let mut with_bom = vec![0xef, 0xbb, 0xbf];
    with_bom.extend_from_slice(registry.as_bytes());
    let mut odd = utf16(&registry, true, true);
    odd.push(b'a');
    let mut invalid = registry.clone().into_bytes();
    invalid.extend_from_slice(&[b'#', 0xff, b'\n']);
    for (name, bytes, want) in [
        ("UTF-8", registry.clone().into_bytes(), "ok 1 lor"),
        ("UTF-8 with a byte order mark", with_bom, "ok 1 lor"),
        ("UTF-16LE", utf16(&registry, true, true), "ok 1 lor"),
        ("UTF-16BE", utf16(&registry, false, true), "ok 1 lor"),
        (
            "UTF-16 without a byte order mark",
            utf16(&registry, true, false),
            "parse: syntax",
        ),
        ("UTF-16 with an odd byte count", odd, "parse: syntax"),
        ("invalid UTF-8", invalid, "parse: syntax"),
    ] {
        assert_eq!(outcome(&bytes), want, "{name}");
    }
    assert_eq!(kind_of(&format!("{registry}# \u{0}\n")), "syntax");
}

#[test]
fn an_alias_bomb_stops_at_the_alias_budget() {
    let mut lines = vec![format!(
        "{HEAD}  lor.a0: &a0 {{type: int, sensitivity: public, cardinality: bounded}}"
    )];
    for n in 1..=9 {
        let refs = vec![format!("*a{}", n - 1); 10].join(", ");
        lines.push(format!("  lor.a{n}: &a{n} {{<<: [{refs}]}}"));
    }
    let start = Instant::now();
    assert_eq!(kind_of(&(lines.join("\n") + "\n")), "syntax");
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "the budget stops the expansion early"
    );
}

#[test]
fn deep_nesting_stays_bounded() {
    let start = Instant::now();
    assert_eq!(
        kind_of(&format!(
            "attributes: {}{}\n",
            "[".repeat(500),
            "]".repeat(500)
        )),
        "type"
    );
    assert_eq!(
        kind_of(&format!(
            "attributes: {}{}\n",
            "[".repeat(10_001),
            "]".repeat(10_001)
        )),
        "syntax"
    );
    let mut merges = String::from("attributes:\n  lor.a.b: ");
    for _ in 0..5_000 {
        merges.push_str("{<<: ");
    }
    merges.push_str("{type: int}");
    merges.push_str(&"}".repeat(5_000));
    merges.push('\n');
    assert_eq!(kind_of(&merges), "syntax");
    assert!(start.elapsed() < Duration::from_secs(10));
}

#[test]
fn app_registries_load_from_bytes_and_paths() {
    let Some(dir) = conformance_dir() else {
        return;
    };
    let valid = std::fs::read(dir.join("valid.yaml")).expect("the case is readable");
    let reg = AppRegistry::from_bytes("valid.yaml", &valid).expect("the registry is valid");
    assert_eq!(reg.source(), "valid.yaml");
    assert_eq!(reg.namespace(), "lor");
    assert_eq!(
        reg.sensitivity_of("lor.client.email"),
        Some(Sensitivity::Pii)
    );
    assert_eq!(
        reg.sensitivity_of("lor.user.id"),
        Some(Sensitivity::Internal)
    );
    assert_eq!(reg.sensitivity_of("lor.unlisted"), None);
    assert_eq!(reg.classes().count(), 5);

    let from_path = AppRegistry::from_path(dir.join("valid.yaml")).expect("the file is valid");
    assert_eq!(from_path.namespace(), "lor");

    let missing = AppRegistry::from_path("no-such-registry.yaml").expect_err("the file is missing");
    assert_eq!(
        missing.to_string(),
        "o11y: reading application registry: open no-such-registry.yaml: no such file or directory"
    );
    assert!(!missing.is_invalid_app_registry());

    let unparsed =
        AppRegistry::from_bytes("bad.yaml", b"schema: [x\n").expect_err("a syntax error");
    assert!(matches!(&unparsed, Error::ParseAppRegistry { path, .. } if path == "bad.yaml"));
    assert!(
        unparsed
            .to_string()
            .starts_with("o11y: bad.yaml: parsing application registry: syntax: ")
    );

    let invalid = AppRegistry::from_bytes(
        "bad.yaml",
        b"schema: x\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: bounded}\n",
    )
    .expect_err("an invalid registry");
    assert_eq!(
        invalid.to_string(),
        "o11y: invalid application registry: bad.yaml: libo11y_app_schema_unknown: schema \"x\", want \"libo11y.app-registry/v1\""
    );
    assert!(invalid.is_invalid_app_registry());
}

#[test]
fn several_registries_merge_unless_they_share_a_namespace() {
    let lor = AppRegistry::from_bytes(
        "lor.yaml",
        b"schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: secret, cardinality: bounded}\n",
    )
    .expect("valid");
    let shop = AppRegistry::from_bytes(
        "shop.yaml",
        b"schema: libo11y.app-registry/v1\nnamespace: shop\nattributes:\n  shop.order.id: {type: string, sensitivity: pii, cardinality: unbounded}\n",
    )
    .expect("valid");
    let classes = merge_classes(&[lor.clone(), shop]).expect("distinct namespaces");
    assert_eq!(classes.get("lor.a.b"), Some(&Sensitivity::Secret));
    assert_eq!(classes.get("shop.order.id"), Some(&Sensitivity::Pii));

    let again = AppRegistry::from_bytes(
        "again.yaml",
        b"schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.c.d: {type: string, sensitivity: public, cardinality: bounded}\n",
    )
    .expect("valid");
    let err = merge_classes(&[lor, again]).expect_err("a shared namespace");
    assert_eq!(
        err.to_string(),
        "o11y: invalid application registry: lor.yaml and again.yaml both declare namespace \"lor\""
    );
    assert!(err.is_invalid_app_registry());
}

// Where libyaml-safer, a port of a newer libyaml, reads text differently
// from yaml.v3 or panics, the decoder mends it. The outcomes are Go's.
#[test]
fn mends_where_libyaml_safer_differs_from_yaml_v3() {
    let block = |header: &str, body: &str| {
        format!(
            "{HEAD}  lor.a.c:\n    type: string\n    sensitivity: public\n    cardinality: enum\n    values:\n    - {header}\n{body}"
        )
    };
    let cases: Vec<(String, &str)> = vec![
        // A block scalar that ends the stream without a line break.
        (block("|", "      x"), "ok 1 lor"),
        (block("|+", "      x"), "ok 1 lor"),
        (block("|-", "      x"), "ok 1 lor"),
        (block(">", "      x\n      y"), "ok 1 lor"),
        (
            block("|+", "      x\n      "),
            "libo11y_enum_value_whitespace: attribute lor.a.c: value \"x\\n\"",
        ),
        (
            block("|", "      x\n      "),
            "libo11y_enum_value_whitespace: attribute lor.a.c: value \"x\\n\"",
        ),
        // yaml.v3 reads a colon a flow indicator follows into the scalar.
        (
            format!(
                "{HEAD}  lor.user.role: {{type: string, sensitivity:, public, cardinality: ounded, values: [studio]}}\n"
            ),
            "parse: unknown-key",
        ),
        // yaml.v3 lets a tag run on through `[` and `,`.
        (
            format!(
                "{HEAD}  lor.user.role: {{type: tring, sensitivity: public, cardinality: enum, values: [studio, !![null client]}}\n"
            ),
            "libo11y_app_type_unknown: attribute lor.user.role: type \"tring\"",
        ),
        (
            format!(
                "{HEAD}  lor.user.role: {{type: string, sensitivity: public, cardinality: enum, values: [studio, \" studio\", !!client, client]}}\n"
            ),
            "libo11y_enum_value_whitespace: attribute lor.user.role: value \" studio\"\nlibo11y_enum_duplicate_value: attribute lor.user.role: value \" studio\"",
        ),
        (
            format!(
                "{HEAD}  lor.a.b: {{type: string, sensitivity: public, cardinality: enum, values: [!<tag:yaml.org,2002:str>, x]}}\n"
            ),
            "parse: syntax",
        ),
        // yaml.v3 ends a flow plain scalar at `?`.
        (
            format!(
                "{HEAD}  lor.user.id: {{type: st?ring, sensitivity: internal, cardinality: huge}}\n"
            ),
            "parse: syntax",
        ),
        // yaml.v3's scanner reads two tokens ahead, so a scanner error just
        // past the first document beats that document's decode problems.
        (
            "schemma: libo11y.app-registry/v1\n---\nsc--\nschema: x\n".to_owned(),
            "parse: syntax",
        ),
        // A backslash that ends the stream inside a double-quoted scalar.
        (format!("{HEAD}  lor.a.b: {{brief: \"x\\"), "parse: syntax"),
    ];
    for (text, want) in cases {
        assert_eq!(outcome(text.as_bytes()), want, "{text:?}");
    }
}

// Mapping scan offsets back to the text must not grow with the number of
// tag-like commas, and the rewrites are bounded.
#[test]
fn many_tag_like_commas_parse_in_linear_time() {
    let mut text = String::from(
        "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [a]}\nx:\n",
    );
    for _ in 0..20_000 {
        text.push_str("  - x!a,\n");
    }
    for _ in 0..40 {
        text.push_str("  - \"a\\'b\"\n");
    }
    let start = Instant::now();
    assert_eq!(kind_of(&text), "unknown-key");
    assert!(
        start.elapsed() < Duration::from_secs(10),
        "{:?}",
        start.elapsed()
    );
}
