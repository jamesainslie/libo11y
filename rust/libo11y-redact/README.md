# libo11y-redact

Capture-time redaction for [libo11y](https://o11y.ing). Sensitive values
are protected by their type, so they render protected wherever they are
logged: through `Debug`, `Display`, `serde::Serialize`, and tracing fields
recorded with `%` or `?`.

```rust
use libo11y_redact::{Masked, Redact, Secret};

let token = Secret::new("sk-live-123");
let card = Masked::new("4111111111111111");
assert_eq!(format!("{token} {card}"), "REDACTED XXXXXXXXXXXXXXXX");
assert_eq!(token.expose(), &"sk-live-123");

#[derive(Redact)]
struct Payment {
    #[o11y(mask)]
    card: String,
    #[o11y(secret)]
    cvv: String,
    #[o11y(omit)]
    pin: String,
    merchant: String,
}

let p = Payment {
    card: "4111".into(),
    cvv: "123".into(),
    pin: "9".into(),
    merchant: "acme".into(),
};
assert_eq!(p.to_string(), "{card:XXXX cvv:REDACTED merchant:acme}");
tracing::info!(payment = %p, "charged");
```

Three protections exist, from weakest to strictest:

- `mask` (or `confidential`): a run of `X` with one `X` per character,
  preserving only the value's shape (`Masked`);
- `redact` (or `secret`): the literal `REDACTED` (`Secret`);
- `omit`: the field is absent.

The strictest protection in scope wins through nesting. An unknown
attribute value fails closed to `redact` and raises a compile-time
warning. `#[derive(Redact)]` implements `Redact`, `Debug`, `Display` and
`serde::Serialize` with the protected form on all of them, so no surface
prints a protected field in the clear.

The crate's minimum supported Rust version is 1.88.

Licensed under the Apache License, Version 2.0.
