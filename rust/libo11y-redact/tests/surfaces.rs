//! Every surface renders the protected form, at the top level and nested
//! inside other values. Ports of Go's `surfaces_test.go`.
// Fields that only render redacted or omitted are never read in these
// tests. The derive does not read them either, as std's derived Debug
// does not count as a read.
#![allow(dead_code)]

use std::collections::HashMap;

use libo11y_redact::{REDACTED, Redact};

#[derive(Redact)]
struct Account {
    #[o11y(confidential)]
    email: String,
    role: String,
    #[o11y(mask)]
    card: String,
    #[o11y(secret)]
    token: String,
    #[o11y(omit)]
    pin: String,
    profile: Profile,
}

#[derive(Redact)]
struct Profile {
    city: String,
    #[o11y(redact)]
    ssn: String,
}

fn account() -> Account {
    Account {
        email: "alice@example.co".into(),
        role: "admin-role".into(),
        card: "4111222233334444".into(),
        token: "tok-9f8e7d".into(),
        pin: "pin-2468".into(),
        profile: Profile {
            city: "Lisbon-city".into(),
            ssn: "ssn-078051120".into(),
        },
    }
}

const RAW_PROTECTED: [&str; 5] = [
    "alice@example.co",
    "4111222233334444",
    "tok-9f8e7d",
    "pin-2468",
    "ssn-078051120",
];
const RAW_PUBLIC: [&str; 2] = ["admin-role", "Lisbon-city"];

fn assert_no_leak(surface: &str, got: &str) {
    for raw in RAW_PROTECTED {
        assert!(!got.contains(raw), "{surface} leaked {raw}: {got}");
    }
}

fn assert_protected(surface: &str, got: &str) {
    assert_no_leak(surface, got);
    for public in RAW_PUBLIC {
        assert!(got.contains(public), "{surface} lost {public}: {got}");
    }
}

#[test]
fn fmt_surfaces_render_the_protected_form() {
    #[derive(Debug)]
    #[allow(dead_code)] // read only through Debug
    struct Wrapper<'a> {
        account: &'a Account,
        label: &'static str,
    }
    let v = account();
    let surfaces = [
        ("{}", format!("{v}")),
        ("{:?}", format!("{v:?}")),
        ("{:#?}", format!("{v:#?}")),
        ("{:>80}", format!("{v:>80}")),
        ("to_string", v.to_string()),
        (
            "std derive {:?}",
            format!(
                "{:?}",
                Wrapper {
                    account: &v,
                    label: "x"
                }
            ),
        ),
        (
            "std derive {:#?}",
            format!(
                "{:#?}",
                Wrapper {
                    account: &v,
                    label: "x"
                }
            ),
        ),
        ("vec {:?}", format!("{:?}", vec![&v, &v])),
        ("option {:?}", format!("{:?}", Some(&v))),
        ("map {:?}", format!("{:?}", HashMap::from([("a", &v)]))),
        ("box {}", format!("{}", Box::new(&v))),
        (
            "error message",
            std::io::Error::other(format!("failed for {v}")).to_string(),
        ),
    ];
    for (name, got) in &surfaces {
        assert_protected(name, got);
    }
}

#[test]
fn display_form_is_deterministic() {
    let want = "{email:XXXXXXXXXXXXXXXX role:admin-role card:XXXXXXXXXXXXXXXX token:REDACTED \
                profile:{city:Lisbon-city ssn:REDACTED}}";
    let v = account();
    assert_eq!(v.to_string(), want);
    assert_eq!(
        format!("{v:>80}"),
        want,
        "formatting flags do not change the form"
    );
}

#[test]
fn json_renders_the_protected_object() {
    #[derive(serde::Serialize)]
    struct Outer<'a> {
        account: &'a Account,
    }

    let v = account();
    let out = serde_json::to_string(&v).unwrap();
    assert_protected("json", &out);
    assert_eq!(
        out,
        concat!(
            r#"{"email":"XXXXXXXXXXXXXXXX","role":"admin-role","card":"XXXXXXXXXXXXXXXX","#,
            r#""token":"REDACTED","profile":{"city":"Lisbon-city","ssn":"REDACTED"}}"#,
        ),
    );

    let nested = [
        serde_json::to_string(&Outer { account: &v }).unwrap(),
        serde_json::to_string(&vec![&v]).unwrap(),
        serde_json::to_string(&HashMap::from([("a", &v)])).unwrap(),
        serde_json::json!({ "account": &v }).to_string(),
    ];
    for out in &nested {
        assert_protected("nested json", out);
    }
}

#[test]
fn every_surface_fails_closed_past_the_depth_bound() {
    #[derive(Redact)]
    struct Deep {
        name: &'static str,
        next: Option<Box<Deep>>,
    }
    let mut v = Deep {
        name: "bottom",
        next: None,
    };
    for _ in 0..40 {
        v = Deep {
            name: "level",
            next: Some(Box::new(v)),
        };
    }
    for out in [
        v.to_string(),
        format!("{v:?}"),
        serde_json::to_string(&v).unwrap(),
    ] {
        assert!(out.contains(REDACTED) && !out.contains("bottom"), "{out}");
    }
}
