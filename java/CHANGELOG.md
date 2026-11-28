# Changelog

All notable changes to the Java implementation of libo11y are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-27

The first release. It implements spec 1.3.0.

### Added

- A multi-module Maven reactor for Java 21 and later, aligned on Spring Boot 4.2.0, OpenTelemetry Java SDK 1.68.0, Micrometer 1.18.0 and Micrometer Tracing 1.8.0.
- `libo11y-spec`: the generated `Spec`, `SpecTables` and `GoPrintRanges`, `GoQuote`, and an application registry validator that matches `yaml.v3` and passes every shared `conformance/appregistry` case.
- `libo11y`: the core SDK. `O11y.setup` and `O11y.init`, `Telemetry`, `O11yOptions` with `addView`, hermetic mode, `StructuredLogger`, `O11yRecord`, `ForceEmit`, `Redact`, `Detached`, `Proc`, `Signals`, JVM runtime metrics, `O11yLogbackAppender`, `O11yDataSource` with `SqlSanitizer`, and `O11yHttpClient`.
- The sensitivity policy on every signal. Secrets are dropped, PII follows `PiiMode`, and both rules apply to spans, to every meter and its exemplars, and to log records from any bridge on `Telemetry.loggerProvider()`. `o11y.schema.violations` counts each drop under its registered rule.
- Capture-time redaction that follows the redaction contract: `REDACTED` for a secret, a run of `X` of the same length for a mask, and the strictest protection through nested values.
- `Detached.Carrier` in the text format the Go implementation writes, so a carrier captured in one language can be resumed in another.
- `O11yDataSource` with a port of the Go SQL lexer. `db.query.text` keeps no literal and no comment, and driver error messages are never recorded.
- `libo11y-micrometer`: `O11yMeterRegistry`, which exports every Micrometer meter type through the one OpenTelemetry meter provider with `SensitivityMeterFilter` and trace-based exemplars, `O11yMicrometerTracing`, and `O11yObservationHandler`.
- `libo11y-spring-boot-starter`: Spring Boot 4 auto-configuration, `@ConfigurationProperties("libo11y")`, graceful shutdown through `SmartLifecycle`, `O11yFailureAnalyzer`, `O11yServletFilter`, `O11yRestClientInterceptor`, and `O11yDataSourceBeanPostProcessor`, which keeps each `DataSource` bean's type and opens no connection at startup.
- `libo11y-test`: the hermetic `O11yRecorder`, the JUnit 5 `O11yExtension`, and an in-process `OtlpHttpReceiver`.
- `libo11y-cli`: `libo11y registry check`, with the same output and exit statuses as the Go binary. The jar runs with `java -jar` when its dependency jars sit beside it.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/java/v0.1.0...HEAD
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/java/v0.1.0
