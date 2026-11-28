using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text.Json;
using Libo11y.Spec;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Logs;

namespace Libo11y.Internal;

/// <summary>
/// Classifies Activity (span), event, and link attributes on span end before leaving the process.
/// </summary>
internal sealed class PolicyActivityProcessor(SensitivityPolicy policy) : BaseProcessor<Activity>
{
    public override void OnEnd(Activity data)
    {
        var tags = data.TagObjects.ToList();
        var (classified, changed) = policy.ClassifyFlat(Signal.Traces, tags);
        if (changed)
        {
            foreach (var (k, _) in tags)
            {
                data.SetTag(k, null);
            }
            foreach (var (k, v) in classified)
            {
                data.SetTag(k, v);
            }
        }
    }
}

/// <summary>
/// Wraps an injected Activity exporter so span, event, and link tags are classified once before export.
/// </summary>
internal sealed class PolicyActivityExporter(BaseExporter<Activity> inner, SensitivityPolicy policy)
    : BaseExporter<Activity>
{
    public override ExportResult Export(in Batch<Activity> batch)
    {
        foreach (var activity in batch)
        {
            var tags = activity.TagObjects.ToList();
            var (classified, changed) = policy.ClassifyFlat(Signal.Traces, tags);
            if (changed)
            {
                foreach (var (k, _) in tags) activity.SetTag(k, null);
                foreach (var (k, v) in classified) activity.SetTag(k, v);
            }
        }
        return inner.Export(in batch);
    }

    protected override bool OnForceFlush(int timeoutMilliseconds) => inner.ForceFlush(timeoutMilliseconds);
    protected override bool OnShutdown(int timeoutMilliseconds) => inner.Shutdown(timeoutMilliseconds);
    protected override void Dispose(bool disposing)
    {
        if (disposing) inner.Dispose();
        base.Dispose(disposing);
    }
}

/// <summary>
/// Classifies attributes on direct OpenTelemetry LogRecords before export.
/// </summary>
internal sealed class PolicyLogRecordProcessor(SensitivityPolicy policy) : BaseProcessor<LogRecord>
{
    public override void OnEnd(LogRecord data)
    {
        if (data.Attributes is null || data.Attributes.Count == 0) return;
        var classified = policy.ClassifyLogAttributes(data.Attributes);
        data.Attributes = classified.Select(kv => new KeyValuePair<string, object?>(kv.Key, kv.Value)).ToList();
    }
}

/// <summary>
/// Policy-enforcing Meter wrapper that classifies attributes before recording to System.Diagnostics.Metrics
/// (so derived Views and Exemplars never see secret or PII attributes; PII is always dropped on metrics).
/// </summary>
public sealed class O11yMeter(Meter inner, SensitivityPolicy policy) : IDisposable
{
    public string Name => inner.Name;
    public Meter RawMeter => inner;

    public O11yCounter<T> CreateCounter<T>(string name, string? unit = null, string? description = null) where T : struct =>
        new(inner.CreateCounter<T>(name, unit, description), policy);

    public O11yHistogram<T> CreateHistogram<T>(string name, string? unit = null, string? description = null) where T : struct =>
        new(inner.CreateHistogram<T>(name, unit, description), policy);

    public O11yUpDownCounter<T> CreateUpDownCounter<T>(string name, string? unit = null, string? description = null) where T : struct =>
        new(inner.CreateUpDownCounter<T>(name, unit, description), policy);

    public void Dispose() => inner.Dispose();
}

public sealed class O11yCounter<T>(Counter<T> inner, SensitivityPolicy policy) where T : struct
{
    public void Add(T delta, params KeyValuePair<string, object?>[] tags)
    {
        var filtered = policy.ClassifyMetricTags(tags);
        inner.Add(delta, filtered);
    }
}

public sealed class O11yHistogram<T>(Histogram<T> inner, SensitivityPolicy policy) where T : struct
{
    public void Record(T value, params KeyValuePair<string, object?>[] tags)
    {
        var filtered = policy.ClassifyMetricTags(tags);
        inner.Record(value, filtered);
    }
}

public sealed class O11yUpDownCounter<T>(UpDownCounter<T> inner, SensitivityPolicy policy) where T : struct
{
    public void Add(T delta, params KeyValuePair<string, object?>[] tags)
    {
        var filtered = policy.ClassifyMetricTags(tags);
        inner.Add(delta, filtered);
    }
}

