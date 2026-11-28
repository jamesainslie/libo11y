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
        ParsePairs(raw, result, decodeValues: true);
        return result;
    }

    private static void ParsePairs(string? raw, Dictionary<string, string> result, bool decodeValues)
    {
        if (string.IsNullOrWhiteSpace(raw)) return;
        foreach (string part in raw.Split(','))
        {
            int eq = part.IndexOf('=');
            if (eq <= 0) continue;
            string k = part[..eq].Trim();
            string v = part[(eq + 1)..].Trim();
            if (k.Length == 0) continue;
            result[k] = decodeValues ? Uri.UnescapeDataString(v) : v;
        }
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

    public static Uri SignalEndpoint(IReadOnlyDictionary<string, string> env, string signal, OtlpExportProtocol proto)
    {
        const string prefix = "OTEL_EXPORTER_OTLP";
        string signalPrefix = $"{prefix}_{signal}";
        string signalVar = $"{signalPrefix}_ENDPOINT";
        const string generalVar = $"{prefix}_ENDPOINT";
        string? specific = NonBlankSetting(env, signalVar);
        string raw = specific ?? NonBlankSetting(env, generalVar) ??
            (proto == OtlpExportProtocol.Grpc ? "http://localhost:4317" : "http://localhost:4318");

        if (proto == OtlpExportProtocol.Grpc && !raw.Contains("://", StringComparison.Ordinal))
        {
            string? insecure = NonBlankSetting(env, $"{signalPrefix}_INSECURE") ?? NonBlankSetting(env, $"{prefix}_INSECURE");
            raw = (string.Equals(insecure, "true", StringComparison.OrdinalIgnoreCase) ? "http://" : "https://") + raw;
        }

        if (!Uri.TryCreate(raw, UriKind.Absolute, out Uri? endpoint) ||
            endpoint.Scheme is not ("http" or "https") || endpoint.Host.Length == 0)
        {
            string variable = specific is null ? generalVar : signalVar;
            throw new InvalidOptionException($"o11y: {variable} must specify a valid OTLP endpoint");
        }

        if (specific is not null || proto == OtlpExportProtocol.Grpc) return endpoint;

        string path = endpoint.AbsolutePath;
        if (!path.EndsWith('/')) path += "/";
        return new UriBuilder(endpoint) { Path = $"{path}v1/{signal.ToLowerInvariant()}" }.Uri;
    }

    private static string? NonBlankSetting(IReadOnlyDictionary<string, string> env, string key) =>
        env.TryGetValue(key, out string? value) && !string.IsNullOrWhiteSpace(value) ? value.Trim() : null;

    public static string SignalHeaders(IReadOnlyDictionary<string, string> env, string signalVar)
    {
        var merged = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        // The exporter decodes values after it splits the header list.
        ParsePairs(env.GetValueOrDefault("OTEL_EXPORTER_OTLP_HEADERS"), merged, decodeValues: false);
        ParsePairs(env.GetValueOrDefault(signalVar), merged, decodeValues: false);
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
