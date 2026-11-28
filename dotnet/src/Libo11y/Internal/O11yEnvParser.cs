using System.Collections;
using System.Globalization;
using OpenTelemetry.Exporter;

namespace Libo11y.Internal;

internal static class O11yEnvParser
{
    private static readonly HashSet<string> SupportedExporters = ["otlp", "console", "none"];

    public static Dictionary<string, string> ResolveMap(IReadOnlyDictionary<string, string>? envOpt)
    {
        if (O11yEnv.IsHermetic(envOpt))
        {
            return new Dictionary<string, string>(StringComparer.Ordinal);
        }
        if (envOpt is not null)
        {
            return new Dictionary<string, string>(envOpt, StringComparer.Ordinal);
        }
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (DictionaryEntry entry in System.Environment.GetEnvironmentVariables())
        {
            if (entry.Key is string k && entry.Value is string v)
            {
                result[k] = v;
            }
        }
        return result;
    }

    public static bool IsSdkDisabled(IReadOnlyDictionary<string, string> env) =>
        env.TryGetValue("OTEL_SDK_DISABLED", out string? v) &&
        string.Equals(v.Trim(), "true", StringComparison.OrdinalIgnoreCase);

    public static Dictionary<string, string> ParsePairs(string? raw)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(raw)) return result;
        foreach (string part in raw.Split(','))
        {
            int eq = part.IndexOf('=');
            if (eq <= 0) continue;
            string k = part[..eq].Trim();
            string v = part[(eq + 1)..].Trim();
            if (k.Length == 0) continue;
            try { v = Uri.UnescapeDataString(v); } catch { /* leave as-is */ }
            result[k] = v;
        }
        return result;
    }

    public static string ParseExporterChoice(IReadOnlyDictionary<string, string> env, string varName, string defaultValue)
    {
        if (!env.TryGetValue(varName, out string? raw) || string.IsNullOrWhiteSpace(raw))
        {
            return defaultValue;
        }
        string first = raw.Split(',')[0].Trim().ToLowerInvariant();
        if (!SupportedExporters.Contains(first))
        {
            throw new UnsupportedProtocolException($"o11y: unsupported exporter '{first}' in {varName}");
        }
        return first;
    }

    public static OtlpExportProtocol ParseProtocol(IReadOnlyDictionary<string, string> env, string signalVar)
    {
        string? raw = env.TryGetValue(signalVar, out string? sv) && !string.IsNullOrWhiteSpace(sv)
            ? sv
            : env.TryGetValue("OTEL_EXPORTER_OTLP_PROTOCOL", out string? gv) ? gv : null;
        if (string.IsNullOrWhiteSpace(raw))
        {
            return OtlpExportProtocol.HttpProtobuf;
        }
        return raw.Trim().ToLowerInvariant() switch
        {
            "http/protobuf" => OtlpExportProtocol.HttpProtobuf,
            "grpc" => OtlpExportProtocol.Grpc,
            var other => throw new UnsupportedProtocolException($"o11y: unsupported OTLP protocol '{other}'"),
        };
    }

    public static string SignalEndpoint(IReadOnlyDictionary<string, string> env, string signalVar, OtlpExportProtocol proto, string httpSuffix)
    {
        if (env.TryGetValue(signalVar, out string? specific) && !string.IsNullOrWhiteSpace(specific))
        {
            return specific.Trim();
        }
        string baseUrl = env.TryGetValue("OTEL_EXPORTER_OTLP_ENDPOINT", out string? b) && !string.IsNullOrWhiteSpace(b)
            ? b.Trim()
            : proto == OtlpExportProtocol.Grpc ? "http://localhost:4317" : "http://localhost:4318";
        if (proto == OtlpExportProtocol.Grpc)
        {
            return baseUrl;
        }
        return baseUrl.TrimEnd('/') + httpSuffix;
    }

    public static string? SignalHeaders(IReadOnlyDictionary<string, string> env, string signalVar)
    {
        var merged = ParsePairs(env.TryGetValue("OTEL_EXPORTER_OTLP_HEADERS", out string? gh) ? gh : null);
        if (env.TryGetValue(signalVar, out string? sh))
        {
            foreach (var (k, v) in ParsePairs(sh)) merged[k] = v;
        }
        if (merged.Count == 0) return null;
        return string.Join(",", merged.Select(kv => $"{kv.Key}={kv.Value}"));
    }

    public static int SignalTimeoutMs(IReadOnlyDictionary<string, string> env, string signalVar, int defaultMs = 10_000)
    {
        string? raw = env.TryGetValue(signalVar, out string? sv) && !string.IsNullOrWhiteSpace(sv)
            ? sv
            : env.TryGetValue("OTEL_EXPORTER_OTLP_TIMEOUT", out string? gv) ? gv : null;
        if (int.TryParse(raw?.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int ms) && ms > 0)
        {
            return ms;
        }
        return defaultMs;
    }

    public static int ParseInt(IReadOnlyDictionary<string, string> env, string key, int defaultValue)
    {
        if (env.TryGetValue(key, out string? raw) &&
            int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int val) &&
            val > 0)
        {
            return val;
        }
        return defaultValue;
    }

    public static ExemplarFilterMode ParseExemplarFilter(ExemplarFilterMode? opt, IReadOnlyDictionary<string, string> env)
    {
        if (opt.HasValue) return opt.Value;
        if (!env.TryGetValue("OTEL_METRICS_EXEMPLAR_FILTER", out string? raw) || string.IsNullOrWhiteSpace(raw))
        {
            return ExemplarFilterMode.TraceBased;
        }
        return raw.Trim().ToLowerInvariant() switch
        {
            "trace_based" => ExemplarFilterMode.TraceBased,
            "always_on" => ExemplarFilterMode.AlwaysOn,
            "always_off" => ExemplarFilterMode.AlwaysOff,
            var other => throw new ExporterException($"o11y: unsupported exemplar filter '{other}'"),
        };
    }
}
