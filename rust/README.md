# libo11y Rust

In progress. The Rust implementation of the libo11y design contract is
being built as a cargo workspace in this directory, one crate at a time.
No crate has been published yet.

| Crate | Status |
|-------|--------|
| [`libo11y-macros`](libo11y-macros/) | The `#[derive(Redact)]` procedural macro, re-exported by `libo11y-redact` |
| [`libo11y-redact`](libo11y-redact/) | Capture-time redaction: `Secret`, `Masked`, the `Redact` trait and its derive |
| [`libo11y-spec`](libo11y-spec/) | The attribute keys, enums and tables, generated from `spec/registry` |

The design it implements is in [docs/DESIGN.md](../docs/DESIGN.md), the
specification in [docs/SPEC.md](../docs/SPEC.md), the conventions in
[docs/CONVENTIONS.md](../docs/CONVENTIONS.md), and the cross-language
parity matrix in [docs/PARITY.md](../docs/PARITY.md).

`make rust-check` runs the workspace's gates: formatting, clippy, the
tests and the docs. `make rust-msrv` checks the build on the minimum
supported Rust version, 1.88.
