# libo11y-test

Hermetic test harness for asserting the telemetry a Rust service emits through
`libo11y`: spans, metrics (with exemplars), and structured logs, plus
conformance, correlation, and correlation-triangle checks and in-process OTLP
HTTP and gRPC receivers for wire-level integration tests.

- `Recorder::start("my-service")` builds a fully in-memory `libo11y::Sdk` with
  `without_otel_env()`, touching no process globals and remaining safe under
  parallel tests.
- `Recorder::assert_conforms()` verifies tier-0 resource attributes, zero
  `secret_attribute` violations across signals, zero spec-table secrets in the
  clear on logs or spans, and registered event contracts.
- `Recorder::assert_correlated()` and `Recorder::assert_triangle("metric")`
  verify trace correlation across spans, logs, and metric exemplars.
- `OtlpHttpReceiver` and `OtlpGrpcReceiver` run loopback collectors on
  ephemeral ports for end-to-end OTLP wire testing.

Licensed under the Apache License, Version 2.0.