/// <summary>
/// Structured ILogger facade fanning out correlated, policy-classified log records to JSON console,
/// OpenTelemetry Logs (OTLP / injected exporter), and extra sinks.
/// </summary>
internal sealed class O11yLogRouter(
    SensitivityPolicy policy,
    ILogger? otelLogger,
    TextWriter? consoleWriter,
    bool consoleEnabled,
    LogLevel consoleLevel,
    AttrReplacer? attrReplacer,
    IReadOnlyList<Action<O11yLogRecord>> extraSinks)
{
    private static readonly AsyncLocal<bool> ForceEmitFlag = new();
    private static readonly AsyncLocal<bool> ReentryFlag = new();
    private readonly object _consoleLock = new();

    public static IDisposable EnterForceEmit()
    {
        bool prev = ForceEmitFlag.Value;
        ForceEmitFlag.Value = true;
        return new Scope(() => ForceEmitFlag.Value = prev);
    }

    public static bool IsForceEmit => ForceEmitFlag.Value;

    public static (int Number, string Text) MapSeverity(LogLevel level) => level switch
    {
        LogLevel.Trace => (1, "TRACE"),
        LogLevel.Debug => (5, "DEBUG"),
        LogLevel.Information => (9, "INFO"),
        LogLevel.Warning => (13, "WARN"),
        LogLevel.Error => (17, "ERROR"),
        LogLevel.Critical => (21, "FATAL"),
        _ => (9, "INFO"),
    };

    public void Emit(
        LogLevel level,
        string body,
        IEnumerable<KeyValuePair<string, object?>>? attributes,
        string? eventName = null,
        bool? forceOverride = null,
        bool throwOnSinkError = false)
    {
        if (ReentryFlag.Value) return;
        bool forced = forceOverride ?? ForceEmitFlag.Value;
        if (!forced && level < consoleLevel && otelLogger is null && extraSinks.Count == 0) return;

        ReentryFlag.Value = true;
        try
        {
            var now = DateTimeOffset.UtcNow;
            var (sevNum, sevText) = MapSeverity(level);

            var activity = Activity.Current;
            string? traceId = activity is not null && activity.TraceId != default ? activity.TraceId.ToHexString() : null;
            string? spanId = activity is not null && activity.SpanId != default ? activity.SpanId.ToHexString() : null;

            var rawAttrs = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (attributes is not null)
            {
                foreach (var (k, v) in attributes)
                {
                    if (k is "{OriginalFormat}" or "trace_id" or "span_id") continue;
                    rawAttrs[k] = v;
                }
            }
            if (!string.IsNullOrEmpty(eventName))
            {
                rawAttrs[SpecConstants.EventNameKey] = eventName;
            }

            var classified = policy.ClassifyLogAttributes(rawAttrs, attrReplacer);
            var record = new O11yLogRecord(now, now, sevNum, sevText, body, eventName, traceId, spanId, classified);

            if (consoleEnabled && consoleWriter is not null && (forced || level >= consoleLevel))
            {
                var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["time"] = now.ToString("O"),
                    ["level"] = sevText,
                    ["msg"] = body,
                };
                if (traceId is not null) payload["trace_id"] = traceId;
                if (spanId is not null) payload["span_id"] = spanId;
                foreach (var (k, v) in classified)
                {
                    if (k is "time" or "level" or "msg" or "trace_id" or "span_id") continue;
                    payload[k] = v;
                }
                string line = JsonSerializer.Serialize(payload);
                try
                {
                    lock (_consoleLock)
                    {
                        consoleWriter.WriteLine(line);
                        consoleWriter.Flush();
                    }
                }
                catch
                {
                    if (throwOnSinkError) throw;
                }
            }

            if (otelLogger is not null && (forced || level >= consoleLevel))
            {
                try
                {
                    var state = new List<KeyValuePair<string, object?>>(classified.Count + 1);
                    foreach (var (k, v) in classified)
                    {
                        state.Add(new KeyValuePair<string, object?>(k, v));
                    }
                    state.Add(new KeyValuePair<string, object?>("{OriginalFormat}", body));
                    var evId = !string.IsNullOrEmpty(eventName) ? new EventId(0, eventName) : default;
                    otelLogger.Log(level, evId, state, exception: null, formatter: (_, _) => body);
                }
                catch
                {
                    if (throwOnSinkError) throw;
                }
            }

            foreach (var sink in extraSinks)
            {
                if (!forced && level < consoleLevel) continue;
                try
                {
                    sink(record);
                }
                catch
                {
                    if (throwOnSinkError) throw;
                }
            }
        }
        finally
        {
            ReentryFlag.Value = false;
        }
    }

    private sealed class Scope(Action onDispose) : IDisposable
    {
        private bool _disposed;
        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            onDispose();
        }
    }
}

internal sealed class O11yLoggerProvider(O11yLogRouter router) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new O11yCategoryLogger(router);
    public void Dispose() { }

    private sealed class O11yCategoryLogger(O11yLogRouter router) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            string body = formatter(state, exception);
            var attrs = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (state is IEnumerable<KeyValuePair<string, object?>> kvs)
            {
                foreach (var (k, v) in kvs)
                {
                    if (k != "{OriginalFormat}") attrs[k] = v;
                }
            }
            if (exception is not null)
            {
                attrs["exception.type"] = exception.GetType().FullName ?? exception.GetType().Name;
                attrs["exception.message"] = exception.Message;
                attrs["error.type"] = exception.GetType().FullName ?? exception.GetType().Name;
            }
            router.Emit(logLevel, body, attrs, eventName: string.IsNullOrEmpty(eventId.Name) ? null : eventId.Name);
        }
    }
}
