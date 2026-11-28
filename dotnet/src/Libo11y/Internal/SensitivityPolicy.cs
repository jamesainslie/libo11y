using System.Collections;
using System.Collections.Frozen;
using Libo11y.Spec;

namespace Libo11y.Internal;

public enum PolicyAction
{
    Keep,
    Rewrite,
    Drop,
}

public sealed class ViolationRecorder
{
    private readonly object _lock = new();
    private readonly List<(string Signal, string Rule)> _pending = [];
    private Action<string, string>? _sink;

    public void Attach(Action<string, string> sink)
    {
        List<(string, string)> toFlush;
        lock (_lock)
        {
            _sink = sink;
            toFlush = [.. _pending];
            _pending.Clear();
        }
        foreach (var (sig, rule) in toFlush)
        {
            sink(sig, rule);
        }
    }

    public void Record(string signal, string rule)
    {
        Action<string, string>? sink;
        lock (_lock)
        {
            sink = _sink;
            if (sink is null)
            {
                _pending.Add((signal, rule));
                return;
            }
        }
        sink(signal, rule);
    }
}

public sealed class SensitivityPolicy
{
    public const string RuleSecret = "secret_attribute";
    public const string RulePii = "pii_attribute";

    public PiiMode PiiMode { get; }
    private readonly byte[] _key;
    private readonly FrozenDictionary<string, Sensitivity> _appClasses;
    private readonly ViolationRecorder? _recorder;

    public static FrozenDictionary<string, Sensitivity> LoadAppRegistries(IReadOnlyList<string> sources)
    {
        if (sources.Count == 0)
        {
            return FrozenDictionary<string, Sensitivity>.Empty;
        }
        var byNs = new Dictionary<string, string>(StringComparer.Ordinal);
        var classes = new Dictionary<string, Sensitivity>(StringComparer.Ordinal);
        foreach (string src in sources)
        {
            CompiledAppRegistry compiled;
            try
            {
                compiled = File.Exists(src)
                    ? AppRegistryValidator.LoadFile(src)
                    : AppRegistryValidator.Compile(AppRegistryValidator.Parse(src), "<inline>");
            }
            catch (Exception ex) when (ex is IOException or AppRegistryParseException or AppRegistryValidationException)
            {
                throw new InvalidAppRegistryException($"o11y: invalid application registry: {ex.Message}", ex);
            }

            if (byNs.TryGetValue(compiled.Namespace, out string? prev))
            {
                throw new InvalidAppRegistryException(
                    $"o11y: invalid application registry: duplicate namespace '{compiled.Namespace}' declared in {prev} and {compiled.Source}");
            }
            byNs[compiled.Namespace] = compiled.Source ?? "<inline>";
            foreach (var (k, v) in compiled.Classes)
            {
                classes[k] = v;
            }
        }
        return classes.ToFrozenDictionary();
    }

    public SensitivityPolicy(
        PiiMode piiMode = PiiMode.Drop,
        byte[]? piiHashKey = null,
        FrozenDictionary<string, Sensitivity>? appClasses = null,
        ViolationRecorder? recorder = null)
    {
        if (piiMode == PiiMode.Hash && (piiHashKey is null || piiHashKey.Length < PiiTokenizer.MinPiiHashKeyLen))
        {
            throw new PiiHashKeyException();
        }
        PiiMode = piiMode;
        _key = piiHashKey ?? [];
        _appClasses = appClasses ?? FrozenDictionary<string, Sensitivity>.Empty;
        _recorder = recorder;
    }

    public Sensitivity? Lookup(string key)
    {
        if (SpecTables.SensitivityOf.TryGetValue(key, out var cls)) return cls;
        if (_appClasses.TryGetValue(key, out var appCls)) return appCls;
        return null;
    }

    public PolicyAction ActionFor(Sensitivity? cls)
    {
        if (cls == Sensitivity.Secret) return PolicyAction.Drop;
        if (cls == Sensitivity.Pii)
        {
            return PiiMode switch
            {
                PiiMode.Allow => PolicyAction.Keep,
                PiiMode.Hash => PolicyAction.Rewrite,
                _ => PolicyAction.Drop,
            };
        }
        return PolicyAction.Keep;
    }

    public PolicyAction Decide(string signal, string key)
    {
        var cls = Lookup(key);
        var act = ActionFor(cls);
        if (act != PolicyAction.Keep && _recorder is not null)
        {
            _recorder.Record(signal, cls == Sensitivity.Secret ? RuleSecret : RulePii);
        }
        return act;
    }

    public bool MetricKeep(string key)
    {
        var cls = Lookup(key);
        if (cls == Sensitivity.Secret) return false;
        if (cls == Sensitivity.Pii) return PiiMode == PiiMode.Allow;
        return true;
    }

