# libo11y Zig

In progress. The Zig implementation of the libo11y design contract
(see [docs/DESIGN.md](../docs/DESIGN.md)) is being built in steps. The
plan and its decisions are in
[docs/design/2026-11-25-libo11y-zig-design.md](../docs/design/2026-11-25-libo11y-zig-design.md).

The package builds with Zig 0.17.1. It exports one module, `o11y`. So
far its public API is `o11y.version`, `o11y.spec` (the specification that
specgen generates from `spec/registry`: attribute keys, closed enums,
event and metric names, and the sensitivity and cardinality tables), and
the explicit `o11y.Context` with the span identity types it carries. The
internal pipeline under `src/pipeline/` has the trace side: W3C
propagation, samplers, spans, the simple and batch processors, and
OTLP/HTTP export with protobuf or JSON, gzip, retries and TLS. It also
has the OTLP log pipeline: log records with nested values and the OTel
log record limits, the logger provider, the simple and batch log
processors, and OTLP/HTTP export to `/v1/logs`. Setup and the public
signal APIs come in later steps. Nothing here is ready to use, and no
version is released.

Dependencies, each pinned by commit:

- [zig-protobuf](https://github.com/Arwalk/zig-protobuf), the runtime for
  the OTLP bindings vendored under [src/proto/](src/proto/README.md);
- [tls.zig](https://github.com/ianic/tls.zig), for OTLP over TLS with
  client certificates.

The core's internal pieces that the shared conformance cases cover are
in place, with no public API yet:

- the `service.instance.id` derivation, the PII hash token and endpoint
  sanitizing;
- a strict YAML parser for application registries, which reads a file
  the way Go's gopkg.in/yaml.v3 does, and the registry validator, which
  applies Go's rules with Go's messages.

The YAML parser differs from yaml.v3 in three cases. Two are about how
yaml.v3 reads its input in 512-byte chunks. A byte order mark inside the
input is content, where yaml.v3 sometimes skips one at the start of a
line. A character yaml.v3 refuses is a syntax error wherever it appears,
where yaml.v3 can report another problem first when the bad character
lies past the point where it stopped reading. The third is depth: a
registry whose merges and aliases nest more than about 120 levels deep
is a syntax error, because decoding it recursively could overflow a small
stack. Go's stacks grow, so it decodes such a file.

Run the checks from the repository root with `make zig-check`. The tests
include the conformance suite, which reads the repository's
`conformance/` directory. Point it elsewhere with
`zig build test -Dconformance-dir=<path>`.
