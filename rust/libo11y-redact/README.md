# libo11y-redact

Capture-time redaction for [libo11y](https://o11y.ing). Sensitive values
are protected by their type, so they render protected wherever they are
logged: through `Debug`, `Display`, `serde::Serialize`, and tracing fields
recorded with `%` or `?`.

```rust
use libo11y_redact::{Masked, Secret};

let token = Secret::new("sk-live-123");
let card = Masked::new("4111111111111111");
assert_eq!(format!("{token} {card}"), "REDACTED XXXXXXXXXXXXXXXX");
assert_eq!(token.expose(), &"sk-live-123");
```

Three protections exist, from weakest to strictest:

- mask: a run of `X` with one `X` per character, preserving only the
  value's shape (`Masked`);
- redact: the literal `REDACTED` (`Secret`);
- omit: the field is absent.

The `Redact` trait renders a value's protected form under a floor that a
parent imposes, so the strictest protection wins through nesting.

The `serde` feature (on by default) adds `serde::Serialize`. The crate's
minimum supported Rust version is 1.88.

Licensed under the Apache License, Version 2.0.
