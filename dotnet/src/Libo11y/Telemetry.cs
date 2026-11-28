using System.Diagnostics;
using System.Diagnostics.Metrics;
using Libo11y.Internal;
using Libo11y.Spec;
using Microsoft.Extensions.Logging;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Trace;

namespace Libo11y;

/// <summary>
/// Owned telemetry handle returned by <see cref="O11y.Setup"/> and <see cref="O11y.Init"/>.
/// </summary>
public sealed class Telemetry : IDisposable, IAsyncDisposable
{
    private readonly TracerProvider? _tracerProvider;
    private readonly MeterProvider? _meterProvider;
    private readonly LoggerProvider? _loggerProvider;
    private readonly Action<int>? _logsForceFlush;
    private readonly Func<int, bool>? _logsShutdown;
    private readonly ILoggerFactory _loggerFactory;
    private readonly O11yLogRouter _logRouter;
    private readonly Dictionary<string, string> _effectiveConfig;
    private readonly Action? _onGlobalShutdown;
    private readonly List<IDisposable> _ownedDisposables;
    private readonly object _shutdownLock = new();
    private Task<ShutdownReport>? _shutdownTask;

    public TracerProvider? TracerProvider => _tracerProvider;
    public MeterProvider? MeterProvider => _meterProvider;
    public LoggerProvider? LoggerProvider => _loggerProvider;
    public TextMapPropagator Propagator { get; }
    public ILoggerFactory LoggerFactory => _loggerFactory;
    public ILogger Logger { get; }
    public IReadOnlyDictionary<string, object?> ResourceAttributes { get; }
    public string SchemaUrl { get; }
    public SensitivityPolicy Policy { get; }
    public TimeSpan ShutdownTimeout { get; }

    internal Telemetry(
        TracerProvider? tracerProvider,
        MeterProvider? meterProvider,
        LoggerProvider? loggerProvider,
        Action<int>? logsForceFlush,
        Func<int, bool>? logsShutdown,
        ILoggerFactory loggerFactory,
        O11yLogRouter logRouter,
        TextMapPropagator propagator,
        IReadOnlyDictionary<string, object?> resourceAttributes,
        string schemaUrl,
        SensitivityPolicy policy,
        Dictionary<string, string> effectiveConfig,
        TimeSpan shutdownTimeout,
        Action? onGlobalShutdown,
        List<IDisposable> ownedDisposables)
    {
        _tracerProvider = tracerProvider;
        _meterProvider = meterProvider;
        _loggerProvider = loggerProvider;
        _logsForceFlush = logsForceFlush;
        _logsShutdown = logsShutdown;
        _loggerFactory = loggerFactory;
        _logRouter = logRouter;
        Propagator = propagator;
        Logger = loggerFactory.CreateLogger("libo11y");
        ResourceAttributes = resourceAttributes;
        SchemaUrl = schemaUrl;
        Policy = policy;
        _effectiveConfig = effectiveConfig;
        ShutdownTimeout = shutdownTimeout;
        _onGlobalShutdown = onGlobalShutdown;
        _ownedDisposables = ownedDisposables;
    }

    public IReadOnlyDictionary<string, string> EffectiveConfig() =>
        new Dictionary<string, string>(_effectiveConfig, StringComparer.Ordinal);

    public O11yMeter CreateMeter(string name, string? version = null)
    {
        var m = new Meter(name, version);
        lock (_shutdownLock) _ownedDisposables.Add(m);
        return new O11yMeter(m, Policy);
    }

    public void Inject(IDictionary<string, string> carrier)
    {
        var ctx = new PropagationContext(Activity.Current?.Context ?? default, Baggage.Current);
        Propagator.Inject(ctx, carrier, static (c, k, v) => c[k] = v);
    }

    public PropagationContext Extract(IReadOnlyDictionary<string, string> carrier) =>
        Propagator.Extract(default, carrier, static (c, k) =>
            c.TryGetValue(k, out string? v) ? [v] : []);

