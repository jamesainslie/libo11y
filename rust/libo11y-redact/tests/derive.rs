//! `#[derive(Redact)]` applies the `o11y` field attributes, strictest
//! protection winning through nesting. Ports of Go's redact tests where
//! they map to Rust.
// Fields that only render redacted or omitted are never read in these
// tests. The derive does not read them either, as std's derived Debug
// does not count as a read.
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::net::IpAddr;
use std::rc::Rc;
use std::time::Duration;

mod common;

use libo11y_redact::{Masked, Protected, Protection, REDACTED, Redact, Secret};

fn json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap()
}

fn json_value(value: &impl serde::Serialize) -> serde_json::Value {
    serde_json::to_value(value).unwrap()
}

#[derive(Redact)]
struct Payment {
    #[o11y(mask)]
    card: String,
    #[o11y(redact)]
    cvv: String,
    #[o11y(omit)]
    pin: String,
    merchant: String,
}

fn payment() -> Payment {
    Payment {
        card: "4111111111111111".into(),
        cvv: "123".into(),
        pin: "9876".into(),
        merchant: "ACME".into(),
    }
}

#[test]
fn field_attributes_protect_every_surface() {
    let p = payment();
    assert_eq!(
        p.to_string(),
        "{card:XXXXXXXXXXXXXXXX cvv:REDACTED merchant:ACME}"
    );
    assert_eq!(
        format!("{p:?}"),
        r#"Payment { card: "XXXXXXXXXXXXXXXX", cvv: REDACTED, merchant: "ACME" }"#,
    );
    assert_eq!(
        json(&p),
        r#"{"card":"XXXXXXXXXXXXXXXX","cvv":"REDACTED","merchant":"ACME"}"#,
    );
    let pretty = format!("{p:#?}");
    assert!(pretty.contains("    cvv: REDACTED,\n"), "{pretty}");
    assert!(!pretty.contains("pin"), "{pretty}");
}

#[test]
fn package_example_matches_go_text_form() {
    #[derive(Redact)]
    #[allow(non_snake_case, clippy::struct_field_names)]
    struct Payment {
        #[o11y(mask)]
        Card: &'static str,
        #[o11y(redact)]
        CVV: &'static str,
        #[o11y(omit)]
        PIN: &'static str,
        Merchant: &'static str,
    }
    let p = Payment {
        Card: "4111",
        CVV: "123",
        PIN: "9",
        Merchant: "acme",
    };
    assert_eq!(p.to_string(), "{Card:XXXX CVV:REDACTED Merchant:acme}");
    assert_eq!(
        json(&p),
        r#"{"Card":"XXXX","CVV":"REDACTED","Merchant":"acme"}"#
    );
}

#[derive(Redact)]
struct Account {
    owner: String,
    #[o11y(redact)]
    payment: Payment,
}

