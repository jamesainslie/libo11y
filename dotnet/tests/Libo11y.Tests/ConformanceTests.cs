using System.Text.Json;
using Libo11y.Internal;
using Libo11y.Spec;
using Xunit;

namespace Libo11y.Tests;

public sealed class ConformanceTests
{
    private static string ConformanceDir
    {
        get
        {
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir is not null)
            {
                var candidate = Path.Combine(dir.FullName, "conformance");
                if (Directory.Exists(candidate)) return candidate;
                dir = dir.Parent;
            }
            throw new DirectoryNotFoundException("conformance/ directory not found");
        }
    }

    [Fact]
    public void InstanceId_MatchesAllSharedVectors()
    {
        string json = File.ReadAllText(Path.Combine(ConformanceDir, "vectors", "instance-id.json"));
        using var doc = JsonDocument.Parse(json);
        foreach (var v in doc.RootElement.EnumerateArray())
        {
            string? got = InstanceId.Derive(
                v.GetProperty("k8s_pod_uid").GetString() ?? "",
                v.GetProperty("k8s_pod_name").GetString() ?? "",
                v.GetProperty("k8s_namespace_name").GetString() ?? "");
            Assert.Equal(v.GetProperty("want").GetString(), got);
        }
    }

    [Fact]
    public void EndpointSanitize_MatchesAllSharedVectors()
    {
        string json = File.ReadAllText(Path.Combine(ConformanceDir, "vectors", "endpoint-sanitize.json"));
        using var doc = JsonDocument.Parse(json);
        foreach (var v in doc.RootElement.EnumerateArray())
        {
            string input = v.GetProperty("in").GetString() ?? "";
            string want = v.GetProperty("want").GetString() ?? "";
            Assert.Equal(want, EndpointSanitizer.Sanitize(input));
        }
    }

    private static object? DecodeJsonValue(JsonElement el, string kind)
    {
        if (kind == "bytes")
        {
            return Convert.FromBase64String(el.GetString() ?? "");
        }
        return ConvertElement(el);
    }

    private static object? ConvertElement(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.Null => null,
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.String => el.GetString(),
        JsonValueKind.Number => el.TryGetInt64(out long l) ? (object)l : el.GetDouble(),
        JsonValueKind.Array => el.EnumerateArray().Select(ConvertElement).ToList(),
        JsonValueKind.Object => el.EnumerateObject().ToDictionary(p => p.Name, p => ConvertElement(p.Value), StringComparer.Ordinal),
        _ => el.ToString(),
    };

    [Fact]
    public void PiiHash_MatchesAllSharedVectors()
    {
        string json = File.ReadAllText(Path.Combine(ConformanceDir, "vectors", "pii-hash.json"));
        using var doc = JsonDocument.Parse(json);
        byte[] key = Convert.FromHexString(doc.RootElement.GetProperty("key_hex").GetString()!);
        int count = 0;
        foreach (var c in doc.RootElement.GetProperty("cases").EnumerateArray())
        {
            string name = c.GetProperty("name").GetString()!;
            string kind = c.GetProperty("kind").GetString()!;
            object? val = DecodeJsonValue(c.GetProperty("value"), kind);
            string wantCanonical = c.GetProperty("canonical").GetString()!;
            string wantToken = c.GetProperty("token").GetString()!;

            string gotCanonical = PiiTokenizer.CanonicalValue(val);
            Assert.True(wantCanonical == gotCanonical, $"canonical mismatch on '{name}': got '{gotCanonical}', want '{wantCanonical}'");

            string gotToken = PiiTokenizer.Token(key, val);
            Assert.True(wantToken == gotToken, $"token mismatch on '{name}': got '{gotToken}', want '{wantToken}'");
            count++;
        }
        Assert.True(count >= 31);
    }

    [Fact]
    public void AppRegistry_PassesAllSharedConformanceCases()
    {
        string dir = Path.Combine(ConformanceDir, "appregistry");
        var files = Directory.GetFiles(dir, "*.yaml").OrderBy(f => f, StringComparer.Ordinal).ToList();
        Assert.True(files.Count >= 46);

        var failures = new List<string>();
        foreach (string yml in files)
        {
            string want = File.ReadAllText(Path.ChangeExtension(yml, ".want")).Trim().Replace("\r\n", "\n");
            string got;
            try
            {
                var reg = AppRegistryValidator.ParseBytes(File.ReadAllBytes(yml));
                var violations = AppRegistryValidator.Validate(reg);
                got = violations.Count == 0
                    ? $"ok {reg.Attributes.Count} {reg.Namespace}"
                    : string.Join("\n", violations.Select(v => v.ToString()));
            }
            catch (AppRegistryParseException ex)
            {
                got = $"parse: {ex.Kind}";
            }

            if (got != want)
            {
                failures.Add($"{Path.GetFileName(yml)}:\n  got:  {got}\n  want: {want}");
            }
        }
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }
}
