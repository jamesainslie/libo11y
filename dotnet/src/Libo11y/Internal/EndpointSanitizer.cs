using System.Text;

namespace Libo11y.Internal;

/// <summary>
/// Byte-exact port of Go's net/url.Parse + URL.String() endpoint sanitization.
/// </summary>
public static class EndpointSanitizer
{
    public const string Withheld = "unparseable";
    private const string HexUpper = "0123456789ABCDEF";

    private enum Mode { Path, Host, Zone, UserPassword, Fragment }

    private sealed class InvalidUrlException : Exception { }

    private sealed class ParsedUrl
    {
        public string Scheme = "";
        public byte[] OpaqueText = [];
        public bool HasUser;
        public byte[] Host = [];
        public byte[] Path = [];
        public byte[] RawPath = [];
        public bool OmitHost;
    }

    private static bool IsAlnum(byte c) =>
        (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);

    private static bool IsHex(byte c) =>
        (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

    private static int Unhex(byte c) =>
        c is >= 0x30 and <= 0x39 ? c - 0x30 :
        c is >= 0x61 and <= 0x66 ? c - 0x61 + 10 : c - 0x41 + 10;

    private static bool IsHostOk(byte c) =>
        c is (byte)'!' or (byte)'$' or (byte)'&' or (byte)'\'' or (byte)'(' or (byte)')' or
             (byte)'*' or (byte)'+' or (byte)',' or (byte)';' or (byte)'=' or (byte)':' or
             (byte)'<' or (byte)'>' or (byte)'"' or (byte)'[' or (byte)']';

    private static bool IsGenDelim(byte c) =>
        c is (byte)'$' or (byte)'&' or (byte)'+' or (byte)',' or (byte)'/' or
             (byte)':' or (byte)';' or (byte)'=' or (byte)'?' or (byte)'@';

    private static bool IsUnreservedPunct(byte c) =>
        c is (byte)'-' or (byte)'_' or (byte)'.' or (byte)'~';

    private static bool IsFragOk(byte c) =>
        c is (byte)'!' or (byte)'(' or (byte)')' or (byte)'*';

    private static bool IsUserinfoPunct(byte c) =>
        c is (byte)'-' or (byte)'.' or (byte)'_' or (byte)':' or (byte)'~' or
             (byte)'!' or (byte)'$' or (byte)'&' or (byte)'\'' or (byte)'(' or
             (byte)')' or (byte)'*' or (byte)'+' or (byte)',' or (byte)';' or
             (byte)'=' or (byte)'%' or (byte)'@';

    private static bool IsValidEncExtra(byte c) =>
        c is (byte)'!' or (byte)'$' or (byte)'&' or (byte)'\'' or (byte)'(' or
             (byte)')' or (byte)'*' or (byte)'+' or (byte)',' or (byte)';' or
             (byte)'=' or (byte)':' or (byte)'@' or (byte)'[' or (byte)']' or (byte)'%';

    private static bool ShouldEscape(byte c, Mode mode)
    {
        if (IsAlnum(c)) return false;
        if (mode is Mode.Host or Mode.Zone && IsHostOk(c)) return false;
        if (IsUnreservedPunct(c)) return false;
        if (IsGenDelim(c))
        {
            if (mode == Mode.Path) return c == (byte)'?';
            if (mode == Mode.UserPassword) return c is (byte)'@' or (byte)'/' or (byte)'?' or (byte)':';
            return mode != Mode.Fragment;
        }
        return !(mode == Mode.Fragment && IsFragOk(c));
    }

    private static byte[] Unescape(ReadOnlySpan<byte> s, Mode mode)
    {
        int n = 0;
        int i = 0;
        while (i < s.Length)
        {
            byte c = s[i];
            if (c == 0x25)
            {
                n++;
                if (i + 2 >= s.Length || !IsHex(s[i + 1]) || !IsHex(s[i + 2]))
                {
                    throw new InvalidUrlException();
                }
                bool pct25 = s[i + 1] == (byte)'2' && s[i + 2] == (byte)'5';
                if (mode == Mode.Host && Unhex(s[i + 1]) < 8 && !pct25)
                {
                    throw new InvalidUrlException();
                }
                if (mode == Mode.Zone)
                {
                    byte v = (byte)((Unhex(s[i + 1]) << 4) | Unhex(s[i + 2]));
                    if (!pct25 && v != 0x20 && ShouldEscape(v, Mode.Host))
                    {
                        throw new InvalidUrlException();
                    }
                }
                i += 3;
            }
            else
            {
                if (mode is Mode.Host or Mode.Zone && c < 0x80 && ShouldEscape(c, mode))
                {
                    throw new InvalidUrlException();
                }
                i++;
            }
        }
        if (n == 0) return s.ToArray();
        byte[] output = new byte[s.Length - 2 * n];
        int j = 0;
        i = 0;
        while (i < s.Length)
        {
            if (s[i] == 0x25)
            {
                output[j++] = (byte)((Unhex(s[i + 1]) << 4) | Unhex(s[i + 2]));
                i += 3;
            }
            else
            {
                output[j++] = s[i++];
            }
        }
        return output;
    }

    private static byte[] Escape(ReadOnlySpan<byte> s, Mode mode)
    {
        int count = 0;
        foreach (byte c in s)
        {
            if (ShouldEscape(c, mode)) count++;
        }
        if (count == 0) return s.ToArray();
        byte[] output = new byte[s.Length + 2 * count];
        int j = 0;
        foreach (byte c in s)
        {
            if (ShouldEscape(c, mode))
            {
                output[j++] = 0x25;
                output[j++] = (byte)HexUpper[c >> 4];
                output[j++] = (byte)HexUpper[c & 0x0F];
            }
            else
            {
                output[j++] = c;
            }
        }
        return output;
    }

    private static bool ValidEncoded(ReadOnlySpan<byte> s, Mode mode)
    {
        foreach (byte c in s)
        {
            if (IsValidEncExtra(c)) continue;
            if (ShouldEscape(c, mode)) return false;
        }
        return true;
    }

    private static bool ValidOptionalPort(ReadOnlySpan<byte> port)
    {
        if (port.Length == 0) return true;
        if (port[0] != (byte)':') return false;
        for (int i = 1; i < port.Length; i++)
        {
            if (port[i] is < 0x30 or > 0x39) return false;
        }
        return true;
    }

    private static bool ValidUserinfo(ReadOnlySpan<byte> s)
    {
        foreach (byte c in s)
        {
            if (!IsAlnum(c) && !IsUserinfoPunct(c)) return false;
        }
        return true;
    }

    private static (byte[] Scheme, byte[] Remainder) GetScheme(ReadOnlySpan<byte> raw)
    {
        for (int i = 0; i < raw.Length; i++)
        {
            byte c = raw[i];
            if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A)) continue;
            if ((c >= 0x30 && c <= 0x39) || c is (byte)'+' or (byte)'-' or (byte)'.')
            {
                if (i == 0) return ([], raw.ToArray());
                continue;
            }
            if (c == (byte)':')
            {
                if (i == 0) throw new InvalidUrlException();
                return (raw[..i].ToArray(), raw[(i + 1)..].ToArray());
            }
            return ([], raw.ToArray());
        }
        return ([], raw.ToArray());
    }

    private static bool ValidIpv4(ReadOnlySpan<byte> s)
    {
        int val = 0, pos = 0, digLen = 0;
        for (int i = 0; i < s.Length; i++)
        {
            byte c = s[i];
            if (c is >= 0x30 and <= 0x39)
            {
                if (digLen == 1 && val == 0) return false;
                val = val * 10 + (c - 0x30);
                digLen++;
                if (val > 255) return false;
            }
            else if (c == (byte)'.')
            {
                if (i == 0 || i == s.Length - 1 || s[i - 1] == (byte)'.') return false;
                if (pos == 3) return false;
                pos++;
                val = 0;
                digLen = 0;
            }
            else return false;
        }
        return pos == 3;
    }

    private static bool ParseIpv6(ReadOnlySpan<byte> data)
    {
        var s = data;
        int pct = s.IndexOf((byte)'%');
        if (pct != -1)
        {
            if (pct + 1 == s.Length) return false;
            s = s[..pct];
        }
        int? ellipsis = null;
        if (s.Length >= 2 && s[0] == (byte)':' && s[1] == (byte)':')
        {
            ellipsis = 0;
            s = s[2..];
            if (s.Length == 0) return true;
        }
        int i = 0;
        while (i < 16)
        {
            int off = 0, acc = 0;
            while (off < s.Length)
            {
                byte c = s[off];
                if (!IsHex(c)) break;
                acc = (acc << 4) + Unhex(c);
                if (off > 3 || acc > 0xFFFF) return false;
                off++;
            }
            if (off == 0) return false;
            if (off < s.Length && s[off] == (byte)'.')
            {
                if (ellipsis is null && i != 12) return false;
                if (i + 4 > 16 || !ValidIpv4(s)) return false;
                s = [];
                i += 4;
                break;
            }
            i += 2;
            s = s[off..];
            if (s.Length == 0) break;
            if (s[0] != (byte)':' || s.Length == 1) return false;
            s = s[1..];
            if (s[0] == (byte)':')
            {
                if (ellipsis is not null) return false;
                ellipsis = i;
                s = s[1..];
                if (s.Length == 0) break;
            }
        }
        if (s.Length > 0) return false;
        return (i < 16) == (ellipsis is not null);
    }

    private static bool IsIpv6Literal(ReadOnlySpan<byte> s)
    {
        foreach (byte c in s)
        {
            if (c is (byte)'.' or (byte)'%') return false;
            if (c == (byte)':') return ParseIpv6(s);
        }
        return false;
    }

    private static byte[] ParseHost(string scheme, ReadOnlySpan<byte> host)
    {
        int openIdx = host.LastIndexOf((byte)'[');
        if (openIdx != -1)
        {
            if (openIdx > 0) throw new InvalidUrlException();
            int closeIdx = host.LastIndexOf((byte)']');
            if (closeIdx == -1) throw new InvalidUrlException();
            var colonPort = host[(closeIdx + 1)..];
            if (!ValidOptionalPort(colonPort)) throw new InvalidUrlException();
            byte[] port = Unescape(colonPort, Mode.Host);
            var hostname = host[1..closeIdx];
            int zone = hostname.IndexOf("%25"u8);
            byte[] unescaped;
            if (zone != -1)
            {
                byte[] a = Unescape(hostname[..zone], Mode.Host);
                byte[] b = Unescape(hostname[zone..], Mode.Zone);
                unescaped = [.. a, .. b];
            }
            else
            {
                unescaped = Unescape(hostname, Mode.Host);
            }
            if (!IsIpv6Literal(unescaped)) throw new InvalidUrlException();
            return [(byte)'[', .. unescaped, (byte)']', .. port];
        }

        int first = host.IndexOf((byte)':');
        if (first != -1)
        {
            int idx = first;
            int last = host.LastIndexOf((byte)':');
            if (last != first && scheme is not ("http" or "https")) idx = last;
            if (!ValidOptionalPort(host[idx..])) throw new InvalidUrlException();
        }
        return Unescape(host, Mode.Host);
    }

    private static void ParseAuthority(ParsedUrl url, ReadOnlySpan<byte> authority)
    {
        int at = authority.LastIndexOf((byte)'@');
        url.Host = ParseHost(url.Scheme, at != -1 ? authority[(at + 1)..] : authority);
        if (at == -1) return;
        var userinfo = authority[..at];
        if (!ValidUserinfo(userinfo)) throw new InvalidUrlException();
        int colon = userinfo.IndexOf((byte)':');
        if (colon != -1)
        {
            Unescape(userinfo[..colon], Mode.UserPassword);
            Unescape(userinfo[(colon + 1)..], Mode.UserPassword);
        }
        else
        {
            Unescape(userinfo, Mode.UserPassword);
        }
        url.HasUser = true;
    }

    private static ParsedUrl ParseReference(ReadOnlySpan<byte> raw)
    {
        foreach (byte c in raw)
        {
            if (c < 0x20 || c == 0x7F) throw new InvalidUrlException();
        }
        var url = new ParsedUrl();
        if (raw.SequenceEqual("*"u8))
        {
            url.Path = [(byte)'*'];
            return url;
        }
        var (schemeBytes, restArr) = GetScheme(raw);
        ReadOnlySpan<byte> rest = restArr;
        url.Scheme = Encoding.ASCII.GetString(schemeBytes).ToLowerInvariant();

        int qCount = 0;
        foreach (byte c in rest) if (c == (byte)'?') qCount++;
        if (rest.Length > 0 && rest[^1] == (byte)'?' && qCount == 1)
        {
            rest = rest[..^1];
        }
        else
        {
            int q = rest.IndexOf((byte)'?');
            if (q != -1) rest = rest[..q];
        }

        if (rest.Length == 0 || rest[0] != (byte)'/')
        {
            if (url.Scheme.Length > 0)
            {
                url.OpaqueText = rest.ToArray();
                return url;
            }
            int slash = rest.IndexOf((byte)'/');
            var seg = slash != -1 ? rest[..slash] : rest;
            if (seg.IndexOf((byte)':') != -1) throw new InvalidUrlException();
        }

        if ((url.Scheme.Length > 0 || !rest.StartsWith("///"u8)) && rest.StartsWith("//"u8))
        {
            var authority = rest[2..];
            rest = [];
            int slash = authority.IndexOf((byte)'/');
            if (slash != -1)
            {
                rest = authority[slash..];
                authority = authority[..slash];
            }
            ParseAuthority(url, authority);
        }
        else if (url.Scheme.Length > 0 && rest.Length > 0 && rest[0] == (byte)'/')
        {
            url.OmitHost = true;
        }

        url.Path = Unescape(rest, Mode.Path);
        byte[] escaped = Escape(url.Path, Mode.Path);
        url.RawPath = rest.SequenceEqual(escaped) ? [] : rest.ToArray();
        return url;
    }

    private static ParsedUrl Parse(ReadOnlySpan<byte> raw)
    {
        int h = raw.IndexOf((byte)'#');
        var url = ParseReference(h != -1 ? raw[..h] : raw);
        if (h != -1 && h + 1 < raw.Length)
        {
            Unescape(raw[(h + 1)..], Mode.Fragment);
        }
        return url;
    }

    private static byte[] EscapedPath(ParsedUrl url)
    {
        if (url.RawPath.Length > 0 && ValidEncoded(url.RawPath, Mode.Path))
        {
            try
            {
                byte[] p = Unescape(url.RawPath, Mode.Path);
                if (p.AsSpan().SequenceEqual(url.Path)) return url.RawPath;
            }
            catch (InvalidUrlException)
            {
                // fall through
            }
        }
        if (url.Path.AsSpan().SequenceEqual("*"u8)) return [(byte)'*'];
        return Escape(url.Path, Mode.Path);
    }

    private static byte[] Format(ParsedUrl url)
    {
        var outBytes = new List<byte>();
        if (url.Scheme.Length > 0)
        {
            outBytes.AddRange(Encoding.ASCII.GetBytes(url.Scheme));
            outBytes.Add((byte)':');
        }
        if (url.OpaqueText.Length > 0)
        {
            outBytes.AddRange(url.OpaqueText);
            return [.. outBytes];
        }
        if ((url.Scheme.Length > 0 || url.Host.Length > 0) && !(url.OmitHost && url.Host.Length == 0))
        {
            if (url.Host.Length > 0 || url.Path.Length > 0)
            {
                outBytes.Add((byte)'/');
                outBytes.Add((byte)'/');
            }
            if (url.Host.Length > 0)
            {
                outBytes.AddRange(Escape(url.Host, Mode.Host));
            }
        }
        byte[] path = EscapedPath(url);
        if (path.Length > 0 && path[0] != (byte)'/' && url.Host.Length > 0)
        {
            outBytes.Add((byte)'/');
        }
        if (outBytes.Count == 0)
        {
            int slash = Array.IndexOf(path, (byte)'/');
            var seg = slash != -1 ? path.AsSpan(0, slash) : path.AsSpan();
            if (seg.IndexOf((byte)':') != -1)
            {
                outBytes.Add((byte)'.');
                outBytes.Add((byte)'/');
            }
        }
        outBytes.AddRange(path);
        return [.. outBytes];
    }

    public static string Sanitize(string raw) => SanitizeBytes(Encoding.UTF8.GetBytes(raw));

    public static string SanitizeBytes(ReadOnlySpan<byte> raw)
    {
        bool schemeless = raw.IndexOf("://"u8) == -1;
        byte[] data = schemeless ? [(byte)'/', (byte)'/', .. raw] : raw.ToArray();
        ParsedUrl url;
        try
        {
            url = Parse(data);
        }
        catch (InvalidUrlException)
        {
            return Withheld;
        }
        if (url.Host.Length == 0) return Withheld;

        int ats = 0;
        foreach (byte c in data) if (c == (byte)'@') ats++;
        if (ats > 1 || (ats == 1 && !url.HasUser)) return Withheld;

        byte[] formatted = Format(url);
        if (Array.IndexOf(formatted, (byte)'@') != -1) return Withheld;

        ReadOnlySpan<byte> finalSpan = formatted;
        if (schemeless && finalSpan.StartsWith("//"u8))
        {
            finalSpan = finalSpan[2..];
        }
        return Encoding.ASCII.GetString(finalSpan);
    }
}
