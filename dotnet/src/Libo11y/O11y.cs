using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using Libo11y.Internal;
using Libo11y.Spec;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;

namespace Libo11y;

/// <summary>
/// Entry point for libo11y .NET: one-call OpenTelemetry setup with unified configuration,
/// sensitivity policy, W3C propagation, and bounded lifecycle.
/// </summary>
public static class O11y
{
    private static readonly object GlobalLock = new();
    private static bool _globalActive;

    /// <summary>
    /// The libo11y .NET release this assembly was built from, such as <c>0.1.0</c>.
    /// Every Libo11y.* package releases at this one version.
    /// </summary>
    public static string Version { get; } = ReadVersion();

    private static string ReadVersion()
    {
        string? informational = typeof(O11y).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion;
        if (string.IsNullOrEmpty(informational)) return "0.0.0-unknown";
        // The SDK appends the source revision as SemVer build metadata.
        int plus = informational.IndexOf('+');
        return plus < 0 ? informational : informational[..plus];
    }

    public static IDisposable ForceEmit() => O11yLogRouter.EnterForceEmit();
    public static bool IsForceEmit => O11yLogRouter.IsForceEmit;
    public static O11yRecord? CurrentRecord => O11yRecord.Current;
    public static IDisposable StartRecord(out O11yRecord record) => O11yRecord.Start(out record);

    public static Telemetry Setup(O11yOptions options) => Build(options, isGlobal: true);
    public static Telemetry Init(O11yOptions options) => Build(options, isGlobal: false);

    public static void ResetGlobalForTesting()
    {
        lock (GlobalLock) _globalActive = false;
    }

    public static async Task<ShutdownReport> ShutdownOnSignalsAsync(
        Telemetry telemetry,
        Func<Task>? beforeShutdown = null,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var sigInt = PosixSignalRegistration.Create(PosixSignal.SIGINT, ctx =>
        {
            ctx.Cancel = true;
            tcs.TrySetResult();
        });
        using var sigTerm = PosixSignalRegistration.Create(PosixSignal.SIGTERM, ctx =>
        {
            ctx.Cancel = true;
            tcs.TrySetResult();
        });
        using var ctr = cancellationToken.Register(() => tcs.TrySetResult());

        await tcs.Task.ConfigureAwait(false);

        var deadline = timeout ?? telemetry.ShutdownTimeout;
        var sw = Stopwatch.StartNew();
        if (beforeShutdown is not null)
        {
            try { await beforeShutdown().ConfigureAwait(false); } catch { /* best effort */ }
        }
        var remaining = deadline - sw.Elapsed;
        if (remaining < TimeSpan.FromMilliseconds(50)) remaining = TimeSpan.FromMilliseconds(50);
        return await telemetry.ShutdownAsync(remaining).ConfigureAwait(false);
    }

    private static Sampler BuildSampler(Sampler? optSampler, IReadOnlyDictionary<string, string> env)
    {
        if (optSampler is not null) return optSampler;
        if (!env.TryGetValue("OTEL_TRACES_SAMPLER", out string? raw) || string.IsNullOrWhiteSpace(raw))
        {
            return new ParentBasedSampler(new AlwaysOnSampler());
        }
        string arg = env.TryGetValue("OTEL_TRACES_SAMPLER_ARG", out string? a) ? a.Trim() : "";
        double ParseRatio()
        {
            if (!double.TryParse(arg, NumberStyles.Float, CultureInfo.InvariantCulture, out double r) || double.IsNaN(r) || r < 0 || r > 1)
            {
                throw new ExporterException($"o11y: invalid trace ratio '{arg}'");
            }
            return r;
        }
        return raw.Trim().ToLowerInvariant() switch
        {
            "always_on" => new AlwaysOnSampler(),
            "always_off" => new AlwaysOffSampler(),
            "traceidratio" => new TraceIdRatioBasedSampler(ParseRatio()),
            "parentbased_always_on" => new ParentBasedSampler(new AlwaysOnSampler()),
            "parentbased_always_off" => new ParentBasedSampler(new AlwaysOffSampler()),
            "parentbased_traceidratio" => new ParentBasedSampler(new TraceIdRatioBasedSampler(ParseRatio())),
            var other => throw new ExporterException($"o11y: unsupported trace sampler '{other}'"),
        };
    }

