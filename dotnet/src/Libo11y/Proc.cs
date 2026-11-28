using System.Diagnostics;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;

namespace Libo11y;

/// <summary>
/// Child-process environment (TRACEPARENT/TRACESTATE only; never baggage) and framed-map propagation.
/// </summary>
public static class Proc
{
    public const string TraceparentEnv = "TRACEPARENT";
    public const string TracestateEnv = "TRACESTATE";

    private static readonly TraceContextPropagator TraceOnly = new();

    public static Dictionary<string, string> EnvCarrier(ActivityContext? context = null)
    {
        var actCtx = context ?? Activity.Current?.Context ?? default;
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        TraceOnly.Inject(new PropagationContext(actCtx, default), dict, static (c, k, v) => c[k] = v);

        var env = new Dictionary<string, string>(StringComparer.Ordinal);
        if (dict.TryGetValue("traceparent", out string? tp)) env[TraceparentEnv] = tp;
        if (dict.TryGetValue("tracestate", out string? ts)) env[TracestateEnv] = ts;
        return env;
    }

    public static Dictionary<string, string> ChildEnv(
        IReadOnlyDictionary<string, string>? baseEnv = null,
        ActivityContext? context = null)
    {
        var result = baseEnv is not null
            ? new Dictionary<string, string>(baseEnv, StringComparer.Ordinal)
            : new Dictionary<string, string>(StringComparer.Ordinal);
        result.Remove(TraceparentEnv);
        result.Remove(TracestateEnv);
        foreach (var (k, v) in EnvCarrier(context))
        {
            result[k] = v;
        }
        return result;
    }

    public static ActivityContext ExtractEnv(IReadOnlyDictionary<string, string> env)
    {
        var carrier = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (env.TryGetValue(TraceparentEnv, out string? tp) && !string.IsNullOrEmpty(tp))
        {
            carrier["traceparent"] = tp;
        }
        if (env.TryGetValue(TracestateEnv, out string? ts) && !string.IsNullOrEmpty(ts))
        {
            carrier["tracestate"] = ts;
        }
        var extracted = TraceOnly.Extract(default, carrier, static (c, k) =>
            c.TryGetValue(k, out string? v) ? [v] : []);
        return extracted.ActivityContext;
    }

    public static void InjectFrame(IDictionary<string, string> frame, Telemetry? telemetry = null)
    {
        var prop = telemetry?.Propagator ?? Propagators.DefaultTextMapPropagator;
        var ctx = new PropagationContext(Activity.Current?.Context ?? default, Baggage.Current);
        prop.Inject(ctx, frame, static (c, k, v) => c[k] = v);
    }

    public static PropagationContext ExtractFrame(IReadOnlyDictionary<string, string> frame, Telemetry? telemetry = null)
    {
        var prop = telemetry?.Propagator ?? Propagators.DefaultTextMapPropagator;
        return prop.Extract(default, frame, static (c, k) =>
            c.TryGetValue(k, out string? v) ? [v] : []);
    }
}
