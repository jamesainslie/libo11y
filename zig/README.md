# libo11y Zig

In progress. The Zig implementation of the libo11y design contract
(see [docs/DESIGN.md](../docs/DESIGN.md)) is being built in steps. The
plan and its decisions are in
[docs/design/2026-11-25-libo11y-zig-design.md](../docs/design/2026-11-25-libo11y-zig-design.md).

The package builds with Zig 0.17.1. It exports one module, `o11y`, which
so far holds `o11y.version` and `o11y.spec`. `o11y.spec` is the
specification that specgen generates from `spec/registry`: attribute
keys, closed enums, event and metric names, and the sensitivity and
cardinality tables. Nothing here is ready to use, and no version is
released.

The core's internal pieces that the shared conformance cases cover are
in place, with no public API yet:

- the `service.instance.id` derivation, the PII hash token and endpoint
  sanitizing;
- a strict YAML parser for application registries, which reads a file
  the way Go's gopkg.in/yaml.v3 does, and the registry validator, which
  applies Go's rules with Go's messages.

The YAML parser differs from yaml.v3 in two cases, both about how
yaml.v3 reads its input in 512-byte chunks. A byte order mark inside the
input is content, where yaml.v3 sometimes skips one at the start of a
line. A character yaml.v3 refuses is a syntax error wherever it appears,
where yaml.v3 can report another problem first when the bad character
lies past the point where it stopped reading.

Run the checks from the repository root with `make zig-check`. The tests
include the conformance suite, which reads the repository's
`conformance/` directory. Point it elsewhere with
`zig build test -Dconformance-dir=<path>`.