    private static Telemetry Build(O11yOptions options, bool isGlobal)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (isGlobal)
        {
            lock (GlobalLock)
            {
                if (_globalActive) throw new AlreadySetupException();
            }
        }

        var envMap = O11yEnvParser.ResolveMap(options.Env);
        bool hermetic = O11yEnv.IsHermetic(options.Env);
        bool sdkDisabled = !hermetic && O11yEnvParser.IsSdkDisabled(envMap);

        var appClasses = SensitivityPolicy.LoadAppRegistries(options.AppRegistries);
        var violationRecorder = new ViolationRecorder();
        var policy = new SensitivityPolicy(options.PiiMode, options.PiiHashKey, appClasses, violationRecorder);

        var res = ResourceComposer.Build(options, envMap, policy, violationRecorder);
        var propagator = BaggageEgressPropagator.Build(options.Propagators, options.BaggageEgressAllow);

        var cfg = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["service.name"] = res.ServiceName,
            ["deployment.environment.name"] = res.Environment,
            ["service.version"] = res.ServiceVersion,
            ["service.instance.id"] = res.InstanceId,
            ["sdk.disabled"] = sdkDisabled ? "true" : "false",
        };
        if (res.ServiceVersionFallback) cfg["service_version_fallback"] = "true";

        var ownedDisposables = new List<IDisposable>();

        // 1. TracerProvider
        var sampler = BuildSampler(options.Sampler, envMap);
        string traceMode = sdkDisabled || (options.SpanExporter is null && hermetic)
            ? "none"
            : options.SpanExporter is not null
                ? "injected"
                : O11yEnvParser.ParseExporterChoice(envMap, "OTEL_TRACES_EXPORTER", "otlp");
        cfg["traces.exporter"] = traceMode;

        TracerProvider? tracerProvider = null;
        if (!sdkDisabled)
        {
            var tb = Sdk.CreateTracerProviderBuilder()
                .SetResourceBuilder(res.Builder)
                .SetSampler(sampler)
                .AddSource(res.ServiceName)
                .AddSource("libo11y*")
                .AddProcessor(new PolicyActivityProcessor(policy));

            foreach (string src in options.ActivitySources)
            {
                tb.AddSource(src);
            }

            if (options.SpanExporter is not null)
            {
                tb.AddProcessor(new SimpleActivityExportProcessor(new PolicyActivityExporter(options.SpanExporter, policy)));
            }
            else if (traceMode == "otlp")
            {
                var proto = O11yEnvParser.ParseProtocol(envMap, "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL");
                string endpoint = O11yEnvParser.SignalEndpoint(envMap, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", proto, "/v1/traces");
                cfg["traces.endpoint"] = EndpointSanitizer.Sanitize(endpoint);
                string? headers = O11yEnvParser.SignalHeaders(envMap, "OTEL_EXPORTER_OTLP_TRACES_HEADERS");
                int timeoutMs = O11yEnvParser.SignalTimeoutMs(envMap, "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT");
                int delayMs = O11yEnvParser.ParseInt(envMap, "OTEL_BSP_SCHEDULE_DELAY", 5000);
                int maxQueue = O11yEnvParser.ParseInt(envMap, "OTEL_BSP_MAX_QUEUE_SIZE", 2048);
                int maxBatch = O11yEnvParser.ParseInt(envMap, "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 512);
                int exportTimeout = O11yEnvParser.ParseInt(envMap, "OTEL_BSP_EXPORT_TIMEOUT", 30_000);

                tb.AddOtlpExporter(o =>
                {
                    o.Protocol = proto;
                    o.Endpoint = new Uri(endpoint);
                    if (headers is not null) o.Headers = headers;
                    o.TimeoutMilliseconds = timeoutMs;
                    o.ExportProcessorType = ExportProcessorType.Batch;
                    o.BatchExportProcessorOptions = new BatchExportActivityProcessorOptions
                    {
                        ScheduledDelayMilliseconds = delayMs,
                        MaxQueueSize = maxQueue,
                        MaxExportBatchSize = maxBatch,
                        ExporterTimeoutMilliseconds = exportTimeout,
                    };
                });
            }
            else if (traceMode == "console")
            {
                tb.AddConsoleExporter();
            }

            foreach (var sp in options.SpanProcessors)
            {
                tb.AddProcessor(sp);
            }

            tracerProvider = tb.Build();
        }

        // 2. MeterProvider
        var exemplarFilter = sdkDisabled
            ? ExemplarFilterMode.AlwaysOff
            : O11yEnvParser.ParseExemplarFilter(options.ExemplarFilter, envMap);
        cfg["metrics.exemplar_filter"] = exemplarFilter.ToString().ToLowerInvariant();

        string metricMode = sdkDisabled || (options.MetricReader is null && hermetic)
            ? "none"
            : options.MetricReader is not null
                ? "injected"
                : O11yEnvParser.ParseExporterChoice(envMap, "OTEL_METRICS_EXPORTER", "otlp");
        cfg["metrics.exporter"] = metricMode;

        MeterProvider? meterProvider = null;
        if (!sdkDisabled)
        {
            var mb = Sdk.CreateMeterProviderBuilder()
                .SetResourceBuilder(res.Builder)
                .AddMeter(res.ServiceName)
                .AddMeter("libo11y*");

            foreach (string mName in options.Meters)
            {
                mb.AddMeter(mName);
            }

            mb.SetExemplarFilter(exemplarFilter switch
            {
                ExemplarFilterMode.AlwaysOn => ExemplarFilterType.AlwaysOn,
                ExemplarFilterMode.AlwaysOff => ExemplarFilterType.AlwaysOff,
                _ => ExemplarFilterType.TraceBased,
            });

            if (options.RuntimeMetrics)
            {
                mb.AddRuntimeInstrumentation();
            }

            foreach (var (instName, buckets) in options.HistogramBuckets)
            {
                mb.AddView(instName, new ExplicitBucketHistogramConfiguration { Boundaries = buckets });
            }

            if (options.MetricReader is not null)
            {
                mb.AddReader(options.MetricReader);
            }
            else if (metricMode == "otlp")
            {
                var proto = O11yEnvParser.ParseProtocol(envMap, "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL");
                string endpoint = O11yEnvParser.SignalEndpoint(envMap, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", proto, "/v1/metrics");
                cfg["metrics.endpoint"] = EndpointSanitizer.Sanitize(endpoint);
                string? headers = O11yEnvParser.SignalHeaders(envMap, "OTEL_EXPORTER_OTLP_METRICS_HEADERS");
                int timeoutMs = O11yEnvParser.SignalTimeoutMs(envMap, "OTEL_EXPORTER_OTLP_METRICS_TIMEOUT");
                int intervalMs = O11yEnvParser.ParseInt(envMap, "OTEL_METRIC_EXPORT_INTERVAL", 60_000);
                int exportTimeout = O11yEnvParser.ParseInt(envMap, "OTEL_METRIC_EXPORT_TIMEOUT", 30_000);

                mb.AddOtlpExporter((o, readerOpts) =>
                {
                    o.Protocol = proto;
                    o.Endpoint = new Uri(endpoint);
                    if (headers is not null) o.Headers = headers;
                    o.TimeoutMilliseconds = timeoutMs;
                    readerOpts.PeriodicExportingMetricReaderOptions.ExportIntervalMilliseconds = intervalMs;
                    readerOpts.PeriodicExportingMetricReaderOptions.ExportTimeoutMilliseconds = exportTimeout;
                });
            }
            else if (metricMode == "console")
            {
                mb.AddConsoleExporter();
            }

            meterProvider = mb.Build();
        }

        // Wire o11y.schema.violations self-metric and flush buffered resource violations
        var selfMeter = new Meter("libo11y", Version);
        ownedDisposables.Add(selfMeter);
        var violationsCounter = selfMeter.CreateCounter<long>(
            SpecMetrics.SchemaViolations,
            unit: "{violation}",
            description: "Specification and sensitivity policy violations.");
        violationRecorder.Attach((sig, rule) =>
        {
            violationsCounter.Add(1,
                new KeyValuePair<string, object?>(SpecAttributes.Signal, sig),
                new KeyValuePair<string, object?>(SpecAttributes.Rule, rule));
        });

        // 3. LoggerProvider + ILoggerFactory
        string logMode = sdkDisabled || (options.LogExporter is null && hermetic)
            ? "none"
            : options.LogExporter is not null
                ? "injected"
                : O11yEnvParser.ParseExporterChoice(envMap, "OTEL_LOGS_EXPORTER", "otlp");
        cfg["logs.exporter"] = logMode;

        LoggerProvider? otelLoggerProvider = null;
        ILogger? otelBridgeLogger = null;
        Action<int>? logsForceFlush = null;
        Func<int, bool>? logsShutdown = null;

        if (!sdkDisabled)
        {
            var processors = new List<BaseProcessor<LogRecord>> { new PolicyLogRecordProcessor(policy) };
            SimpleLogRecordExportProcessor? injectedProc = null;
            if (options.LogExporter is not null)
            {
                injectedProc = new SimpleLogRecordExportProcessor(options.LogExporter);
                processors.Add(injectedProc);
            }

            string? otlpEndpoint = null;
            OtlpExportProtocol otlpProto = OtlpExportProtocol.HttpProtobuf;
            string? otlpHeaders = null;
            int otlpTimeoutMs = 10_000;
            int delayMs = 1000, maxQueue = 2048, maxBatch = 512, exportTimeout = 30_000;
            if (options.LogExporter is null && logMode == "otlp")
            {
                otlpProto = O11yEnvParser.ParseProtocol(envMap, "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL");
                otlpEndpoint = O11yEnvParser.SignalEndpoint(envMap, "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", otlpProto, "/v1/logs");
                cfg["logs.endpoint"] = EndpointSanitizer.Sanitize(otlpEndpoint);
                otlpHeaders = O11yEnvParser.SignalHeaders(envMap, "OTEL_EXPORTER_OTLP_LOGS_HEADERS");
                otlpTimeoutMs = O11yEnvParser.SignalTimeoutMs(envMap, "OTEL_EXPORTER_OTLP_LOGS_TIMEOUT");
                delayMs = O11yEnvParser.ParseInt(envMap, "OTEL_BLRP_SCHEDULE_DELAY", 1000);
                maxQueue = O11yEnvParser.ParseInt(envMap, "OTEL_BLRP_MAX_QUEUE_SIZE", 2048);
                maxBatch = O11yEnvParser.ParseInt(envMap, "OTEL_BLRP_MAX_EXPORT_BATCH_SIZE", 512);
                exportTimeout = O11yEnvParser.ParseInt(envMap, "OTEL_BLRP_EXPORT_TIMEOUT", 30_000);
            }

            foreach (var lp in options.LogProcessors)
            {
                processors.Add(lp);
            }

            var bridgeFactory = Microsoft.Extensions.Logging.LoggerFactory.Create(builder =>
            {
                builder.SetMinimumLevel(LogLevel.Trace);
                builder.AddOpenTelemetry(o =>
                {
                    o.SetResourceBuilder(res.Builder);
                    o.IncludeFormattedMessage = true;
                    o.IncludeScopes = true;
                    o.ParseStateValues = true;
                    foreach (var proc in processors)
                    {
                        o.AddProcessor(proc);
                    }
                    if (otlpEndpoint is not null)
                    {
                        o.AddOtlpExporter(e =>
                        {
                            e.Protocol = otlpProto;
                            e.Endpoint = new Uri(otlpEndpoint);
                            if (otlpHeaders is not null) e.Headers = otlpHeaders;
                            e.TimeoutMilliseconds = otlpTimeoutMs;
                            e.ExportProcessorType = ExportProcessorType.Batch;
                            e.BatchExportProcessorOptions = new BatchExportActivityProcessorOptions
                            {
                                ScheduledDelayMilliseconds = delayMs,
                                MaxQueueSize = maxQueue,
                                MaxExportBatchSize = maxBatch,
                                ExporterTimeoutMilliseconds = exportTimeout,
                            };
                        });
                    }
                    else if (options.LogExporter is null && logMode == "console")
                    {
                        o.AddConsoleExporter();
                    }
                });
            });
            ownedDisposables.Add(bridgeFactory);
            otelBridgeLogger = bridgeFactory.CreateLogger("libo11y");
            logsForceFlush = ms =>
            {
                foreach (var p in processors) p.ForceFlush(ms);
            };
            logsShutdown = ms =>
            {
                bridgeFactory.Dispose();
                return true;
            };
        }

        var router = new O11yLogRouter(
            policy: policy,
            otelLogger: otelBridgeLogger,
            consoleWriter: options.ConsoleWriter ?? Console.Out,
            consoleEnabled: options.ConsoleEnabled,
            consoleLevel: options.ConsoleLevel,
            attrReplacer: options.AttrReplacer,
            extraSinks: options.ExtraLogSinks);

        var loggerFactory = Microsoft.Extensions.Logging.LoggerFactory.Create(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Trace);
            builder.AddProvider(new O11yLoggerProvider(router));
        });

        // Startup canary on global setup only (before installing globals)
        if (isGlobal)
        {
            var canaryAttrs = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var (k, v) in cfg) canaryAttrs[$"o11y.config.{k}"] = v;
            try
            {
                router.Emit(
                    LogLevel.Information,
                    "telemetry configured",
                    canaryAttrs,
                    eventName: SpecEvents.TelemetryConfigured,
                    forceOverride: true,
                    throwOnSinkError: true);
            }
            catch (Exception ex)
            {
                try { tracerProvider?.Dispose(); } catch { }
                try { meterProvider?.Dispose(); } catch { }
                try { otelLoggerProvider?.Dispose(); } catch { }
                try { loggerFactory.Dispose(); } catch { }
                foreach (var d in ownedDisposables) { try { d.Dispose(); } catch { } }
                throw new CanaryRejectedException($"o11y: startup canary rejected by sink: {ex.Message}", ex);
            }

            lock (GlobalLock)
            {
                if (_globalActive)
                {
                    try { tracerProvider?.Dispose(); } catch { }
                    try { meterProvider?.Dispose(); } catch { }
                    try { otelLoggerProvider?.Dispose(); } catch { }
                    try { loggerFactory.Dispose(); } catch { }
                    throw new AlreadySetupException();
                }
                _globalActive = true;
                Sdk.SetDefaultTextMapPropagator(propagator);
            }
        }

        Action? onGlobalShutdown = isGlobal
            ? () => { lock (GlobalLock) _globalActive = false; }
            : null;

        return new Telemetry(
            tracerProvider: tracerProvider,
            meterProvider: meterProvider,
            loggerProvider: otelLoggerProvider,
            logsForceFlush: logsForceFlush,
            logsShutdown: logsShutdown,
            loggerFactory: loggerFactory,
            logRouter: router,
            propagator: propagator,
            resourceAttributes: res.Attributes,
            schemaUrl: res.SchemaUrl,
            policy: policy,
            effectiveConfig: cfg,
            shutdownTimeout: options.ShutdownTimeout,
            onGlobalShutdown: onGlobalShutdown,
            ownedDisposables: ownedDisposables);
    }
}
