using System.Text;

namespace Libo11y.Spec;

/// <summary>
/// Go's <c>strconv.Quote</c> (the <c>%q</c> verb), backed by specgen's
/// <see cref="GoPrintRanges"/> table, so violation details quote values
/// exactly as the Go validator does.
/// </summary>
internal static class GoQuote
{
    /// <summary>Reports whether Go's <c>unicode.IsPrint</c> accepts <paramref name="codepoint"/>.</summary>
    /// <param name="codepoint">A Unicode code point.</param>
    /// <returns><see langword="true"/> when the code point prints as itself in a quoted string.</returns>
    public static bool IsPrintable(int codepoint)
    {
        var ranges = GoPrintRanges.Ranges;
        int lo = 0;
        int hi = ranges.Length;
        while (lo < hi)
        {
            int mid = (lo + hi) >> 1;
            if (ranges[mid] < codepoint)
            {
                lo = mid + 1;
            }
            else
            {
                hi = mid;
            }
        }
        return lo < ranges.Length && ((lo & 1) == 1 || ranges[lo] == codepoint);
    }

    /// <summary>Quotes <paramref name="s"/> as Go's <c>strconv.Quote</c> does.</summary>
    /// <param name="s">The text to quote.</param>
    /// <returns>The double-quoted, escaped text.</returns>
    public static string Quote(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (var rune in s.EnumerateRunes())
        {
            int cp = rune.Value;
            if (cp == '"' || cp == '\\')
            {
                sb.Append('\\');
                sb.Append((char)cp);
            }
            else if (IsPrintable(cp))
            {
                sb.Append(rune.ToString());
            }
            else
            {
                switch (cp)
                {
                    case '\a': sb.Append("\\a"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\v': sb.Append("\\v"); break;
                    default:
                        if (cp < 0x20 || cp == 0x7F)
                        {
                            sb.Append($"\\x{cp:x2}");
                        }
                        else if (cp < 0x10000)
                        {
                            sb.Append($"\\u{cp:x4}");
                        }
                        else
                        {
                            sb.Append($"\\U{cp:x8}");
                        }
                        break;
                }
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
