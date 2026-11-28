using System.Collections;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Libo11y.Internal;

/// <summary>
/// Canonical PII rendering and HMAC-SHA256 tokenization matching conformance/vectors/pii-hash.json.
/// </summary>
public static class PiiTokenizer
{
    public const int MaxCompositeDepth = 16;
    public const int MaxCompositeNodes = 2048;
    public const string CanonicalTruncated = "truncated";
    public const int MinPiiHashKeyLen = 32;

    private sealed class Walk
    {
        private int _remaining = MaxCompositeNodes;
        private readonly HashSet<object> _active = new(ReferenceEqualityComparer.Instance);

        public bool Spend()
        {
            if (_remaining <= 0) return false;
            _remaining--;
            return true;
        }

        public bool Enter(object obj) => _active.Add(obj);
        public void Leave(object obj) => _active.Remove(obj);
    }

    public static string CanonicalFloat(double value)
    {
        if (double.IsNaN(value)) return "NaN";
        if (double.IsPositiveInfinity(value)) return "+Inf";
        if (double.IsNegativeInfinity(value)) return "-Inf";
        if (value == 0.0)
        {
            return BitConverter.DoubleToInt64Bits(value) < 0 ? "-0" : "0";
        }

        bool neg = value < 0;
        double absVal = neg ? -value : value;
        string s = absVal.ToString("R", CultureInfo.InvariantCulture);

        string mant;
        int exp;
        int eIdx = s.IndexOfAny(['e', 'E']);
        if (eIdx != -1)
        {
            mant = s[..eIdx];
            exp = int.Parse(s[(eIdx + 1)..], CultureInfo.InvariantCulture);
        }
        else
        {
            mant = s;
            exp = 0;
        }

        string digits;
        int dotIdx = mant.IndexOf('.');
        if (dotIdx != -1)
        {
            string intPart = mant[..dotIdx];
            string fracPart = mant[(dotIdx + 1)..];
            string digitsRaw = intPart + fracPart;
            string stripped = digitsRaw.TrimStart('0');
            int leadingZeros = digitsRaw.Length - stripped.Length;
            if (intPart == "0") exp -= leadingZeros;
            else exp += intPart.Length - 1;
            digits = stripped.TrimEnd('0');
        }
        else
        {
            exp += mant.Length - 1;
            digits = mant.TrimEnd('0');
        }

        if (digits.Length == 0) return neg ? "-0" : "0";

        string prefix = neg ? "-" : "";
        if (exp < -4 || exp >= 6)
        {
            string body = digits.Length == 1 ? digits : $"{digits[0]}.{digits[1..]}";
            string sign = exp >= 0 ? "+" : "-";
            int absExp = Math.Abs(exp);
            string expFmt = absExp < 100 ? absExp.ToString("D2", CultureInfo.InvariantCulture) : absExp.ToString(CultureInfo.InvariantCulture);
            return $"{prefix}{body}e{sign}{expFmt}";
        }

        if (exp < 0)
        {
            return $"{prefix}0.{new string('0', -exp - 1)}{digits}";
        }
        if (exp + 1 >= digits.Length)
        {
            return $"{prefix}{digits}{new string('0', exp + 1 - digits.Length)}";
        }
        int split = exp + 1;
        return $"{prefix}{digits[..split]}.{digits[split..]}";
    }

    private static string EncodeJsonString(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (char ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '<': sb.Append("\\u003c"); break;
                case '>': sb.Append("\\u003e"); break;
                case '&': sb.Append("\\u0026"); break;
                case '\u2028': sb.Append("\\u2028"); break;
                case '\u2029': sb.Append("\\u2029"); break;
                default:
                    if (ch < 0x20)
                    {
                        sb.Append($"\\u{(int)ch:x4}");
                    }
                    else
                    {
                        sb.Append(ch);
                    }
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    private static string RenderJsonNode(object node) => node switch
    {
        string s => EncodeJsonString(s),
        List<object> arr => "[" + string.Join(",", arr.Select(RenderJsonNode)) + "]",
        List<(string Key, object Value)> obj => "{" + string.Join(",", obj.Select(kv => $"{EncodeJsonString(kv.Key)}:{RenderJsonNode(kv.Value)}")) + "}",
        _ => EncodeJsonString(node.ToString() ?? ""),
    };

    private static int CompareUtf8(byte[] a, byte[] b) => a.AsSpan().SequenceCompareTo(b);

    private static object BuildNode(object? value, int depth, Walk walk)
    {
        if (depth > MaxCompositeDepth || !walk.Spend())
        {
            return CanonicalTruncated;
        }
        if (value is null) return "";
        if (value is bool b) return b ? "true" : "false";
        if (value is sbyte or byte or short or ushort or int or uint or long or ulong)
        {
            return Convert.ToString(value, CultureInfo.InvariantCulture) ?? "0";
        }
        if (value is float f) return CanonicalFloat(f);
        if (value is double d) return CanonicalFloat(d);
        if (value is decimal dec) return dec.ToString(CultureInfo.InvariantCulture);
        if (value is string s) return s;
        if (value is byte[] bytes) return Convert.ToBase64String(bytes);

        if (value is IDictionary dict)
        {
            if (!walk.Enter(dict)) return CanonicalTruncated;
            try
            {
                var pairs = new List<(byte[] Utf8Key, string Key, object? Val)>();
                foreach (DictionaryEntry entry in dict)
                {
                    string ks = entry.Key?.ToString() ?? "";
                    pairs.Add((Encoding.UTF8.GetBytes(ks), ks, entry.Value));
                }
                pairs.Sort((a, b) => CompareUtf8(a.Utf8Key, b.Utf8Key));
                var result = new List<(string Key, object Value)>(pairs.Count);
                foreach (var (_, ks, v) in pairs)
                {
                    result.Add((ks, BuildNode(v, depth + 1, walk)));
                }
                return result;
            }
            finally
            {
                walk.Leave(dict);
            }
        }

        if (value is IEnumerable<KeyValuePair<string, object?>> kvEnum)
        {
            if (!walk.Enter(value)) return CanonicalTruncated;
            try
            {
                var pairs = new List<(byte[] Utf8Key, string Key, object? Val)>();
                foreach (var kv in kvEnum)
                {
                    pairs.Add((Encoding.UTF8.GetBytes(kv.Key), kv.Key, kv.Value));
                }
                pairs.Sort((a, b) => CompareUtf8(a.Utf8Key, b.Utf8Key));
                var result = new List<(string Key, object Value)>(pairs.Count);
                foreach (var (_, ks, v) in pairs)
                {
                    result.Add((ks, BuildNode(v, depth + 1, walk)));
                }
                return result;
            }
            finally
            {
                walk.Leave(value);
            }
        }

        if (value is IEnumerable seq)
        {
            if (!walk.Enter(seq)) return CanonicalTruncated;
            try
            {
                var list = new List<object>();
                foreach (object? el in seq)
                {
                    list.Add(BuildNode(el, depth + 1, walk));
                }
                return list;
            }
            finally
            {
                walk.Leave(seq);
            }
        }

        return value.ToString() ?? "";
    }

    public static string CanonicalValue(object? value)
    {
        var node = BuildNode(value, 0, new Walk());
        if (node is string s) return s;
        return RenderJsonNode(node);
    }

    public static string Token(byte[] key, object? value)
    {
        string canonical = CanonicalValue(value);
        byte[] digest = HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(canonical));
        return "hmac-sha256:" + Convert.ToHexString(digest.AsSpan(0, 16)).ToLowerInvariant();
    }
}
