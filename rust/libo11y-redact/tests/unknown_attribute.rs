//! An unknown `o11y` attribute fails closed to redact. The derive also
//! warns about it at compile time through the `deprecated` lint, which this
//! file allows so the gate's `-D warnings` keeps building it; the warning
//! itself is pinned by a `compile_fail` doc test of `libo11y-redact`.
// Fields that only render redacted or omitted are never read here.
#![allow(deprecated, dead_code)]

use libo11y_redact::{REDACTED, Redact};

#[derive(Redact)]
struct BadTag {
    #[o11y(encrypt)]
    field: String,
    #[o11y(mask = "yes")]
    valued: String,
    #[o11y()]
    empty: String,
    #[o11y]
    bare: String,
    #[o11y = "mask"]
    name_value: String,
    #[o11y(1)]
    literal: String,
    #[o11y(mask, sercet)]
    typo: String,
    #[o11y(crate = "libo11y_redact")]
    misplaced_crate: String,
    plain: String,
}

#[test]
fn unknown_attributes_fail_closed_to_redact() {
    let v = BadTag {
        field: "sensitive".into(),
        valued: "v".into(),
        empty: "e".into(),
        bare: "b".into(),
        name_value: "n".into(),
        literal: "l".into(),
        typo: "t".into(),
        misplaced_crate: "m".into(),
        plain: "shown".into(),
    };
    assert_eq!(
        v.to_string(),
        "{field:REDACTED valued:REDACTED empty:REDACTED bare:REDACTED name_value:REDACTED \
         literal:REDACTED typo:REDACTED misplaced_crate:REDACTED plain:shown}",
    );
    assert!(!serde_json::to_string(&v).unwrap().contains("sensitive"));
}

#[derive(Redact)]
#[o11y(public)]
struct UnknownContainer {
    name: String,
}

#[test]
fn unknown_container_attribute_redacts_the_whole_value() {
    assert_eq!(UnknownContainer { name: "n".into() }.to_string(), REDACTED);
}
