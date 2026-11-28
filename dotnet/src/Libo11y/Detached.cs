using System.Diagnostics;
using System.Text;
using System.Text.Json;
using OpenTelemetry;
using OpenTelemetry.Context.Propagation;

namespace Libo11y;

/// <summary>
/// Detached work propagation (queues, background workers, Hangfire/MassTransit) with 32 KiB carrier bound.
/// </summary>
public static class Detached
{
    public const int MaxCarrierBytes = 32 * 1024;

    public sealed class Carrier : IEquatable<Carrier>
    {
        public IReadOnlyDictionary<string, string> Headers { get; }

        public Carrier(IReadOnlyDictionary<string, string>? headers = null)
        {
            Headers = headers is null
                ? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                : new Dictionary<string, string>(headers, StringComparer.OrdinalIgnoreCase);
        }

        public string MarshalText()
        {
            string json = JsonSerializer.Serialize(Headers);
            if (Encoding.UTF8.GetByteCount(json) > MaxCarrierBytes)
            {
                throw new InvalidCarrierException($"o11y: carrier exceeds {MaxCarrierBytes} byte limit");
            }
            return json;
        }

        public static Carrier UnmarshalText(string text)
        {
            if (text is null) throw new InvalidCarrierException("o11y: carrier text is null");
            if (Encoding.UTF8.GetByteCount(text) > MaxCarrierBytes)
            {
                throw new InvalidCarrierException($"o11y: carrier exceeds {MaxCarrierBytes} byte limit");
            }
            try
            {
                using var doc = JsonDocument.Parse(text);
                if (doc.RootElement.ValueKind != JsonValueKind.Object)
                {
                    throw new InvalidCarrierException("o11y: carrier must be a JSON object");
                }
                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var prop in doc.RootElement.EnumerateObject())
                {
                    if (prop.Value.ValueKind != JsonValueKind.String)
                    {
                        throw new InvalidCarrierException("o11y: carrier entries must be strings");
                    }
                    headers[prop.Name] = prop.Value.GetString() ?? "";
                }
                return new Carrier(headers);
            }
            catch (JsonException ex)
            {
                throw new InvalidCarrierException($"o11y: invalid carrier: {ex.Message}", ex);
            }
        }

        public bool Equals(Carrier? other)
        {
            if (other is null || Headers.Count != other.Headers.Count) return false;
            foreach (var (k, v) in Headers)
            {
                if (!other.Headers.TryGetValue(k, out string? ov) || ov != v) return false;
            }
            return true;
        }

        public override bool Equals(object? obj) => obj is Carrier c && Equals(c);
        public override int GetHashCode() => Headers.Count;
    }

    public static Carrier Capture(Telemetry? telemetry = null)
    {
        var prop = telemetry?.Propagator ?? Propagators.DefaultTextMapPropagator;
        var dict = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var ctx = new PropagationContext(Activity.Current?.Context ?? default, Baggage.Current);
        prop.Inject(ctx, dict, static (c, k, v) => c[k] = v);
        return new Carrier(dict);
    }

    public static Baggage RestoreBaggage(Carrier carrier, Telemetry? telemetry = null)
    {
        var prop = telemetry?.Propagator ?? Propagators.DefaultTextMapPropagator;
        var extracted = prop.Extract(default, carrier.Headers, static (c, k) =>
            c.TryGetValue(k, out string? v) ? [v] : []);
        return extracted.Baggage;
    }

    public static Activity? StartLinked(
        Carrier carrier,
        string spanName,
        ActivitySource source,
        Telemetry? telemetry = null,
        ActivityKind kind = ActivityKind.Consumer,
        IEnumerable<KeyValuePair<string, object?>>? tags = null)
    {
        var prop = telemetry?.Propagator ?? Propagators.DefaultTextMapPropagator;
        var extracted = prop.Extract(default, carrier.Headers, static (c, k) =>
            c.TryGetValue(k, out string? v) ? [v] : []);

        ActivityLink[]? links = extracted.ActivityContext.TraceId != default
            ? [new ActivityLink(extracted.ActivityContext)]
            : null;

        // Restore baggage from carrier onto current async flow
        Baggage.Current = extracted.Baggage;

        // Start a brand-new root span (parentContext = default) linked to the captured span
        return source.StartActivity(spanName, kind, parentContext: default, tags: tags, links: links);
    }
}
