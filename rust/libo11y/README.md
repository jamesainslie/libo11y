# libo11y

Opinionated OpenTelemetry setup for Rust services, following the
[libo11y specification](https://github.com/jamesainslie/libo11y/blob/main/docs/SPEC.md):
one builder resolves the service identity and the telemetry resource,
classifies attributes with the specification's sensitivity policy, builds
the W3C propagator, selects each signal's exporter from the standard
`OTEL_*` variables, and builds the tracer and meter providers and the
`tracing` layers that feed them, the same way the Go and TypeScript
libo11y libraries do. `setup()` installs them for the whole process;
`build()` hands them to you. Shutdown and flush are bounded by one
deadline across every signal.

Cargo features, all on by default: `otlp-http` (OTLP over HTTP, protobuf
or JSON), `otlp-grpc` (OTLP over gRPC), `tokio` (asynchronous shutdown and
shutdown on `SIGINT` and `SIGTERM`) and `log` (bridges `log` records into
the tracing stack `setup()` installs).

Licensed under the Apache License, Version 2.0.
