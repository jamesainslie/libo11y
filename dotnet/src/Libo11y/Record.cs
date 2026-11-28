namespace Libo11y;

/// <summary>
/// Per-request wide event accumulator attached to the current async execution flow.
/// </summary>
public sealed class O11yRecord
{
    private static readonly AsyncLocal<O11yRecord?> CurrentLocal = new();
    private readonly object _lock = new();
    private readonly Dictionary<string, object?> _attrs = new(StringComparer.Ordinal);

    public static O11yRecord? Current => CurrentLocal.Value;

    public static IDisposable Start(out O11yRecord record)
    {
        var prev = CurrentLocal.Value;
        record = new O11yRecord();
        CurrentLocal.Value = record;
        return new Scope(() => CurrentLocal.Value = prev);
    }

    public O11yRecord Set(string key, object? value)
    {
        lock (_lock) _attrs[key] = value;
        return this;
    }

    public O11yRecord Add(string key, long delta = 1)
    {
        lock (_lock)
        {
            long cur = _attrs.TryGetValue(key, out object? existing) && existing is long l ? l : 0;
            _attrs[key] = cur + delta;
        }
        return this;
    }

    public Dictionary<string, object?> Snapshot()
    {
        lock (_lock) return new Dictionary<string, object?>(_attrs, StringComparer.Ordinal);
    }

    public void EmitEvent(Telemetry telemetry, string name, IReadOnlyDictionary<string, object?>? extra = null)
    {
        var merged = Snapshot();
        if (extra is not null)
        {
            foreach (var (k, v) in extra) merged[k] = v;
        }
        telemetry.Event(name, merged);
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
