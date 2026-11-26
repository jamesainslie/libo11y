# libo11y-macros

The `#[derive(Redact)]` procedural macro of [libo11y](https://o11y.ing).

Depend on [`libo11y-redact`](https://crates.io/crates/libo11y-redact)
instead: it re-exports the derive together with the runtime the derive
expands to, and documents the `o11y` field attributes (`mask`, `redact`,
`omit`, `confidential`, `secret`). The two crates are released together
at the same version.

The crate's minimum supported Rust version is 1.88.

Licensed under the Apache License, Version 2.0.
