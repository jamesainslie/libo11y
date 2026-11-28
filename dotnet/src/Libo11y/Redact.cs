using System.Collections;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Libo11y;

public enum RedactAction
{
    Mask,
    Redact,
    Omit,
}

[AttributeUsage(AttributeTargets.Property | AttributeTargets.Field)]
public sealed class O11yRedactAttribute : Attribute
{
    public RedactAction Action { get; }

    public O11yRedactAttribute(RedactAction action)
    {
        Action = action;
    }

    public O11yRedactAttribute(string tag)
    {
        Action = O11yRedact.ParseTag(tag);
    }
}

public interface IRedactableValue
{
    object? AsRedacted();
}

[JsonConverter(typeof(RedactableJsonConverterFactory))]
public readonly struct Secret<T>(T value) : IRedactableValue, IEquatable<Secret<T>>
{
    private readonly T _value = value;

    public T Reveal() => _value;
    public object AsRedacted() => O11yRedact.RedactedLiteral;
    public override string ToString() => O11yRedact.RedactedLiteral;
    public bool Equals(Secret<T> other) => EqualityComparer<T>.Default.Equals(_value, other._value);
    public override bool Equals(object? obj) => obj is Secret<T> other && Equals(other);
    public override int GetHashCode() => EqualityComparer<T>.Default.GetHashCode(_value!);
}

[JsonConverter(typeof(RedactableJsonConverterFactory))]
public readonly struct Masked<T>(T value) : IRedactableValue, IEquatable<Masked<T>>
{
    private readonly T _value = value;

    public T Reveal() => _value;
    public object AsRedacted() => O11yRedact.MaskString(_value?.ToString() ?? "");
    public override string ToString() => O11yRedact.MaskString(_value?.ToString() ?? "");
    public bool Equals(Masked<T> other) => EqualityComparer<T>.Default.Equals(_value, other._value);
    public override bool Equals(object? obj) => obj is Masked<T> other && Equals(other);
    public override int GetHashCode() => EqualityComparer<T>.Default.GetHashCode(_value!);
}

internal sealed class RedactableJsonConverterFactory : JsonConverterFactory
{
    public override bool CanConvert(Type typeToConvert) =>
        typeof(IRedactableValue).IsAssignableFrom(typeToConvert);

    public override JsonConverter CreateConverter(Type typeToConvert, JsonSerializerOptions options)
    {
        var converterType = typeof(RedactableJsonConverter<>).MakeGenericType(typeToConvert);
        return (JsonConverter)Activator.CreateInstance(converterType)!;
    }

    private sealed class RedactableJsonConverter<TValue> : JsonConverter<TValue> where TValue : IRedactableValue
    {
        public override TValue Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            throw new NotSupportedException("Deserializing redacted wrapper types is not supported.");

        public override void Write(Utf8JsonWriter writer, TValue value, JsonSerializerOptions options) =>
            JsonSerializer.Serialize(writer, value.AsRedacted(), options);
    }
}

public static class O11yRedact
{
    public const string RedactedLiteral = "REDACTED";

    public static string MaskString(string value) => new('X', value.Length);

    public static RedactAction ParseTag(string tag) => tag.ToLowerInvariant() switch
    {
        "mask" or "confidential" => RedactAction.Mask,
        "redact" or "secret" => RedactAction.Redact,
        "omit" => RedactAction.Omit,
        _ => throw new ArgumentException($"libo11y: unknown redact tag '{tag}' (expected mask, redact, omit, confidential, or secret)", nameof(tag)),
    };

    public static bool HasRedactAttributes(Type type) =>
        type.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Any(p => p.GetCustomAttribute<O11yRedactAttribute>() is not null);

    public static bool IsRedactable(object? value) =>
        value is IRedactableValue || (value is not null && HasRedactAttributes(value.GetType()));

    public static object? Render(object? value)
    {
        var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
        return RenderInternal(value, seen, 0);
    }

    private static object? RenderInternal(object? value, HashSet<object> seen, int depth)
    {
        if (value is null) return null;
        if (depth > 16) return Internal.PiiTokenizer.CanonicalTruncated;
        if (value is IRedactableValue r) return r.AsRedacted();

        if (value is string or bool or byte or sbyte or short or ushort or int or uint or long or ulong or float or double or decimal)
        {
            return value;
        }

        if (!seen.Add(value)) return Internal.PiiTokenizer.CanonicalTruncated;
        try
        {
            if (value is IDictionary dict)
            {
                var result = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (DictionaryEntry entry in dict)
                {
                    result[entry.Key?.ToString() ?? ""] = RenderInternal(entry.Value, seen, depth + 1);
                }
                return result;
            }
            if (value is IEnumerable seq)
            {
                var list = new List<object?>();
                foreach (object? el in seq)
                {
                    list.Add(RenderInternal(el, seen, depth + 1));
                }
                return list;
            }
            var type = value.GetType();
            if (HasRedactAttributes(type))
            {
                var obj = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                {
                    if (!prop.CanRead) continue;
                    var attr = prop.GetCustomAttribute<O11yRedactAttribute>();
                    object? pv = prop.GetValue(value);
                    if (attr is not null)
                    {
                        switch (attr.Action)
                        {
                            case RedactAction.Omit:
                                continue;
                            case RedactAction.Redact:
                                obj[prop.Name] = RedactedLiteral;
                                continue;
                            case RedactAction.Mask:
                                obj[prop.Name] = MaskString(pv?.ToString() ?? "");
                                continue;
                        }
                    }
                    obj[prop.Name] = RenderInternal(pv, seen, depth + 1);
                }
                return obj;
            }
            return value;
        }
        finally
        {
            seen.Remove(value);
        }
    }
}
