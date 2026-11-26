# OTLP fixtures

Binary OTLP export requests that `zig/test/otlp_fixtures_test.zig`
decodes with the Zig bindings. protoc encodes them, not the Zig code, so
the test checks the bindings against an independent encoder.

| Fixture | Message | Source |
|---|---|---|
| `trace.binpb` | `opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest` | `trace.txtpb` |
| `metrics.binpb` | `opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest` | `metrics.txtpb` |
| `logs.binpb` | `opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest` | `logs.txtpb` |

To regenerate after editing a `.txtpb` file, run

```
zig/test/fixtures/otlp/generate.sh PROTOC PROTO_ROOT
```

with protoc 36.2 and a checkout of open-telemetry/opentelemetry-proto
v1.11.0, the release the bindings were generated from (see
`zig/src/proto/README.md`). The build no longer fetches either, because
the bindings are vendored. One way to get the sources is
`zig fetch git+https://github.com/open-telemetry/opentelemetry-proto#790608c4d51e6ffc12210b541e8514cbed9e91a4`,
which prints the package hash of a directory under the global Zig
cache. Update the assertions in the test to match.

The fixtures are test data. They are not in the published package.
