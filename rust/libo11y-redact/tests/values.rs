//! The standard library's types render their protected form, honor the
//! floor they are rendered under, and fail closed past the depth bound.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::IpAddr;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use libo11y_redact::{Masked, Protected, Protection, REDACTED, Redact, Secret};

fn render(value: &impl Redact) -> Protected {
    value.redact(Protection::Passthrough)
}

fn json(value: &impl Redact) -> String {
    serde_json::to_string(&render(value)).unwrap()
}

#[test]
fn scalars_pass_through() {
    assert_eq!(render(&42), Protected::Int(42));
    assert_eq!(render(&42_u8), Protected::Uint(42));
    assert_eq!(render(&true), Protected::Bool(true));
    assert_eq!(render(&1.5), Protected::Float(1.5));
    assert_eq!(render(&"plain"), Protected::Str("plain".into()));
    assert_eq!(render(&'c'), Protected::Str("c".into()));
    assert_eq!(render(&()), Protected::Null);
}

#[test]
fn json_of_scalars_and_none() {
    assert_eq!(json(&None::<i32>), "null");
    assert_eq!(json(&42), "42");
    assert_eq!(json(&"plain"), r#""plain""#);
    assert_eq!(json(&true), "true");
    assert_eq!(json(&vec!["a", "b"]), r#"["a","b"]"#);
    assert_eq!(json(&i128::MAX), i128::MAX.to_string());
    assert_eq!(json(&u128::MAX), u128::MAX.to_string());
}

#[test]
fn floats_json_cannot_hold_render_as_go_text() {
    assert_eq!(json(&f64::NAN), r#""NaN""#);
    assert_eq!(json(&f64::INFINITY), r#""+Inf""#);
    assert_eq!(json(&f64::NEG_INFINITY), r#""-Inf""#);
}

#[test]
fn mask_floor_masks_every_leaf() {
    assert_eq!("value".redact(Protection::Mask), Protected::masked("value"));
    assert_eq!((-12).redact(Protection::Mask), Protected::masked("-12"));
    assert_eq!(true.redact(Protection::Mask), Protected::masked("true"));
    assert_eq!(None::<&str>.redact(Protection::Mask), Protected::Null);
    assert_eq!(
        vec!["ab", "cde"].redact(Protection::Mask),
        Protected::Seq(vec![Protected::masked("ab"), Protected::masked("cde")]),
    );
}

#[test]
fn redact_and_omit_floors_redact_the_whole_value() {
    for floor in [Protection::Redact, Protection::Omit] {
        assert_eq!(vec![1, 2].redact(floor), Protected::Redacted);
        assert_eq!("value".redact(floor), Protected::Redacted);
        assert_eq!(Some(1).redact(floor), Protected::Redacted);
    }
}

#[test]
fn nested_secret_keeps_its_stricter_protection_under_a_mask_floor() {
    let items = vec![Secret::new("raw-secret"), Secret::new("x")];
    let out = items.redact(Protection::Mask);
    assert_eq!(
        out,
        Protected::Seq(vec![Protected::Redacted, Protected::Redacted])
    );
}

#[test]
fn opaque_leaves_render_as_text() {
    let ip: IpAddr = "10.1.2.3".parse().unwrap();
    assert_eq!(json(&ip), r#""10.1.2.3""#);
    assert_eq!(ip.redact(Protection::Mask).to_string(), "XXXXXXXX");
    assert_eq!(json(&Duration::from_secs(1)), r#""1s""#);
    assert_eq!(
        format!("{:?}", render(&Duration::from_millis(1500))),
        "1.5s"
    );
}

#[test]
fn hash_map_renders_sorted_by_key_text() {
    let map: HashMap<&str, i32> = [("b", 2), ("a", 1), ("c", 3)].into();
    assert_eq!(json(&map), r#"{"a":1,"b":2,"c":3}"#);
    assert_eq!(render(&map).to_string(), "{a:1 b:2 c:3}");
    let first = json(&map);
    for _ in 0..30 {
        let again: HashMap<&str, i32> = [("c", 3), ("a", 1), ("b", 2)].into();
        assert_eq!(json(&again), first);
    }
}

#[test]
fn btree_map_keeps_its_order() {
    let map: BTreeMap<i32, &str> = [(10, "ten"), (2, "two")].into();
    assert_eq!(json(&map), r#"{"2":"two","10":"ten"}"#);
}

#[test]
fn mask_floor_protects_map_keys() {
    let emails: HashMap<&str, i32> = [("alice@example.com", 1), ("bob@example.com", 2)].into();
    let out = serde_json::to_string(&emails.redact(Protection::Mask)).unwrap();
    assert!(!out.contains("alice") && !out.contains("bob"), "{out}");
}

#[test]
fn colliding_key_text_renders_by_position() {
    let map: HashMap<Secret<&str>, i32> = [(Secret::new("k1"), 1), (Secret::new("k2"), 2)].into();
    let out = json(&map);
    assert!(!out.contains("k1") && !out.contains("k2"), "{out}");
    assert_eq!(
        out,
        r#"{"0":{"key":"REDACTED","value":1},"1":{"key":"REDACTED","value":2}}"#,
    );
}

#[test]
fn hash_set_renders_sorted() {
    let set: HashSet<&str> = ["b", "a"].into();
    assert_eq!(json(&set), r#"["a","b"]"#);
}

#[test]
fn smart_pointers_and_tuples_are_transparent() {
    assert_eq!(json(&Box::new(1)), "1");
    assert_eq!(json(&Rc::new("rc")), r#""rc""#);
    assert_eq!(json(&Arc::new(Masked::new("arc"))), r#""XXX""#);
    assert_eq!(json(&(1, "two", Secret::new(3))), r#"[1,"two","REDACTED"]"#);
    assert_eq!(json(&[1, 2, 3]), "[1,2,3]");
    let dynamic: Box<dyn Redact> = Box::new(vec![Secret::new("raw")]);
    assert_eq!(json(&dynamic), r#"["REDACTED"]"#);
}

#[test]
fn deep_nesting_fails_closed() {
    fn chain(depth: usize) -> Box<dyn Redact> {
        let mut value: Box<dyn Redact> = Box::new("leaf");
        for _ in 0..depth {
            value = Box::new(value);
        }
        value
    }
    assert_eq!(render(&chain(3)).to_string(), "leaf");
    assert_eq!(render(&chain(40)).to_string(), REDACTED);
}
