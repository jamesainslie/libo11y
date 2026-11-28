# Changelog

All notable changes to the Java implementation of libo11y are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Multi-module Maven reactor targeting Java 21+ aligned on Spring Boot 4.2.0, OpenTelemetry Java SDK 1.68.0, Micrometer 1.18.0, and Micrometer Tracing 1.8.0 (spec 1.3.0).
- `libo11y-spec`: code-generated `Spec`, `SpecTables`, and `GoPrintRanges` plus `GoQuote` and strict `yaml.v3`-compatible `AppRegistryValidator` passing all shared `conformance/appregistry/*.yaml` cases.
- `libo11y`: core SDK (`O11y.setup` / `O11y.init`, `Telemetry`, `O11yOptions`, `O11yEnv.HERMETIC`, `SensitivityPolicy`, `PiiTokenizer`, `EndpointSanitizer`, `InstanceId`, `Redact`, `ForceEmit`, `O11yRecord`, `Detached`, `Proc`, `Signals`, JVM runtime metrics, `O11yLogbackAppender`, `O11yDataSource` + `SqlSanitizer`, and `O11yHttpClient`).
- `libo11y-micrometer`: single-pipeline `O11yMeterRegistry` with `SensitivityMeterFilter` and trace-based exemplars, `O11yMicrometerTracing` with exemplar-preserving observation handler, and `O11yObservationHandler`.
- `libo11y-spring-boot-starter`: Spring Boot 4 `@AutoConfiguration`, `@ConfigurationProperties("libo11y")`, `SmartLifecycle` graceful shutdown, `O11yFailureAnalyzer`, `O11yServletFilter`, `O11yRestClientInterceptor`, and `O11yDataSourceBeanPostProcessor`.
- `libo11y-test` and `libo11y-cli`: hermetic `O11yRecorder`, JUnit 5 `O11yExtension`, in-process `OtlpHttpReceiver`, and `libo11y registry check` CLI.
