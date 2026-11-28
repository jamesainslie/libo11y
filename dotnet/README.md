# libo11y (.NET)

Opinionated, elegant observability for .NET built purely on OpenTelemetry (`OpenTelemetry` 1.21.0, `System.Diagnostics.Activity`, `System.Diagnostics.Metrics`, and `Microsoft.Extensions.Logging`). Targets `.NET 10`.

## Packages

| Project | Purpose |
|---|---|
| `Libo11y.Spec` | Generated spec constants, enums, tables, `GoQuote`, and strict `yaml.v3`-compatible `AppRegistryValidator` |
| `Libo11y` | Core SDK (`O11y.Setup` / `O11y.Init` -> `Telemetry`), sensitivity policy, capture-time `Redact` (`Secret<T>`, `Masked<T>`, `[O11yRedact]`), `ILogger` bridge, `ForceEmit`, `O11yRecord`, `Detached`, `Proc`, `ShutdownOnSignalsAsync` |
| `Libo11y.AspNetCore` | `O11yHttpMiddleware` (`app.UseO11y(...)`) and `O11yHttpMessageHandler` (`HttpClient` `DelegatingHandler`) |
| `Libo11y.Db` | `O11yDbClient` and `SqlSanitizer` (parent-gated spans, literal sanitization, `db.client.operation.duration` with exemplars) |
| `Libo11y.Testing` | Hermetic `O11yRecorder` (`AssertConforms`, `AssertCorrelated`, `AssertTriangle`) and in-process `OtlpHttpReceiver` |
| `Libo11y.Cli` | `libo11y registry check FILE...` CLI tool |

## Quick start

```csharp
using System.Diagnostics;
using Libo11y;
using Libo11y.Spec;
using Microsoft.Extensions.Logging;

await using var telemetry = O11y.Setup(new O11yOptions
{
    ServiceName = "checkout",
    Version = "1.2.0",
    Environment = DeploymentEnvironment.Production,
});

using var source = new ActivitySource("checkout");
using (var span = source.StartActivity("startup"))
{
    telemetry.Logger.LogInformation("ready"); // correlated with active Activity
}
```

Use `O11y.Init(options)` for non-global handles in tests and dependency injection.

### Graceful shutdown on signals

```csharp
var report = await O11y.ShutdownOnSignalsAsync(telemetry, beforeShutdown: () => app.StopAsync());
```

### Registry CLI

```sh
dotnet run --project dotnet/src/Libo11y.Cli -- registry check o11y-registry.yaml
```

## Per-signal guarantees and caveats

- **Traces:** `PolicyActivityProcessor` and `PolicyActivityExporter` classify span attributes before leaving the process.
- **Metrics:** `O11yMeter` classifies attributes before recording to `System.Diagnostics.Metrics` (covering derived Views and exemplars). PII is always dropped on metrics even under `PiiMode.Hash`. Trace-based exemplars and `.NET` runtime metrics are enabled by default.
- **Logs:** `O11yLoggerProvider` and `Telemetry.Log` apply capture-time redaction, user `AttrReplacer`, and `SensitivityPolicy` (depth 16, cycle detection, 2048-node budget) to JSON console output, OTLP logs, and extra sinks. Direct OpenTelemetry `LogRecord` emissions pass through `PolicyLogRecordProcessor`.
- **Policy scope (shared across all languages):** Key-based classification does not inspect log message templates/bodies, span display names, instrumentation scope attributes, map-valued span/metric members, attributes read at `OnStart`, or baggage. Use `Secret<T>`, `Masked<T>`, and `[O11yRedact]` for values under unclassified keys.
- **OTLP protocols:** Supports both `http/protobuf` (default) and `grpc`.