    public string Tokenize(object? value) => PiiTokenizer.Token(_key, value);

    public (Dictionary<string, object?> Attributes, bool Changed) ClassifyFlat(
        string signal,
        IEnumerable<KeyValuePair<string, object?>>? attrs)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (attrs is null) return (result, false);
        bool changed = false;
        foreach (var (k, rawV) in attrs)
        {
            object? v = O11yRedact.IsRedactable(rawV) ? O11yRedact.Render(rawV) : rawV;
            if (!ReferenceEquals(v, rawV)) changed = true;

            var act = Decide(signal, k);
            if (act == PolicyAction.Drop)
            {
                changed = true;
                continue;
            }
            if (act == PolicyAction.Rewrite)
            {
                changed = true;
                result[k] = Tokenize(v);
            }
            else
            {
                result[k] = v;
            }
        }
        return (result, changed);
    }

    public KeyValuePair<string, object?>[] ClassifyMetricTags(ReadOnlySpan<KeyValuePair<string, object?>> tags)
    {
        if (tags.Length == 0) return [];
        var list = new List<KeyValuePair<string, object?>>(tags.Length);
        foreach (var kv in tags)
        {
            if (!MetricKeep(kv.Key)) continue;
            object? val = O11yRedact.IsRedactable(kv.Value) ? O11yRedact.Render(kv.Value) : kv.Value;
            list.Add(new KeyValuePair<string, object?>(kv.Key, val));
        }
        return [.. list];
    }

    public Dictionary<string, object?> ClassifyLogAttributes(
        IEnumerable<KeyValuePair<string, object?>> attrs,
        AttrReplacer? replacer = null)
    {
        int budget = PiiTokenizer.MaxCompositeNodes;
        var active = new HashSet<object>(ReferenceEqualityComparer.Instance);
        return WalkMap(attrs, [], 0, ref budget, active, replacer);
    }

    private Dictionary<string, object?> WalkMap(
        IEnumerable<KeyValuePair<string, object?>> mapping,
        List<string> groups,
        int depth,
        ref int budget,
        HashSet<object> active,
        AttrReplacer? replacer)
    {
        var output = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (rawKey, rawVal) in mapping)
        {
            string k = rawKey;
            object? val = O11yRedact.IsRedactable(rawVal) ? O11yRedact.Render(rawVal) : rawVal;

            if (replacer is not null)
            {
                var replaced = replacer(groups, k, val);
                if (!replaced.HasValue) continue;
                k = replaced.Value.Key;
                val = replaced.Value.Value;
                if (string.IsNullOrEmpty(k)) continue;
            }

            string fullKey = groups.Count == 0 ? k : string.Join(".", groups) + "." + k;
            var act = Decide(Signal.Logs, fullKey);
            if (act == PolicyAction.Drop) continue;
            if (act == PolicyAction.Rewrite)
            {
                output[k] = Tokenize(val);
                continue;
            }

            var nextGroups = new List<string>(groups.Count + 1);
            nextGroups.AddRange(groups);
            nextGroups.Add(k);
            output[k] = WalkValue(val, nextGroups, depth + 1, ref budget, active, replacer);
        }
        return output;
    }

    private object? WalkValue(
        object? value,
        List<string> groups,
        int depth,
        ref int budget,
        HashSet<object> active,
        AttrReplacer? replacer)
    {
        if (depth > PiiTokenizer.MaxCompositeDepth || budget <= 0)
        {
            return PiiTokenizer.CanonicalTruncated;
        }
        budget--;

        if (value is null) return null;
        if (O11yRedact.IsRedactable(value)) value = O11yRedact.Render(value);
        if (value is null or bool or sbyte or byte or short or ushort or int or uint or long or ulong or float or double or decimal or string)
        {
            return value;
        }
        if (value is byte[] bytes) return bytes;

        if (!active.Add(value)) return PiiTokenizer.CanonicalTruncated;
        try
        {
            if (value is IEnumerable<KeyValuePair<string, object?>> kvEnum)
            {
                return WalkMap(kvEnum, groups, depth, ref budget, active, replacer);
            }
            if (value is IDictionary dict)
            {
                var entries = new List<KeyValuePair<string, object?>>();
                foreach (DictionaryEntry e in dict)
                {
                    entries.Add(new KeyValuePair<string, object?>(e.Key?.ToString() ?? "", e.Value));
                }
                return WalkMap(entries, groups, depth, ref budget, active, replacer);
            }
            if (value is IEnumerable seq)
            {
                var list = new List<object?>();
                foreach (object? el in seq)
                {
                    list.Add(WalkValue(el, groups, depth + 1, ref budget, active, replacer));
                }
                return list;
            }
            return value.ToString();
        }
        finally
        {
            active.Remove(value);
        }
    }
}
