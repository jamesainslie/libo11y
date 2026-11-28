using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;

namespace Libo11y.Spec;

internal sealed class YamlV3SyntaxException : Exception
{
    public YamlV3SyntaxException(string message) : base(message) { }
    public YamlV3SyntaxException(string message, Exception inner) : base(message, inner) { }
}

internal abstract class YamlV3Node
{
    public string? Tag { get; init; }
    public string? Anchor { get; init; }
}

internal sealed class YamlV3Scalar : YamlV3Node
{
    public required string Value { get; init; }
    public required bool QuotedOrBlock { get; init; }
}

internal sealed class YamlV3Sequence : YamlV3Node
{
    public List<YamlV3Node> Items { get; } = [];
}

internal sealed class YamlV3Mapping : YamlV3Node
{
    public List<(YamlV3Node Key, YamlV3Node Value)> Pairs { get; } = [];
}

internal sealed class YamlV3Alias : YamlV3Node
{
    public required string TargetAnchor { get; init; }
}

internal sealed class YamlV3Document
{
    public required YamlV3Node Root { get; init; }
    public required bool ExplicitStart { get; init; }
    public required Dictionary<YamlV3Alias, YamlV3Node> Aliases { get; init; }
}

internal readonly record struct ScalarValue(bool IsNull, string Text, bool IsString);

internal static partial class YamlV3Parser
{
    private const string LongTagPrefix = "tag:yaml.org,2002:";
    private const string TagNull = "!!null";
    private const string TagBool = "!!bool";
    private const string TagStr = "!!str";
    private const string TagInt = "!!int";
    private const string TagFloat = "!!float";
    private const string TagTimestamp = "!!timestamp";
    private const string TagBinary = "!!binary";
    private const string TagMerge = "!!merge";

    private const int MaxDepth = 10_000;
    private const double AliasRatioLow = 400_000.0;
    private const double AliasRatioHigh = 4_000_000.0;

    private static readonly HashSet<string> ResolvableTags =
    [
        "", TagStr, TagBool, TagInt, TagFloat, TagNull, TagTimestamp
    ];

    private static readonly HashSet<string> MergeTags = ["", "!", TagMerge];

    private static readonly Dictionary<string, string> ResolveMap = new(StringComparer.Ordinal)
    {
        ["true"] = TagBool, ["True"] = TagBool, ["TRUE"] = TagBool,
        ["false"] = TagBool, ["False"] = TagBool, ["FALSE"] = TagBool,
        [""] = TagNull, ["~"] = TagNull, ["null"] = TagNull, ["Null"] = TagNull, ["NULL"] = TagNull,
        [".nan"] = TagFloat, [".NaN"] = TagFloat, [".NAN"] = TagFloat,
        [".inf"] = TagFloat, [".Inf"] = TagFloat, [".INF"] = TagFloat,
        ["+.inf"] = TagFloat, ["+.Inf"] = TagFloat, ["+.INF"] = TagFloat,
        ["-.inf"] = TagFloat, ["-.Inf"] = TagFloat, ["-.INF"] = TagFloat,
        ["<<"] = TagMerge,
    };

    private static readonly Regex YamlStyleFloatRe = new(
        @"^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$",
        RegexOptions.Compiled);

    private static readonly Regex DotFloatRe = new(
        @"^\.[0-9]+([eE][-+]?[0-9]+)?$",
        RegexOptions.Compiled);

    private static readonly Regex Base64Re = new(
        @"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
        RegexOptions.Compiled);

    private static readonly Regex[] TimestampRes =
    [
        new(@"^(\d{4})-(\d\d?)-(\d\d?)T(\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?(Z|[+-](\d\d):(\d\d))$", RegexOptions.Compiled),
        new(@"^(\d{4})-(\d\d?)-(\d\d?)t(\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?(Z|[+-](\d\d):(\d\d))$", RegexOptions.Compiled),
        new(@"^(\d{4})-(\d\d?)-(\d\d?) (\d\d?):(\d\d?):(\d\d?)(?:[.,]\d+)?$", RegexOptions.Compiled),
        new(@"^(\d{4})-(\d\d?)-(\d\d?)$", RegexOptions.Compiled),
    ];

