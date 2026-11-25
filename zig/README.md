# libo11y Zig

In progress. The Zig implementation of the libo11y design contract
(see [docs/DESIGN.md](../docs/DESIGN.md)) is being built in steps. The
plan and its decisions are in
[docs/design/2026-11-25-libo11y-zig-design.md](../docs/design/2026-11-25-libo11y-zig-design.md).

The package builds with Zig 0.17.1. It exports one module, `o11y`, which
so far holds only `o11y.version`. Nothing here is ready to use, and no
version is released.

Run the checks from the repository root with `make zig-check`.