#[test]
fn strictest_wins_through_nesting() {
    let a = Account {
        owner: "gopher".into(),
        payment: payment(),
    };
    // The redact floor collapses the whole nested struct; nothing inside
    // it leaks, not even the passthrough merchant.
    assert_eq!(json(&a), r#"{"owner":"gopher","payment":"REDACTED"}"#);
}

#[derive(Redact)]
struct Leaf {
    name: String,
}

#[derive(Redact)]
struct MaskedTree {
    #[o11y(mask)]
    inner: Leaf,
}

#[test]
fn mask_floor_masks_nested_leaves() {
    let tree = MaskedTree {
        inner: Leaf {
            name: "value".into(),
        },
    };
    assert_eq!(json(&tree), r#"{"inner":{"name":"XXXXX"}}"#);
    assert_eq!(tree.to_string(), "{inner:{name:XXXXX}}");
}

#[derive(Redact)]
struct Outer {
    id: String,
    auth: AuthInfo,
}

#[derive(Redact)]
struct AuthInfo {
    #[o11y(secret)]
    token: String,
}

#[derive(Redact)]
struct MaskedOuter {
    #[o11y(mask)]
    outer: Outer,
}

#[test]
fn mask_floor_keeps_nested_redaction_instead_of_masking_its_length() {
    let v = MaskedOuter {
        outer: Outer {
            id: "o1".into(),
            auth: AuthInfo {
                token: "raw-outer-tok".into(),
            },
        },
    };
    assert_eq!(
        json(&v),
        r#"{"outer":{"id":"XX","auth":{"token":"REDACTED"}}}"#
    );
}

#[derive(Redact)]
struct TaggedAxes {
    #[o11y(secret)]
    token: String,
    #[o11y(confidential)]
    name: String,
}

#[test]
fn secret_redacts_and_confidential_masks() {
    let v = TaggedAxes {
        token: "abc".into(),
        name: "gopher".into(),
    };
    assert_eq!(v.to_string(), "{token:REDACTED name:XXXXXX}");
}

#[test]
fn boxed_and_absent_values() {
    #[derive(Redact)]
    struct Holder {
        boxed: Box<Payment>,
        absent: Option<Box<Payment>>,
    }
    let h = Holder {
        boxed: Box::new(payment()),
        absent: None,
    };
    let out = json_value(&h);
    assert_eq!(out["boxed"]["cvv"], REDACTED);
    assert_eq!(out["absent"], serde_json::Value::Null);
}

#[test]
fn containers_of_tagged_structs_are_protected() {
    #[derive(Redact)]
    struct Order {
        id: String,
        items: Vec<Payment>,
        by_name: HashMap<String, Payment>,
        fixed: [Payment; 1],
        dynamic: Box<dyn Redact>,
    }
    let o = Order {
        id: "o-1".into(),
        items: vec![payment()],
        by_name: [("primary".into(), payment())].into(),
        fixed: [payment()],
        dynamic: Box::new(vec![payment()]),
    };
    for out in [json(&o), o.to_string(), format!("{o:?}"), format!("{o:#?}")] {
        for secret in ["4111111111111111", "123", "9876"] {
            assert!(!out.contains(secret), "leaked {secret}: {out}");
        }
        assert!(out.contains("ACME"), "{out}");
    }
}

struct SelfProtected {
    _api_key: String,
}

impl Redact for SelfProtected {
    fn redact(&self, _floor: Protection) -> Protected {
        Protected::Redacted
    }
}

#[test]
fn nested_hand_written_redact_is_honored() {
    #[derive(Redact)]
    struct Config {
        auth: SelfProtected,
        token: Secret<String>,
        card: Masked<String>,
    }
    let c = Config {
        auth: SelfProtected {
            _api_key: "sk-live-secret".into(),
        },
        token: Secret::new("sk-live-xyz".into()),
        card: Masked::new("4111".into()),
    };
    assert_eq!(c.to_string(), "{auth:REDACTED token:REDACTED card:XXXX}");
}

struct IntValuer;
impl Redact for IntValuer {
    fn redact(&self, _floor: Protection) -> Protected {
        Protected::Int(8_675_309)
    }
}

struct GroupValuer;
impl Redact for GroupValuer {
    // Ignores its floor on purpose: the parent must still enforce it.
    fn redact(&self, _floor: Protection) -> Protected {
        Protected::Map(vec![
            (
                Protected::Str("token".into()),
                Protected::Str("tok-raw-123".into()),
            ),
            (Protected::Str("n".into()), Protected::Int(4_242_424_242)),
            (Protected::Str("s".into()), Protected::Redacted),
        ])
    }
}

#[test]
fn mask_floor_applies_to_everything_a_hand_written_redact_returns() {
    #[derive(Redact)]
    struct Holder {
        #[o11y(mask)]
        num: IntValuer,
        #[o11y(confidential)]
        grp: GroupValuer,
    }
    let out = json(&Holder {
        num: IntValuer,
        grp: GroupValuer,
    });
    for raw in ["8675309", "tok-raw-123", "4242424242", "token"] {
        assert!(!out.contains(raw), "leaked {raw} under a mask floor: {out}");
    }
    assert!(
        out.contains(REDACTED),
        "the nested redaction was weakened: {out}"
    );
}

#[test]
fn opaque_leaf_types_render_as_text() {
    #[derive(Redact)]
    struct Holder {
        ip: IpAddr,
        #[o11y(mask)]
        masked: IpAddr,
        wait: Duration,
        ratio: f64,
        count: u32,
        ptr: Option<u32>,
    }
    let h = Holder {
        ip: "10.1.2.3".parse().unwrap(),
        masked: "10.9.9.9".parse().unwrap(),
        wait: Duration::from_secs(1),
        ratio: f64::NAN,
        count: 3,
        ptr: None,
    };
    assert_eq!(
        json(&h),
        r#"{"ip":"10.1.2.3","masked":"XXXXXXXX","wait":"1s","ratio":"NaN","count":3,"ptr":null}"#,
    );
}

/// A type outside the crate's reach: no `Redact`, only `Display`.
struct Opaque(&'static str);

impl fmt::Display for Opaque {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "opaque:{}", self.0)
    }
}

/// A type with only `Debug`.
#[derive(Debug)]
struct DebugOnly {
    _n: u8,
}

#[test]
fn fields_without_redact_render_through_display_then_debug() {
    #[derive(Redact)]
    struct Holder {
        shown: Opaque,
        #[o11y(mask)]
        hidden: Opaque,
        debugged: DebugOnly,
    }
    let h = Holder {
        shown: Opaque("a"),
        hidden: Opaque("bc"),
        debugged: DebugOnly { _n: 7 },
    };
    assert_eq!(
        h.to_string(),
        "{shown:opaque:a hidden:XXXXXXXXX debugged:DebugOnly { _n: 7 }}"
    );
    assert_eq!(
        json(&h),
        r#"{"shown":"opaque:a","hidden":"XXXXXXXXX","debugged":"DebugOnly { _n: 7 }"}"#,
    );
}

#[test]
fn errors_render_their_protected_text() {
    #[derive(Redact)]
    struct TaggedErr {
        #[o11y(secret)]
        token: String,
    }
    impl std::error::Error for TaggedErr {}

    #[derive(Redact)]
    struct Holder {
        plain: Box<dyn std::error::Error>,
        #[o11y(mask)]
        masked: std::io::Error,
        none: Option<Box<dyn std::error::Error>>,
        tagged: Box<dyn std::error::Error>,
    }
    let h = Holder {
        plain: "conn refused".into(),
        masked: std::io::Error::other("db: conn refused"),
        none: None,
        tagged: Box::new(TaggedErr {
            token: "raw-err-tok".into(),
        }),
    };
    let out = json(&h);
    assert!(!out.contains("raw-err-tok"), "{out}");
    assert_eq!(
        out,
        r#"{"plain":"conn refused","masked":"XXXXXXXXXXXXXXXX","none":null,"tagged":"{token:REDACTED}"}"#,
    );
}

#[derive(Redact)]
struct Node {
    name: String,
    next: Option<Rc<RefCell<Node>>>,
}

#[test]
fn cycles_terminate_and_fail_closed() {
    let node = Rc::new(RefCell::new(Node {
        name: "loop".into(),
        next: None,
    }));
    node.borrow_mut().next = Some(Rc::clone(&node));
    let n = node.borrow();
    let text = n.to_string();
    assert!(text.contains("loop") && text.contains(REDACTED), "{text}");
    let out = json(&*n);
    assert!(out.contains(REDACTED), "{out}");
    drop(n);
    node.borrow_mut().next = None; // break the cycle so the nodes are freed
}

#[test]
fn recursive_types_render() {
    #[derive(Redact)]
    struct List {
        name: String,
        #[o11y(secret)]
        secret: String,
        next: Option<Box<List>>,
    }
    let l = List {
        name: "t".into(),
        secret: "raw-node-secret".into(),
        next: Some(Box::new(List {
            name: "u".into(),
            secret: "raw-2".into(),
            next: None,
        })),
    };
    assert_eq!(
        l.to_string(),
        "{name:t secret:REDACTED next:{name:u secret:REDACTED next:None}}"
    );
}

#[test]
fn map_keys_of_tagged_types_render_protected() {
    #[derive(Redact)]
    struct Holder {
        by_key: HashMap<TaggedKey, i32>,
    }

    #[derive(Redact, PartialEq, Eq, Hash)]
    struct TaggedKey {
        id: &'static str,
        #[o11y(secret)]
        token: &'static str,
    }
    let by_key: HashMap<TaggedKey, i32> = [
        (
            TaggedKey {
                id: "k1",
                token: "raw-key-tok-1",
            },
            1,
        ),
        (
            TaggedKey {
                id: "k1",
                token: "raw-key-tok-2",
            },
            2,
        ),
        (
            TaggedKey {
                id: "k2",
                token: "raw-key-tok-3",
            },
            3,
        ),
    ]
    .into();
    let out = json(&Holder { by_key });
    assert!(!out.contains("raw-key-tok"), "{out}");
    // Two keys render the same text, so the entries render by position.
    assert_eq!(
        out,
        concat!(
            r#"{"by_key":{"0":{"key":"{id:k1 token:REDACTED}","value":1},"#,
            r#""1":{"key":"{id:k1 token:REDACTED}","value":2},"#,
            r#""2":{"key":"{id:k2 token:REDACTED}","value":3}}}"#,
        ),
    );
}

#[derive(Redact)]
struct Envelope<T> {
    id: u32,
    #[o11y(mask)]
    body: T,
}

#[test]
fn generic_structs_apply_tags_of_their_arguments() {
    let with_payment = Envelope {
        id: 1,
        body: payment(),
    };
    assert_eq!(
        json(&with_payment),
        r#"{"id":1,"body":{"card":"XXXXXXXXXXXXXXXX","cvv":"REDACTED","merchant":"XXXX"}}"#,
    );
    let with_string = Envelope {
        id: 2,
        body: String::from("hello"),
    };
    assert_eq!(with_string.to_string(), "{id:2 body:XXXXX}");
    assert_eq!(
        format!("{with_string:?}"),
        r#"Envelope { id: 2, body: "XXXXX" }"#
    );
}

/// `T` only appears in a redacted field, so it needs no bound at all: the
/// value is never rendered.
#[derive(Redact)]
struct Credentials<T, const N: usize> {
    user: &'static str,
    #[o11y(secret)]
    token: T,
    #[o11y(omit)]
    scratch: [u8; N],
}

#[test]
fn type_parameters_only_in_hidden_fields_need_no_bound() {
    struct NoTraits;
    let c = Credentials {
        user: "u",
        token: NoTraits,
        scratch: [0; 4],
    };
    assert_eq!(c.to_string(), "{user:u token:REDACTED}");
}

#[derive(Redact)]
struct Borrowed<'a, T: Clone + 'a>
where
    T: fmt::Debug,
{
    #[o11y(confidential)]
    name: &'a str,
    items: &'a [T],
}

#[test]
fn lifetimes_and_where_clauses_are_kept() {
    let items = [1, 2];
    let b = Borrowed {
        name: "abc",
        items: &items,
    };
    assert_eq!(b.to_string(), "{name:XXX items:[1 2]}");
}

#[derive(Redact)]
struct Email(#[o11y(mask)] String);

#[derive(Redact)]
struct Pair(u8, #[o11y(secret)] String);

#[derive(Redact)]
struct Marker;

#[test]
fn tuple_and_unit_structs() {
    let e = Email("alice@example.com".into());
    assert_eq!(e.to_string(), "XXXXXXXXXXXXXXXXX");
    assert_eq!(format!("{e:?}"), r#"Email("XXXXXXXXXXXXXXXXX")"#);
    assert_eq!(json(&e), r#""XXXXXXXXXXXXXXXXX""#);
    let p = Pair(7, "raw".into());
    assert_eq!(p.to_string(), "(7 REDACTED)");
    assert_eq!(format!("{p:?}"), "Pair(7, REDACTED)");
    assert_eq!(json(&p), r#"[7,"REDACTED"]"#);
    assert_eq!(Marker.to_string(), "Marker");
    assert_eq!(format!("{Marker:?}"), "Marker");
    assert_eq!(json(&Marker), "null");
}

#[derive(Redact)]
enum Tender {
    Cash,
    Card {
        #[o11y(mask)]
        number: String,
        holder: String,
    },
    Voucher(#[o11y(secret)] String),
    Split(u32, #[o11y(confidential)] String),
    #[o11y(secret)]
    Wire {
        iban: String,
    },
}

#[test]
fn enums_protect_every_variant_shape() {
    let card = Tender::Card {
        number: "4111".into(),
        holder: "Ann".into(),
    };
    assert_eq!(card.to_string(), "Card{number:XXXX holder:Ann}");
    assert_eq!(
        format!("{card:?}"),
        r#"Card { number: "XXXX", holder: "Ann" }"#
    );
    assert_eq!(json(&card), r#"{"Card":{"number":"XXXX","holder":"Ann"}}"#);

    let voucher = Tender::Voucher("raw-voucher".into());
    assert_eq!(voucher.to_string(), "Voucher(REDACTED)");
    assert_eq!(json(&voucher), r#"{"Voucher":"REDACTED"}"#);

    let split = Tender::Split(2, "abc".into());
    assert_eq!(format!("{split:?}"), r#"Split(2, "XXX")"#);
    assert_eq!(json(&split), r#"{"Split":[2,"XXX"]}"#);

    assert_eq!(Tender::Cash.to_string(), "Cash");
    assert_eq!(json(&Tender::Cash), r#""Cash""#);

    // A variant attribute is a floor over all of the variant's fields.
    let wire = Tender::Wire {
        iban: "DE89370400440532013000".into(),
    };
    assert_eq!(wire.to_string(), REDACTED);
    assert_eq!(json(&wire), r#""REDACTED""#);
}

#[derive(Redact)]
#[o11y(mask)]
struct AllMasked {
    city: String,
    #[o11y(secret)]
    ssn: String,
}

#[test]
fn container_attribute_is_a_floor_over_every_field() {
    let v = AllMasked {
        city: "Lisbon".into(),
        ssn: "078-05-1120".into(),
    };
    assert_eq!(v.to_string(), "{city:XXXXXX ssn:REDACTED}");
}

#[test]
fn several_attributes_on_one_field_take_the_strictest() {
    #[derive(Redact)]
    struct Holder {
        #[o11y(mask, secret)]
        a: String,
        #[o11y(confidential)]
        #[o11y(omit)]
        b: String,
    }
    let h = Holder {
        a: "x".into(),
        b: "y".into(),
    };
    assert_eq!(h.to_string(), "{a:REDACTED}");
}

#[test]
fn redact_floor_from_the_caller_wins() {
    let p = payment();
    assert_eq!(p.redact(Protection::Redact), Protected::Redacted);
    assert_eq!(p.redact(Protection::Omit), Protected::Redacted);
    assert_eq!(
        p.redact(Protection::Mask).to_string(),
        "{card:XXXXXXXXXXXXXXXX cvv:REDACTED merchant:XXXX}",
    );
}

#[test]
fn raw_identifiers_render_without_the_prefix() {
    #[derive(Redact)]
    struct Holder {
        r#type: &'static str,
    }
    assert_eq!(json(&Holder { r#type: "a" }), r#"{"type":"a"}"#);
}

#[test]
fn derived_values_record_protected_in_tracing() {
    let p = payment();
    let out = common::capture_tracing(|| {
        tracing::info!(payment = %p, debug = ?p, "charge");
    });
    for secret in ["4111111111111111", "123", "9876"] {
        assert!(!out.contains(secret), "leaked {secret}: {out}");
    }
    assert!(
        out.contains("payment={card:XXXXXXXXXXXXXXXX cvv:REDACTED merchant:ACME}"),
        "{out}"
    );
    assert!(
        out.contains(r#"debug=Payment { card: "XXXXXXXXXXXXXXXX", cvv: REDACTED"#),
        "{out}"
    );

    let env = Envelope {
        id: 9,
        body: payment(),
    };
    let out = common::capture_tracing(|| tracing::info!(envelope = %env));
    assert!(
        !out.contains("4111") && out.contains("cvv:REDACTED"),
        "{out}"
    );
}

#[derive(Redact)]
enum Diagnosis {
    Hiv,
    Flu,
}

#[derive(Redact)]
enum Tier {
    Gold { since: u32 },
    Silver(u32),
    Bronze(u32, u32),
}

#[test]
fn mask_floor_hides_which_variant_a_value_is() {
    #[derive(Redact)]
    struct Patient {
        #[o11y(mask)]
        diagnosis: Diagnosis,
        #[o11y(mask)]
        tier: Tier,
        #[o11y(mask)]
        silver: Tier,
        #[o11y(mask)]
        bronze: Tier,
        #[o11y(mask)]
        flu: Diagnosis,
    }
    let p = Patient {
        diagnosis: Diagnosis::Hiv,
        tier: Tier::Gold { since: 2024 },
        silver: Tier::Silver(7),
        bronze: Tier::Bronze(1, 2),
        flu: Diagnosis::Flu,
    };
    for out in [p.to_string(), format!("{p:?}"), json(&p)] {
        for name in ["Hiv", "Flu", "Gold", "Silver", "Bronze", "2024"] {
            assert!(!out.contains(name), "mask floor leaked {name}: {out}");
        }
    }
    assert_eq!(
        p.to_string(),
        "{diagnosis:XXX tier:{since:XXXX} silver:X bronze:(X X) flu:XXX}",
    );
    assert_eq!(
        json(&p),
        r#"{"diagnosis":"XXX","tier":{"since":"XXXX"},"silver":"X","bronze":["X","X"],"flu":"XXX"}"#,
    );
}

/// A type with a raw `Display` for the wire and a `Redact` for telemetry.
struct ApiKey(&'static str);

impl fmt::Display for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl Redact for ApiKey {
    fn redact(&self, _floor: Protection) -> Protected {
        Protected::Redacted
    }
}

trait Source {
    type Out;
}

struct KeySource;

impl Source for KeySource {
    type Out = ApiKey;
}

#[derive(Redact)]
struct Event<S: Source> {
    out: S::Out,
    qualified: Option<<S as Source>::Out>,
}

#[test]
fn associated_type_fields_use_their_own_redact() {
    let e: Event<KeySource> = Event {
        out: ApiKey("sk-live-leak"),
        qualified: Some(ApiKey("sk-live-leak-2")),
    };
    assert_eq!(e.to_string(), "{out:REDACTED qualified:REDACTED}");
}

#[test]
fn phantom_type_parameters_need_no_bound() {
    struct User;
    #[derive(Redact)]
    struct Id<T> {
        raw: u64,
        marker: std::marker::PhantomData<T>,
    }
    let id: Id<User> = Id {
        raw: 7,
        marker: std::marker::PhantomData,
    };
    assert_eq!(id.to_string(), "{raw:7 marker:None}");
}

macro_rules! with_attrs {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        struct $name {
            #[o11y(mask)]
            card: String,
            plain: u8,
        }
    };
}

with_attrs!(
    #[derive(Redact)]
    Generated
);

#[test]
fn derive_works_on_structs_a_macro_generates() {
    let g = Generated {
        card: "4111".into(),
        plain: 1,
    };
    assert_eq!(g.to_string(), "{card:XXXX plain:1}");
}

#[test]
fn omitting_a_field_keeps_a_tuple_a_tuple() {
    #[derive(Redact)]
    struct Pair(String, #[o11y(omit)] String);
    let p = Pair("a".into(), "b".into());
    assert_eq!(p.to_string(), "(a)");
    assert_eq!(format!("{p:?}"), r#"Pair("a")"#);
    assert_eq!(json(&p), r#"["a"]"#);
}

#[test]
fn omitting_the_only_field_leaves_an_empty_tuple() {
    #[derive(Redact)]
    struct Only(#[o11y(omit)] String);
    let o = Only("raw".into());
    assert_eq!(o.to_string(), "()");
    assert_eq!(format!("{o:?}"), "Only");
    assert_eq!(json(&o), "[]");
}

/// A generic wrapper with a hand-written `Redact` and a raw `Display`.
struct Wrap<T>(T);

impl<T: Redact + Clone> Redact for Wrap<T> {
    fn redact(&self, _floor: Protection) -> Protected {
        Protected::Redacted
    }
}

impl<T: fmt::Display> fmt::Display for Wrap<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "LEAK{}", self.0)
    }
}

#[test]
fn generic_field_types_render_through_their_own_redact() {
    #[derive(Redact)]
    struct Holder<T: fmt::Display> {
        w: Wrap<T>,
    }
    assert_eq!(Holder { w: Wrap(4) }.to_string(), "{w:REDACTED}");
}

#[test]
fn secret_of_any_type_parameter_renders() {
    struct NoTraits;
    #[derive(Redact)]
    struct Tok<T> {
        s: Secret<T>,
    }
    assert_eq!(
        Tok {
            s: Secret::new(NoTraits)
        }
        .to_string(),
        "{s:REDACTED}"
    );
}

mod public_api {
    //! A public type whose rendered field has a private generic type, which
    //! puts a private type in the where clause of public impls.
    use libo11y_redact::Redact;

    #[derive(Redact)]
    struct Inner<T>(T);

    #[derive(Redact)]
    pub struct Outer<T> {
        inner: Inner<T>,
    }

    impl<T> Outer<T> {
        pub fn new(value: T) -> Self {
            Self {
                inner: Inner(value),
            }
        }
    }
}

#[test]
fn private_field_types_in_bounds_compile_cleanly() {
    assert_eq!(public_api::Outer::new(3).to_string(), "{inner:3}");
}

#[derive(Redact)]
#[o11y(mask)]
enum Status {
    Active,
    Suspended { reason: String },
    Code(u32),
    Pair(u32, u32),
}

#[derive(Redact)]
#[o11y(confidential)]
enum Condition {
    Asthma,
    Allergy { to: String },
}

fn assert_hidden(outs: &[String], names: &[&str]) {
    for out in outs {
        for name in names {
            assert!(!out.contains(name), "mask floor leaked {name}: {out}");
        }
    }
}

fn surfaces<T: Redact + fmt::Display + fmt::Debug + serde::Serialize>(v: &T) -> Vec<String> {
    vec![v.to_string(), format!("{v:?}"), json(v)]
}

#[test]
fn container_mask_hides_the_variant_name() {
    let active = Status::Active;
    assert_hidden(&surfaces(&active), &["Active"]);
    assert_eq!(active.to_string(), "XXXXXX");
    assert_eq!(json(&active), r#""XXXXXX""#);

    let suspended = Status::Suspended {
        reason: "fraud".into(),
    };
    assert_hidden(&surfaces(&suspended), &["Suspended", "fraud"]);
    assert_eq!(suspended.to_string(), "{reason:XXXXX}");
    assert_eq!(format!("{suspended:?}"), r#"Status { reason: "XXXXX" }"#);
    assert_eq!(json(&suspended), r#"{"reason":"XXXXX"}"#);

    let code = Status::Code(42);
    assert_hidden(&surfaces(&code), &["Code", "42"]);
    assert_eq!(code.to_string(), "XX");
    assert_eq!(json(&code), r#""XX""#);

    let pair = Status::Pair(1, 2);
    assert_hidden(&surfaces(&pair), &["Pair"]);
    assert_eq!(pair.to_string(), "(X X)");
    assert_eq!(json(&pair), r#"["X","X"]"#);

    let allergy = Condition::Allergy {
        to: "peanuts".into(),
    };
    assert_hidden(&surfaces(&allergy), &["Allergy", "peanuts"]);
    assert_hidden(&surfaces(&Condition::Asthma), &["Asthma"]);
    assert_eq!(Condition::Asthma.to_string(), "XXXXXX");
}

#[derive(Redact)]
enum Plan {
    Free,
    #[o11y(mask)]
    Premium,
    #[o11y(confidential)]
    Trial {
        days: u32,
    },
    #[o11y(mask)]
    Seats(u32, u32),
    #[o11y(mask)]
    Credit(u32),
}

#[test]
fn variant_mask_hides_that_variant_name() {
    assert_eq!(Plan::Free.to_string(), "Free");
    assert_eq!(json(&Plan::Free), r#""Free""#);

    let premium = Plan::Premium;
    assert_hidden(&surfaces(&premium), &["Premium"]);
    assert_eq!(premium.to_string(), "XXXXXXX");

    let trial = Plan::Trial { days: 14 };
    assert_hidden(&surfaces(&trial), &["Trial", "14"]);
    assert_eq!(trial.to_string(), "{days:XX}");
    assert_eq!(json(&trial), r#"{"days":"XX"}"#);

    let seats = Plan::Seats(3, 10);
    assert_hidden(&surfaces(&seats), &["Seats", "10"]);
    assert_eq!(seats.to_string(), "(X XX)");

    let credit = Plan::Credit(500);
    assert_hidden(&surfaces(&credit), &["Credit", "500"]);
    assert_eq!(credit.to_string(), "XXX");
}

#[test]
fn unannotated_field_holding_a_masked_enum_hides_the_variant() {
    #[derive(Redact)]
    struct Account {
        id: u32,
        status: Status,
        plan: Plan,
    }
    let account = Account {
        id: 7,
        status: Status::Suspended {
            reason: "fraud".into(),
        },
        plan: Plan::Premium,
    };
    assert_hidden(&surfaces(&account), &["Suspended", "fraud", "Premium"]);
    assert_eq!(
        account.to_string(),
        "{id:7 status:{reason:XXXXX} plan:XXXXXXX}"
    );
    let active = Account {
        id: 8,
        status: Status::Active,
        plan: Plan::Free,
    };
    assert_eq!(active.to_string(), "{id:8 status:XXXXXX plan:Free}");
}

#[test]
fn direct_mask_floor_hides_the_variant_name() {
    for (value, raw) in [
        (Diagnosis::Hiv.redact(Protection::Mask), "Hiv"),
        (Tier::Gold { since: 2024 }.redact(Protection::Mask), "Gold"),
        (Tier::Silver(7).redact(Protection::Mask), "Silver"),
        (Tier::Bronze(1, 2).redact(Protection::Mask), "Bronze"),
        (Plan::Free.redact(Protection::Mask), "Free"),
    ] {
        let outs = [value.to_string(), format!("{value:?}"), json(&value)];
        assert_hidden(&outs, &[raw, "2024"]);
    }
    assert_eq!(Diagnosis::Hiv.redact(Protection::Mask).to_string(), "XXX");
    assert_eq!(
        Tier::Gold { since: 2024 }
            .redact(Protection::Mask)
            .to_string(),
        "{since:XXXX}"
    );
    // Passthrough still names the variant.
    assert_eq!(Diagnosis::Hiv.to_string(), "Hiv");
}

#[derive(Redact)]
struct GenericNode<T> {
    val: T,
    next: Option<Box<GenericNode<T>>>,
}

#[derive(Redact)]
enum GenericTree<T> {
    Leaf(T),
    Branch(Vec<GenericTree<T>>),
    Boxed(Box<Self>),
}

#[test]
fn recursive_generic_types_compile_and_redact() {
    let list = GenericNode {
        val: Secret::new("raw-1"),
        next: Some(Box::new(GenericNode {
            val: Secret::new("raw-2"),
            next: None,
        })),
    };
    let out = list.to_string();
    assert!(!out.contains("raw-"), "{out}");
    assert_eq!(out, "{val:REDACTED next:{val:REDACTED next:None}}");

    let plain = GenericNode {
        val: 1_u32,
        next: Some(Box::new(GenericNode { val: 2, next: None })),
    };
    assert_eq!(plain.to_string(), "{val:1 next:{val:2 next:None}}");

    let tree = GenericTree::Branch(vec![
        GenericTree::Leaf(Masked::new("ab".to_owned())),
        GenericTree::Boxed(Box::new(GenericTree::Leaf(Masked::new("c".to_owned())))),
    ]);
    assert_eq!(tree.to_string(), "Branch([Leaf(XX) Boxed(Leaf(X))])");
}

#[test]
fn secret_and_phantom_of_non_redact_parameters_still_compile() {
    struct NoTraits;
    #[derive(Redact)]
    struct Holder<T> {
        secret: Secret<T>,
        marker: std::marker::PhantomData<T>,
        next: Option<Box<Holder<T>>>,
    }
    let h = Holder {
        secret: Secret::new(NoTraits),
        marker: std::marker::PhantomData,
        next: None,
    };
    assert_eq!(h.to_string(), "{secret:REDACTED marker:None next:None}");
}

#[test]
fn recursive_generic_types_bound_non_self_type_parameters_alongside_self() {
    #[derive(Redact)]
    struct PairList<T> {
        head: Option<(T, Box<PairList<T>>)>,
    }

    let list = PairList {
        head: Some((
            Secret::new("hidden"),
            Box::new(PairList {
                head: Some((
                    Secret::new("also-hidden"),
                    Box::new(PairList { head: None }),
                )),
            }),
        )),
    };
    let out = list.to_string();
    assert!(!out.contains("hidden"), "{out}");
    assert_eq!(out, "{head:[REDACTED {head:[REDACTED {head:None}]}]}");
}
