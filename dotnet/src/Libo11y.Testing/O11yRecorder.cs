using System.Diagnostics;
using System.Text.Json;
using Libo11y.Spec;
using OpenTelemetry;
using OpenTelemetry.Exporter;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;

namespace Libo11y.Testing;

public sealed class O11yAssertionException(string message) : Exception(message);

public sealed record RecordedExemplar(string MetricName, string TraceId, string SpanId, double Value);

public sealed record RecordedOtlpLog(
    DateTime Timestamp,
    string TraceId,
    string SpanId,
    string Body,
    string? EventName,
    IReadOnlyDictionary<string, object?> Attributes);

/// <summary>
/// Hermetic in-memory test recorder: never mutates globals and always runs in O11yEnv.Hermetic.
/// </summary>
public sealed class O11yRecorder : IDisposable
{
    private readonly List<Activity> _spans = [];
    private readonly List<Metric> _metrics = [];
    private readonly List<RecordedOtlpLog> _logs = [];
    private readonly StringWriter _consoleWriter = new();
    private readonly List<O11yLogRecord> _sinkRecords = [];

    public Telemetry Telemetry { get; }
    public IReadOnlyList<O11yLogRecord> SinkRecords => _sinkRecords;

    private sealed class CopyingLogExporter(List<RecordedOtlpLog> sink) : BaseExporter<LogRecord>
    {
        public override ExportResult Export(in Batch<LogRecord> batch)
        {
            lock (sink)
            {
                foreach (var lr in batch)
                {
                    var attrs = new Dictionary<string, object?>(StringComparer.Ordinal);
                    if (lr.Attributes is not null)
                    {
                        foreach (var (k, v) in lr.Attributes) attrs[k] = v;
                    }
                    sink.Add(new RecordedOtlpLog(
                        lr.Timestamp,
                        lr.TraceId.ToHexString(),
                        lr.SpanId.ToHexString(),
                        lr.FormattedMessage ?? lr.Body ?? "",
                        string.IsNullOrEmpty(lr.EventId.Name) ? null : lr.EventId.Name,
                        attrs));
                }
            }
            return ExportResult.Success;
        }
    }

    public O11yRecorder(Action<O11yOptions>? configure = null)
    {
        var opts = new O11yOptions
        {
            ServiceName = "test-service",
            Environment = DeploymentEnvironment.Test,
            Version = "1.0.0",
            Env = O11yEnv.Hermetic,
            RuntimeMetrics = false,
            ConsoleWriter = _consoleWriter,
            SpanExporter = new InMemoryExporter<Activity>(_spans),
            MetricReader = new BaseExportingMetricReader(new InMemoryExporter<Metric>(_metrics)),
            LogExporter = new CopyingLogExporter(_logs),
        };
        opts.ExtraLogSinks.Add(rec => { lock (_sinkRecords) _sinkRecords.Add(rec); });
        configure?.Invoke(opts);
        // Always enforce hermetic env and in-memory exporters
        opts.Env = O11yEnv.Hermetic;
        opts.SpanExporter ??= new InMemoryExporter<Activity>(_spans);
        opts.MetricReader ??= new BaseExportingMetricReader(new InMemoryExporter<Metric>(_metrics));
        opts.LogExporter ??= new CopyingLogExporter(_logs);
        opts.ConsoleWriter ??= _consoleWriter;

        Telemetry = O11y.Init(opts);
    }

    public IReadOnlyList<Activity> Spans()
    {
        Telemetry.ForceFlush();
        return [.. _spans];
    }

    public IReadOnlyList<RecordedOtlpLog> Logs()
    {
        Telemetry.ForceFlush();
        lock (_logs) return [.. _logs];
    }

    public IReadOnlyList<Metric> Metrics()
    {
        _metrics.Clear();
        Telemetry.ForceFlush();
        return [.. _metrics];
    }

    public IReadOnlyList<Dictionary<string, JsonElement>> ConsoleRecords()
    {
        var result = new List<Dictionary<string, JsonElement>>();
        foreach (string line in _consoleWriter.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            string trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            var dict = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(trimmed);
            if (dict is not null) result.Add(dict);
        }
        return result;
    }