    public static string DecodeInput(ReadOnlySpan<byte> raw)
    {
        string text;
        try
        {
            if (raw.Length >= 2 && raw[0] == 0xFF && raw[1] == 0xFE)
            {
                text = new UnicodeEncoding(false, false, true).GetString(raw[2..]);
            }
            else if (raw.Length >= 2 && raw[0] == 0xFE && raw[1] == 0xFF)
            {
                text = new UnicodeEncoding(true, false, true).GetString(raw[2..]);
            }
            else if (raw.Length >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF)
            {
                text = new UTF8Encoding(false, true).GetString(raw[3..]);
            }
            else
            {
                text = new UTF8Encoding(false, true).GetString(raw);
            }
        }
        catch (DecoderFallbackException ex)
        {
            throw new YamlV3SyntaxException("invalid UTF input", ex);
        }

        CheckCharacters(text);
        return text;
    }

    public static void CheckCharacters(string text)
    {
        for (int i = 0; i < text.Length; i++)
        {
            char c = text[i];
            if (char.IsHighSurrogate(c))
            {
                if (i + 1 >= text.Length || !char.IsLowSurrogate(text[i + 1]))
                {
                    throw new YamlV3SyntaxException($"control characters are not allowed: U+{(int)c:X4}");
                }
                i++;
                continue;
            }
            if (char.IsLowSurrogate(c))
            {
                throw new YamlV3SyntaxException($"control characters are not allowed: U+{(int)c:X4}");
            }
            int cp = c;
            bool ok = cp == '\t' || cp == '\n' || cp == '\r' ||
                      (cp >= 0x20 && cp <= 0x7E) ||
                      cp == 0x85 ||
                      (cp >= 0xA0 && cp <= 0xD7FF) ||
                      (cp >= 0xE000 && cp <= 0xFFFD);
            if (!ok)
            {
                throw new YamlV3SyntaxException($"control characters are not allowed: U+{cp:X4}");
            }
        }
    }

    private static string PreprocessDoubleQuotedEscapes(string text)
    {
        var sb = new StringBuilder(text.Length);
        int i = 0;
        int len = text.Length;
        bool inSingle = false;
        bool inDouble = false;
        bool inComment = false;

        while (i < len)
        {
            char ch = text[i];
            if (inComment)
            {
                sb.Append(ch);
                if (ch == '\n' || ch == '\r')
                {
                    inComment = false;
                }
                i++;
            }
            else if (inSingle)
            {
                sb.Append(ch);
                if (ch == '\'')
                {
                    if (i + 1 < len && text[i + 1] == '\'')
                    {
                        sb.Append('\'');
                        i += 2;
                    }
                    else
                    {
                        inSingle = false;
                        i++;
                    }
                }
                else
                {
                    i++;
                }
            }
            else if (inDouble)
            {
                if (ch == '\\')
                {
                    if (i + 1 >= len)
                    {
                        throw new YamlV3SyntaxException("unterminated escape in double-quoted scalar");
                    }
                    char nxt = text[i + 1];
                    if (nxt == '/')
                    {
                        throw new YamlV3SyntaxException("found unknown escape character '/'");
                    }
                    if (nxt == '\'')
                    {
                        sb.Append('\'');
                        i += 2;
                    }
                    else if (nxt == 'u' && i + 5 < len)
                    {
                        var hex = text.AsSpan(i + 2, 4);
                        if (int.TryParse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out int cp) &&
                            cp >= 0xD800 && cp <= 0xDFFF)
                        {
                            throw new YamlV3SyntaxException("found invalid Unicode character escape code");
                        }
                        sb.Append(ch);
                        sb.Append(nxt);
                        i += 2;
                    }
                    else
                    {
                        sb.Append(ch);
                        sb.Append(nxt);
                        i += 2;
                    }
                }
                else
                {
                    sb.Append(ch);
                    if (ch == '"')
                    {
                        inDouble = false;
                    }
                    i++;
                }
            }
            else
            {
                if (ch == '#' && (i == 0 || text[i - 1] is ' ' or '\t' or '\n' or '\r'))
                {
                    inComment = true;
                }
                else if (ch == '\'')
                {
                    inSingle = true;
                }
                else if (ch == '"')
                {
                    inDouble = true;
                }
                sb.Append(ch);
                i++;
            }
        }

