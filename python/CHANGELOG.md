# Changelog

All notable changes to the Python `libo11y` package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `service.version` falls back to `0.0.0-unknown` when no version resolves, and the startup summary carries `o11y.config.service_version_fallback=true`, as in Go. Version 0.1.0 left the attribute off, or used the VCS revision from the build info file as the version.
- With `strict_identity=False`, `o11y.schema.violations` counts the rules `identity_service_name`, `identity_environment` and `identity_environment_invalid` that the specification names. Version 0.1.0 counted `missing_service_name`, `missing_environment` and `invalid_environment`.
- A blank `service_name`, `service_namespace`, `environment` or `version` option sets nothing, so the environment value applies. Version 0.1.0 let a blank option hide it.
- A service name is refused only when it is blank, `unknown_service`, or starts with `unknown_service:`. Version 0.1.0 refused every name that starts with `unknown_service`.
- The `InvalidEnvironment` message quotes the value the way Go does.

### Removed

- The resource no longer carries `process.pid`, `host.arch` or `os.type`. The parity matrix lists the telemetry SDK, `process.runtime.*` and `host.name` as the detected attributes, and names the pid as one the library never records.

## [0.1.0] - 2026-11-27

### Added

- Core SDK (`libo11y.setup`, `libo11y.init`, `Options`, `HERMETIC`, `Telemetry`, typed `O11yError` hierarchy) on `opentelemetry-sdk==1.45.*` for CPython 3.12, 3.13, and 3.14.
- Generated specification package (`libo11y.spec`) for spec 1.2.0, conformance vector implementations (`service.instance.id`, endpoint sanitization, HMAC-SHA256 PII tokens), and strict `yaml.v3`-compatible application attribute registry validator passing all 46 shared conformance cases.
- Unified key-based `SensitivityPolicy` across traces, metrics (pre-SDK `PolicyMeterProvider` with 2000-series cardinality caps and trace-based exemplars), logs (stdlib `logging.Handler` + isolated `_logs` bridge), and resources.
- Capture-time redaction types (`libo11y.redact.Secret`, `Masked`, `@redacted` dataclass decorator with definition-time tag validation).
- Bounded concurrent shutdown (`shutdown`, `ashutdown`, `shutdown_on_signals`, `ashutdown_on_signals`), startup canary + `effective_config()`, `event()` / `Record` wide events, `libo11y.buildinfo` CLI/reader, and zero-dependency CPython/process runtime metrics.
- Testing harness (`libo11y.testing`): hermetic `Recorder`, `assert_conforms()`, in-process `OTLPHTTPReceiver` and `OTLPGRPCReceiver`, `o11y_recorder` pytest plugin fixture, and parity suite.
- Detached and process propagation (`libo11y.detached` `Carrier`, `capture`, `start_linked`, `copy_context`; `libo11y.proc` `TRACEPARENT`/`TRACESTATE` env carriers and framed map helpers).
- HTTP integrations: `libo11y.asgi` (Starlette, FastAPI, Django), `libo11y.wsgi` (Flask, Django), `libo11y.httpx` (`SyncTransport`, `AsyncTransport`), and `libo11y.requests` (`HTTPAdapter`, `mount` without global patching).
- RPC integrations: `libo11y.grpc` (sync and `grpc.aio` server/client interceptors) and `libo11y.connect` (`connectrpc` async/sync interceptors with canonical log lines).
- Database integration: `libo11y.dbapi` DB-API 2 connection/cursor wrapper with parent-gated client spans, SQL literal sanitization for PostgreSQL/SQLite/MySQL/MariaDB, `db.client.operation.duration` with exemplars, and `psycopg_pool` connection pool metrics.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/python/v0.1.0...HEAD
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/python/v0.1.0
