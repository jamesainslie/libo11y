# libo11y

Opinionated OpenTelemetry setup for Rust services, following the
[libo11y specification](https://github.com/jamesainslie/libo11y/blob/main/docs/SPEC.md):
one builder resolves the service identity and the telemetry resource,
classifies attributes with the specification's sensitivity policy, and
builds the W3C propagator, the same way the Go and TypeScript libo11y
libraries do.

This crate is in progress and has not been published yet.

Licensed under the Apache License, Version 2.0.