        return sb.ToString();
    }

    public static List<YamlV3Document> ParseDocuments(string text)
    {
        CheckCharacters(text);
        var normalized = PreprocessDoubleQuotedEscapes(text);

        var docs = new List<YamlV3Document>();
        try
        {
            var parser = new Parser(new StringReader(normalized));
            if (!parser.MoveNext() || parser.Current is not StreamStart)
            {
                return docs;
            }

            while (parser.MoveNext())
            {
                if (parser.Current is StreamEnd)
                {
                    break;
                }
                if (parser.Current is not DocumentStart docStart)
                {
                    throw new YamlV3SyntaxException($"unexpected YAML event {parser.Current}");
                }

                if (docStart.Version is not null &&
                    (docStart.Version.Version.Major != 1 || docStart.Version.Version.Minor != 1))
                {
                    throw new YamlV3SyntaxException("found incompatible YAML document");
                }

                var anchors = new Dictionary<string, YamlV3Node>(StringComparer.Ordinal);
                var aliases = new Dictionary<YamlV3Alias, YamlV3Node>(ReferenceEqualityComparer.Instance);

                if (!parser.MoveNext())
                {
                    throw new YamlV3SyntaxException("unexpected end of YAML stream");
                }

                var root = ComposeNode(parser, anchors, aliases, 0);

                if (parser.MoveNext() && parser.Current is not DocumentEnd)
                {
                    throw new YamlV3SyntaxException($"expected document end, got {parser.Current}");
                }

                docs.Add(new YamlV3Document
                {
                    Root = root,
                    ExplicitStart = !docStart.IsImplicit,
                    Aliases = aliases,
                });
            }
        }
        catch (YamlV3SyntaxException)
        {
            throw;
        }
        catch (YamlException ex)
        {
            throw new YamlV3SyntaxException(ex.Message, ex);
        }

        return docs;
    }

    private static YamlV3Node ComposeNode(
        IParser parser,
        Dictionary<string, YamlV3Node> anchors,
        Dictionary<YamlV3Alias, YamlV3Node> aliases,
        int depth)
    {
        if (depth > MaxDepth)
        {
            throw new YamlV3SyntaxException("the document nests too deeply");
        }

        var ev = parser.Current;
        switch (ev)
        {
            case AnchorAlias aliasEv:
            {
                string name = aliasEv.Value.Value;
                if (!anchors.TryGetValue(name, out var target))
                {
                    throw new YamlV3SyntaxException($"unknown anchor '{name}' referenced");
                }
                var node = new YamlV3Alias { TargetAnchor = name };
                aliases[node] = target;
                return node;
            }
            case Scalar scalarEv:
            {
                bool quotedOrBlock = scalarEv.Style != ScalarStyle.Plain;
                string? tag = scalarEv.Tag.IsEmpty ? null : scalarEv.Tag.Value;
                string? anchor = scalarEv.Anchor.IsEmpty ? null : scalarEv.Anchor.Value;
                var node = new YamlV3Scalar
                {
                    Tag = tag,
                    Value = scalarEv.Value,
                    QuotedOrBlock = quotedOrBlock,
                    Anchor = anchor,
                };
                if (anchor is not null)
                {
                    anchors[anchor] = node;
                }
                return node;
            }
            case SequenceStart seqStart:
            {
                string? tag = seqStart.Tag.IsEmpty ? null : seqStart.Tag.Value;
                string? anchor = seqStart.Anchor.IsEmpty ? null : seqStart.Anchor.Value;
                var seq = new YamlV3Sequence { Tag = tag, Anchor = anchor };
                if (anchor is not null)
                {
                    anchors[anchor] = seq;
                }
                while (parser.MoveNext() && parser.Current is not SequenceEnd)
                {
                    seq.Items.Add(ComposeNode(parser, anchors, aliases, depth + 1));
                }
                return seq;
            }
            case MappingStart mapStart:
            {
                string? tag = mapStart.Tag.IsEmpty ? null : mapStart.Tag.Value;
                string? anchor = mapStart.Anchor.IsEmpty ? null : mapStart.Anchor.Value;
                var mp = new YamlV3Mapping { Tag = tag, Anchor = anchor };
                if (anchor is not null)
                {
                    anchors[anchor] = mp;
                }
                while (parser.MoveNext() && parser.Current is not MappingEnd)
                {
                    var key = ComposeNode(parser, anchors, aliases, depth + 1);
                    if (!parser.MoveNext())
                    {
                        throw new YamlV3SyntaxException("unexpected end of mapping");
                    }
                    var val = ComposeNode(parser, anchors, aliases, depth + 1);
                    mp.Pairs.Add((key, val));
                }
                return mp;
            }
            default:
                throw new YamlV3SyntaxException($"unexpected YAML event {ev}");
        }
    }

    public static string ShortTag(string? tag)
    {
        if (string.IsNullOrEmpty(tag))
        {
            return "";
        }
        if (tag.StartsWith(LongTagPrefix, StringComparison.Ordinal))
        {
            return "!!" + tag[LongTagPrefix.Length..];
        }
        return tag;
    }

    private static char Hint(string s)
    {
        if (s.Length == 0)
        {
            return 'N';
        }
        char c = s[0];
        if (c is '+' or '-')
        {
            return 'S';
        }
        if (c is >= '0' and <= '9')
        {
            return 'D';
        }
        if ("yYnNtTfFoO~".Contains(c))
        {
            return 'M';
        }
        return c == '.' ? '.' : '\0';
    }

    private static bool TryParseDigits(string s, int numBase, out ulong result)
    {
        result = 0;
        if (s.Length == 0)
        {
            return false;
        }
        ulong ub = (ulong)numBase;
        foreach (char ch in s)
        {
            int d;
            if (ch is >= '0' and <= '9') d = ch - '0';
            else if (ch is >= 'a' and <= 'z') d = ch - 'a' + 10;
            else if (ch is >= 'A' and <= 'Z') d = ch - 'A' + 10;
            else return false;

            if (d >= numBase) return false;
            if (result > (ulong.MaxValue - (ulong)d) / ub) return false;
            result = result * ub + (ulong)d;
        }
        return true;
    }

    private static bool TryGoParseUInt(string s, int numBase, out ulong result)
    {
        result = 0;
        if (s.Length == 0) return false;
        int b = numBase;
        string digits = s;
        if (numBase == 0)
        {
            b = 10;
            if (s[0] == '0')
            {
                char p = s.Length > 1 ? char.ToLowerInvariant(s[1]) : '\0';
                if (s.Length >= 3 && p == 'b') { b = 2; digits = s[2..]; }
                else if (s.Length >= 3 && p == 'o') { b = 8; digits = s[2..]; }
                else if (s.Length >= 3 && p == 'x') { b = 16; digits = s[2..]; }
                else
                {
                    b = 8;
                    digits = s[1..];
                    if (digits.Length == 0 && s == "0")
                    {
                        result = 0;
                        return true;
                    }
                }
            }
        }
        return TryParseDigits(digits, b, out result);
    }

    private static bool TryGoParseInt(string s, int numBase)
    {
        if (s.Length == 0) return false;
        bool negative = s[0] == '-';
        string body = s[0] is '+' or '-' ? s[1..] : s;
        if (!TryGoParseUInt(body, numBase, out ulong n)) return false;
        ulong limit = negative ? (ulong)long.MaxValue + 1UL : (ulong)long.MaxValue;
        return n <= limit;
    }

    private static bool IsFiniteFloat(string s) =>
        double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out double v) && double.IsFinite(v);

    private static int DaysIn(int month, int year) => month switch
    {
        2 => (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)) ? 29 : 28,
        4 or 6 or 9 or 11 => 30,
        _ => 31,
    };

    private static bool IsTimestamp(string s)
    {
        if (s.Length < 5 || !char.IsAsciiDigit(s[0]) || !char.IsAsciiDigit(s[1]) ||
            !char.IsAsciiDigit(s[2]) || !char.IsAsciiDigit(s[3]) || s[4] != '-')
        {
            return false;
        }
        foreach (var re in TimestampRes)
        {
            var m = re.Match(s);
            if (!m.Success) continue;
            int year = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            int month = int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
            int day = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
            int hour = m.Groups.Count > 4 && m.Groups[4].Success ? int.Parse(m.Groups[4].Value, CultureInfo.InvariantCulture) : 0;
            int minute = m.Groups.Count > 5 && m.Groups[5].Success ? int.Parse(m.Groups[5].Value, CultureInfo.InvariantCulture) : 0;
            int second = m.Groups.Count > 6 && m.Groups[6].Success ? int.Parse(m.Groups[6].Value, CultureInfo.InvariantCulture) : 0;
            if (month < 1 || month > 12 || day < 1 || day > DaysIn(month, year)) continue;
            if (hour > 23 || minute > 59 || second > 59) continue;
            if (m.Groups.Count > 9 && m.Groups[8].Success && m.Groups[9].Success)
            {
                if (int.Parse(m.Groups[8].Value, CultureInfo.InvariantCulture) > 24 ||
                    int.Parse(m.Groups[9].Value, CultureInfo.InvariantCulture) > 60)
                {
                    continue;
                }
            }
            return true;
        }
        return false;
    }

    private static (string Tag, bool Unsigned) Classify(string tag, string s)
    {
        char h = Hint(s);
        if (h == '\0' || tag == TagStr) return (TagStr, false);
        if (ResolveMap.TryGetValue(s, out string? mapped)) return (mapped, false);
        if (h == '.' && DotFloatRe.IsMatch(s) && IsFiniteFloat(s)) return (TagFloat, false);

        if (h is 'D' or 'S')
        {
            if ((tag.Length == 0 || tag == TagTimestamp) && IsTimestamp(s)) return (TagTimestamp, false);
            string plain = s.Replace("_", "", StringComparison.Ordinal);
            if (TryGoParseInt(plain, 0)) return (TagInt, false);
            if (TryGoParseUInt(plain, 0, out _)) return (TagInt, true);
            if (YamlStyleFloatRe.IsMatch(plain) && IsFiniteFloat(plain)) return (TagFloat, false);
            if (plain.StartsWith("0b", StringComparison.Ordinal))
            {
                if (TryGoParseInt(plain[2..], 2)) return (TagInt, false);
                if (TryGoParseUInt(plain[2..], 2, out _)) return (TagInt, true);
            }
            else if (plain.StartsWith("-0b", StringComparison.Ordinal) && TryGoParseInt("-" + plain[3..], 2))
            {
                return (TagInt, false);
            }
            if (plain.StartsWith("0o", StringComparison.Ordinal))
            {
                if (TryGoParseInt(plain[2..], 8)) return (TagInt, false);
                if (TryGoParseUInt(plain[2..], 8, out _)) return (TagInt, true);
            }
            else if (plain.StartsWith("-0o", StringComparison.Ordinal) && TryGoParseInt("-" + plain[3..], 8))
            {
                return (TagInt, false);
            }
        }
        return (TagStr, false);
    }

    private static string DecodeBase64(string s)
    {
        string compact = s.Replace("\r", "", StringComparison.Ordinal).Replace("\n", "", StringComparison.Ordinal);
        if (!Base64Re.IsMatch(compact))
        {
            throw new YamlV3SyntaxException("!!binary value contains invalid base64 data");
        }
        byte[] raw = Convert.FromBase64String(compact);
        return Encoding.UTF8.GetString(raw);
    }

    public static ScalarValue ResolveScalar(string? tag, string value, bool quotedOrBlock)
    {
        string shortTag = ShortTag(tag);
        if (shortTag == TagStr || ((shortTag.Length == 0 || shortTag == "!") && quotedOrBlock))
        {
            return new ScalarValue(false, value, true);
        }
        if (!ResolvableTags.Contains(shortTag))
        {
            if (shortTag == TagBinary)
            {
                return new ScalarValue(false, DecodeBase64(value), true);
            }
            return new ScalarValue(false, value, true);
        }
        var (resolvedTag, unsigned) = Classify(shortTag, value);
        if (shortTag == TagFloat && resolvedTag == TagInt && !unsigned)
        {
            resolvedTag = TagFloat;
        }
        if (shortTag.Length > 0 && shortTag != resolvedTag)
        {
            throw new YamlV3SyntaxException($"cannot decode {resolvedTag} `{value}` as a {shortTag}");
        }
        if (resolvedTag == TagNull)
        {
            return new ScalarValue(true, "", false);
        }
        return new ScalarValue(false, value, resolvedTag is TagStr or TagMerge);
    }

    public static double AllowedAliasRatio(int decodes)
    {
        if (decodes <= AliasRatioLow) return 0.99;
        if (decodes >= AliasRatioHigh) return 0.10;
        return 0.99 - 0.89 * ((decodes - AliasRatioLow) / (AliasRatioHigh - AliasRatioLow));
    }

    public static bool IsMergeKey(YamlV3Node node) =>
        node is YamlV3Scalar s && !s.QuotedOrBlock && s.Value == "<<" && MergeTags.Contains(ShortTag(s.Tag));
}
