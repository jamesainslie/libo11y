using System.Diagnostics;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;

namespace Libo11y;

public enum PiiMode
{
    Drop,
    Hash,
    Allow,
}

public enum ExemplarFilterMode
{
    TraceBased,
    AlwaysOn,
    AlwaysOff,
}

public sealed record ShutdownReport(
    Exception? TracesError,
    Exception? MetricsError,
    Exception? LogsError)
{
    public bool IsOk => TracesError is null && MetricsError is null && LogsError is null;
}

public sealed record BuildInfo(
    string? Version = null,
    string? VcsRevision = null,
    string? BuildTime = null,
    bool? BuildModified = null);

public delegate (string Key, object? Value)? AttrReplacer(IReadOnlyList<string> groups, string key, object? value);

public sealed record O11yLogRecord(
    DateTimeOffset Timestamp,
    DateTimeOffset ObservedTimestamp,
    int SeverityNumber,
    string SeverityText,
    string Body,
    string? EventName,
    string? TraceId,
    string? SpanId,
    IReadOnlyDictionary<string, object?> Attributes);

/// <summary>
/// Environment configuration source. Pass <see cref="Hermetic"/> to ignore all ambient OTEL_* variables.
/// </summary>
public static class O11yEnv
{
    public static readonly IReadOnlyDictionary<string, string> Hermetic = new HermeticMap();

    internal static bool IsHermetic(IReadOnlyDictionary<string, string>? map) => map is HermeticMap;

    private sealed class HermeticMap : Dictionary<string, string> { }
}

public sealed class O11yOptions
{
    public string? ServiceName { get; set; }
    public string? Version { get; set; }
    public string? Environment { get; set; }
    public string? ServiceNamespace { get; set; }
    public string? ServiceInstanceId { get; set; }
    public IReadOnlyList<string> ExtraEnvironments { get; set; } = [];
    public bool StrictIdentity { get; set; } = true;
    public Dictionary<string, object?> ResourceAttributes { get; set; } = new(StringComparer.Ordinal);
    public BuildInfo? BuildInfo { get; set; }
    public bool BuildInfoEnabled { get; set; } = true;
    public IReadOnlyDictionary<string, string>? Env { get; set; }
    public PiiMode PiiMode { get; set; } = PiiMode.Drop;
    public byte[]? PiiHashKey { get; set; }
    public IReadOnlyList<string> AppRegistries { get; set; } = [];
    public AttrReplacer? AttrReplacer { get; set; }
    public IReadOnlyList<TextMapPropagator>? Propagators { get; set; }
    public Func<string, bool>? BaggageEgressAllow { get; set; }
    public Sampler? Sampler { get; set; }
    public ExemplarFilterMode? ExemplarFilter { get; set; }
    public Dictionary<string, double[]> HistogramBuckets { get; set; } = new(StringComparer.Ordinal);
    public bool RuntimeMetrics { get; set; } = true;
    public TextWriter? ConsoleWriter { get; set; }
    public bool ConsoleEnabled { get; set; } = true;
    public LogLevel ConsoleLevel { get; set; } = LogLevel.Information;
    public List<Action<O11yLogRecord>> ExtraLogSinks { get; set; } = [];
    public BaseExporter<Activity>? SpanExporter { get; set; }
    public List<BaseProcessor<Activity>> SpanProcessors { get; set; } = [];
    public MetricReader? MetricReader { get; set; }
    public BaseExporter<LogRecord>? LogExporter { get; set; }
    public List<BaseProcessor<LogRecord>> LogProcessors { get; set; } = [];
    public List<string> ActivitySources { get; set; } = [];
    public List<string> Meters { get; set; } = [];
    public TimeSpan ShutdownTimeout { get; set; } = TimeSpan.FromSeconds(5);
}