    public IReadOnlyList<RecordedExemplar> Exemplars(string? metricName = null)
    {
        var list = new List<RecordedExemplar>();
        foreach (var metric in Metrics())
        {
            if (metricName is not null && metric.Name != metricName) continue;
            foreach (ref readonly var mp in metric.GetMetricPoints())
            {
                if (!mp.TryGetExemplars(out var exemplars)) continue;
                foreach (ref readonly var ex in exemplars)
                {
                    if (ex.TraceId == default) continue;
                    double val = metric.MetricType is MetricType.DoubleSum or MetricType.DoubleGauge or MetricType.Histogram
                        ? ex.DoubleValue
                        : ex.LongValue;
                    list.Add(new RecordedExemplar(metric.Name, ex.TraceId.ToHexString(), ex.SpanId.ToHexString(), val));
                }
            }
        }
        return list;
    }

    public void AssertConforms()
    {
        foreach (string key in SpecTables.RequiredTier0)
        {
            if (!Telemetry.ResourceAttributes.TryGetValue(key, out object? val) ||
                val is null || string.IsNullOrEmpty(val.ToString()))
            {
                throw new O11yAssertionException($"missing required tier0 resource attribute {key}");
            }
        }
        if (Telemetry.SchemaUrl != SpecConstants.SchemaUrl)
        {
            throw new O11yAssertionException($"resource schemaUrl {Telemetry.SchemaUrl} != {SpecConstants.SchemaUrl}");
        }

        var policy = Telemetry.Policy;
        void CheckNoSecrets(string surface, IEnumerable<KeyValuePair<string, object?>>? attrs)
        {
            if (attrs is null) return;
            foreach (var (k, _) in attrs)
            {
                if (policy.Lookup(k) == Sensitivity.Secret)
                {
                    throw new O11yAssertionException($"secret attribute {k} leaked on {surface}");
                }
            }
        }

        CheckNoSecrets("resource", Telemetry.ResourceAttributes);
        foreach (var span in Spans())
        {
            CheckNoSecrets($"span {span.DisplayName}", span.TagObjects);
        }
        foreach (var rec in SinkRecords)
        {
            CheckNoSecrets($"log {rec.Body}", rec.Attributes);
            string? evName = rec.EventName ??
                (rec.Attributes.TryGetValue(SpecConstants.EventNameKey, out object? evObj) ? evObj?.ToString() : null);
            if (evName is not null && SpecTables.Events.TryGetValue(evName, out var info))
            {
                foreach (string req in info.Required)
                {
                    if (!rec.Attributes.ContainsKey(req))
                    {
                        throw new O11yAssertionException($"event {evName} missing required attribute {req}");
                    }
                }
                foreach (string prefix in info.RequiredTemplates)
                {
                    if (!rec.Attributes.Keys.Any(k => k.StartsWith(prefix + ".", StringComparison.Ordinal)))
                    {
                        throw new O11yAssertionException($"event {evName} missing template attribute {prefix}.*");
                    }
                }
            }
        }
    }

    public void AssertCorrelated()
    {
        var spanPairs = Spans()
            .Select(s => (TraceId: s.TraceId.ToHexString(), SpanId: s.SpanId.ToHexString()))
            .ToHashSet();
        if (spanPairs.Count == 0) throw new O11yAssertionException("no finished spans recorded");

        bool matchedOtlp = Logs().Any(lr =>
            spanPairs.Contains((lr.TraceId, lr.SpanId)));
        if (!matchedOtlp) throw new O11yAssertionException("no OTLP log record correlated with any recorded span");

        bool matchedConsole = ConsoleRecords().Any(c =>
            c.TryGetValue("trace_id", out var tid) &&
            c.TryGetValue("span_id", out var sid) &&
            spanPairs.Contains((tid.GetString() ?? "", sid.GetString() ?? "")));
        if (!matchedConsole) throw new O11yAssertionException("no console log record correlated with any recorded span");
    }

    public void AssertTriangle()
    {
        AssertCorrelated();
        var traceIds = Spans().Select(s => s.TraceId.ToHexString()).ToHashSet();
        if (!Exemplars().Any(ex => traceIds.Contains(ex.TraceId)))
        {
            throw new O11yAssertionException("no metric exemplar reconciled with any recorded trace");
        }
    }

    public ShutdownReport Shutdown(TimeSpan? timeout = null) => Telemetry.Shutdown(timeout);
    public void Dispose() => Telemetry.Dispose();
}
