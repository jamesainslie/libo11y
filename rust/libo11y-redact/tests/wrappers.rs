//! Secret and Masked render protected on every surface: Display, Debug,
//! serde and tracing.

mod common;

use libo11y_redact::{Masked, Protected, Protection, REDACTED, Redact, Secret};

use common::capture_tracing;

#[test]
fn secret_renders_redacted_on_fmt_surfaces() {
    let secret = Secret::new("hunter2");
    assert_eq!(secret.to_string(), REDACTED);
    assert_eq!(format!("token={secret}"), "token=REDACTED");
    assert_eq!(format!("{secret:?}"), REDACTED);
    assert_eq!(format!("{secret:#?}"), REDACTED);
    assert_eq!(format!("{secret:>20}"), REDACTED);
}

#[test]
fn secret_of_a_number_renders_redacted() {
    let secret = Secret::new(4242_u32);
    for got in [
        format!("{secret}"),
        format!("{secret:?}"),
        format!("{secret:+}"),
    ] {
        assert_eq!(got, REDACTED);
    }
}

#[test]
fn secret_serializes_as_redacted() {
    let secret = Secret::new("hunter2");
    assert_eq!(serde_json::to_string(&secret).unwrap(), r#""REDACTED""#);
}

#[test]
fn secret_records_redacted_in_tracing() {
    let secret = Secret::new(String::from("hunter2"));
    let out = capture_tracing(|| {
        tracing::info!(display = %secret, debug = ?secret, "login");
    });
    assert!(!out.contains("hunter2"), "{out}");
    assert!(out.contains("display=REDACTED"), "{out}");
    assert!(out.contains("debug=REDACTED"), "{out}");
}

#[test]
fn secret_gives_the_value_back_explicitly() {
    let mut secret = Secret::new(String::from("hunter2"));
    assert_eq!(secret.expose(), "hunter2");
    secret.expose_mut().push('!');
    assert_eq!(secret.into_inner(), "hunter2!");
    assert_eq!(Secret::from(7).into_inner(), 7);
}

#[test]
fn secret_redacts_under_every_floor() {
    let secret = Secret::new("hunter2");
    for floor in [
        Protection::Passthrough,
        Protection::Mask,
        Protection::Redact,
        Protection::Omit,
    ] {
        assert_eq!(secret.redact(floor), Protected::Redacted);
    }
}

#[test]
fn masked_counts_chars_not_bytes() {
    let name = Masked::new("Jürgen"); // 6 chars, 7 bytes
    assert_eq!(name.to_string(), "XXXXXX");
}

#[test]
fn masked_preserves_shape_only() {
    let card = Masked::new(String::from("4111111111111111"));
    let want = "X".repeat(16);
    assert_eq!(card.to_string(), want);
    assert_eq!(format!("{card:?}"), format!("{want:?}"));
    assert_eq!(serde_json::to_string(&card).unwrap(), format!("\"{want}\""));
    let out = capture_tracing(|| tracing::info!(card = %card, "charge"));
    assert_eq!(out, format!("message=charge card={want}"));
}

#[test]
fn masked_masks_the_display_text_of_non_strings() {
    assert_eq!(Masked::new(-1234).to_string(), "XXXXX");
    let ip: std::net::IpAddr = "10.9.9.9".parse().unwrap();
    assert_eq!(Masked::new(ip).to_string(), "XXXXXXXX");
}

#[test]
fn masked_follows_the_floor() {
    let card = Masked::new("4111");
    assert_eq!(
        card.redact(Protection::Passthrough),
        Protected::Str("XXXX".into())
    );
    assert_eq!(card.redact(Protection::Mask), Protected::Str("XXXX".into()));
    assert_eq!(card.redact(Protection::Redact), Protected::Redacted);
    assert_eq!(card.redact(Protection::Omit), Protected::Redacted);
    assert_eq!(Masked::new("4111").into_inner(), "4111");
    assert_eq!(*Masked::from("4111").expose(), "4111");
}

#[test]
fn protection_orders_from_weakest_to_strictest() {
    assert!(Protection::Passthrough < Protection::Mask);
    assert!(Protection::Mask < Protection::Redact);
    assert!(Protection::Redact < Protection::Omit);
    assert_eq!(Protection::default(), Protection::Passthrough);
}
