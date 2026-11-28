# Changelog

All notable changes to the .NET implementation (`dotnet/`) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-28

### Added

- Multi-project .NET solution (`Libo11y.Spec`, `Libo11y`, `Libo11y.AspNetCore`, `Libo11y.Db`, `Libo11y.Testing`, `Libo11y.Cli`).
- Generated spec constants, `FrozenDictionary`/`FrozenSet` tables, and `GoPrintRanges` (spec 1.3.0), plus strict `yaml.v3`-compatible `AppRegistryValidator` passing all 46 shared conformance cases and `libo11y registry check` CLI.
- Core SDK (`O11y.Setup`, `O11y.Init`, `O11yOptions`, typed `O11yException` hierarchy, idempotent bounded concurrent `ShutdownAsync`, `ShutdownOnSignalsAsync`).
- Single `SensitivityPolicy` across resource, `Activity` spans, `O11yMeter` metrics (PII always dropped), and `ILogger`/OTLP logs, matching all shared PII hash, instance ID, and endpoint sanitization conformance vectors.
- Capture-time redaction (`Secret<T>`, `Masked<T>`, `[O11yRedact]`), wide events (`O11yRecord`), `O11y.ForceEmit`, detached propagation (`Detached`), child-process propagation (`Proc`), and `.NET` runtime instrumentation.
- Integrations: `O11yHttpMiddleware` (ASP.NET Core), `O11yHttpMessageHandler` (`HttpClient`), and `O11yDbClient` / `SqlSanitizer`.
- Hermetic test harness (`O11yRecorder` and in-process `OtlpHttpReceiver`).
- NuGet packaging for `Libo11y.Spec`, `Libo11y`, `Libo11y.AspNetCore`, `Libo11y.Db` and `Libo11y.Testing`, each with a README, symbols (`.snupkg`) and Source Link, and `Libo11y.Cli` as a .NET tool whose command is `libo11y`.
- `O11y.Version`, the release the assembly was built from. The `telemetry.distro.version` resource attribute and the version of every libo11y `Meter` and `ActivitySource` report it.

[Unreleased]: https://github.com/jamesainslie/libo11y/compare/dotnet/v0.1.0...HEAD
[0.1.0]: https://github.com/jamesainslie/libo11y/releases/tag/dotnet/v0.1.0