    /// <summary>
    /// Emit a registered (or custom) event, always force-emitted past level gates.
    /// </summary>
    public void Event(string name, IReadOnlyDictionary<string, object?>? attributes = null, string? body = null) =>
        _logRouter.Emit(LogLevel.Information, body ?? name, attributes, eventName: name, forceOverride: true);

    /// <summary>
    /// Log a structured message with explicit key/value attributes correlated with the active Activity.
    /// </summary>
    public void Log(LogLevel level, string message, IReadOnlyDictionary<string, object?>? attributes = null) =>
        _logRouter.Emit(level, message, attributes);

    public bool ForceFlush(TimeSpan? timeout = null)
    {
        int ms = (int)(timeout ?? ShutdownTimeout).TotalMilliseconds;
        bool ok = true;
        if (_loggerProvider is not null) ok &= _loggerProvider.ForceFlush(ms);
        else _logsForceFlush?.Invoke(ms);
        if (_meterProvider is not null) ok &= _meterProvider.ForceFlush(ms);
        if (_tracerProvider is not null) ok &= _tracerProvider.ForceFlush(ms);
        return ok;
    }

    /// <summary>
    /// Idempotent, bounded, concurrent shutdown across traces, metrics, and logs.
    /// </summary>
    public Task<ShutdownReport> ShutdownAsync(TimeSpan? timeout = null)
    {
        lock (_shutdownLock)
        {
            _shutdownTask ??= RunShutdownAsync(timeout ?? ShutdownTimeout);
            return _shutdownTask;
        }
    }

    public ShutdownReport Shutdown(TimeSpan? timeout = null) =>
        ShutdownAsync(timeout).GetAwaiter().GetResult();

    private async Task<ShutdownReport> RunShutdownAsync(TimeSpan timeout)
    {
        int ms = Math.Max(100, (int)timeout.TotalMilliseconds);

        Task<Exception?> ShutdownSignal(string name, Func<int, bool>? action) => Task.Run(() =>
        {
            if (action is null) return null;
            try
            {
                bool ok = action(ms);
                return ok ? null : new ExporterException($"o11y: {name} shutdown timed out or failed");
            }
            catch (Exception ex)
            {
                return ex;
            }
        });

        var logsTask = ShutdownSignal("logs", _loggerProvider is not null ? _loggerProvider.Shutdown : _logsShutdown);
        var metricsTask = ShutdownSignal("metrics", _meterProvider is null ? null : _meterProvider.Shutdown);
        var tracesTask = ShutdownSignal("traces", _tracerProvider is null ? null : _tracerProvider.Shutdown);

        var allTask = Task.WhenAll(logsTask, metricsTask, tracesTask);
        var completed = await Task.WhenAny(allTask, Task.Delay(timeout)).ConfigureAwait(false);

        Exception? logsErr = logsTask.IsCompleted ? await logsTask.ConfigureAwait(false)
            : new ExporterException($"o11y: logs shutdown timed out after {timeout.TotalSeconds:F1}s");
        Exception? metricsErr = metricsTask.IsCompleted ? await metricsTask.ConfigureAwait(false)
            : new ExporterException($"o11y: metrics shutdown timed out after {timeout.TotalSeconds:F1}s");
        Exception? tracesErr = tracesTask.IsCompleted ? await tracesTask.ConfigureAwait(false)
            : new ExporterException($"o11y: traces shutdown timed out after {timeout.TotalSeconds:F1}s");

        _onGlobalShutdown?.Invoke();

        try { _loggerFactory.Dispose(); } catch { /* best effort */ }
        try { _loggerProvider?.Dispose(); } catch { /* best effort */ }
        try { _meterProvider?.Dispose(); } catch { /* best effort */ }
        try { _tracerProvider?.Dispose(); } catch { /* best effort */ }
        foreach (var d in _ownedDisposables)
        {
            try { d.Dispose(); } catch { /* best effort */ }
        }

        _ = completed;
        return new ShutdownReport(tracesErr, metricsErr, logsErr);
    }

    public void Dispose() => Shutdown();
    public async ValueTask DisposeAsync() => await ShutdownAsync().ConfigureAwait(false);
}
