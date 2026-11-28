using System.Text;
using System.Text.RegularExpressions;

namespace Libo11y.Db;

public static class SqlSanitizer
{
    private static readonly HashSet<string> SupportedSystems = new(StringComparer.OrdinalIgnoreCase)
    {
        "postgresql", "sqlite", "mysql", "mariadb", "mssql",
    };

    private static readonly Regex WhitespaceRe = new(@"\s+", RegexOptions.Compiled);
    private static readonly Regex OpRe = new(@"^\s*([A-Za-z]+)", RegexOptions.Compiled);

    public static string? Sanitize(string sql, string dbSystem)
    {
        if (!SupportedSystems.Contains(dbSystem)) return null;

        var sb = new StringBuilder(sql.Length);
        int i = 0;
        int len = sql.Length;
        while (i < len)
        {
            char ch = sql[i];
            if (ch == '-' && i + 1 < len && sql[i + 1] == '-')
            {
                int nl = sql.IndexOf('\n', i);
                i = nl == -1 ? len : nl + 1;
                sb.Append(' ');
            }
            else if (ch == '/' && i + 1 < len && sql[i + 1] == '*')
            {
                int close = sql.IndexOf("*/", i + 2, StringComparison.Ordinal);
                i = close == -1 ? len : close + 2;
                sb.Append(' ');
            }
            else if (ch == '\'')
            {
                i++;
                while (i < len)
                {
                    if (sql[i] == '\'' && i + 1 < len && sql[i + 1] == '\'') i += 2;
                    else if (sql[i] == '\'') { i++; break; }
                    else i++;
                }
                sb.Append('?');
            }
            else if (ch == '0' && i + 1 < len && sql[i + 1] is 'x' or 'X' &&
                     (i == 0 || !IsIdentChar(sql[i - 1])))
            {
                i += 2;
                while (i < len && Uri.IsHexDigit(sql[i])) i++;
                sb.Append('?');
            }
            else if (ch is >= '0' and <= '9' && (i == 0 || (!IsIdentChar(sql[i - 1]) && sql[i - 1] != '$')))
            {
                while (i < len && (sql[i] is (>= '0' and <= '9') or '.')) i++;
                if (i < len && sql[i] is 'e' or 'E')
                {
                    i++;
                    if (i < len && sql[i] is '+' or '-') i++;
                    while (i < len && sql[i] is >= '0' and <= '9') i++;
                }
                sb.Append('?');
            }
            else
            {
                sb.Append(ch);
                i++;
            }
        }
        return WhitespaceRe.Replace(sb.ToString().Trim(), " ");
    }

    public static string ExtractOperation(string sql)
    {
        var m = OpRe.Match(sql);
        return m.Success ? m.Groups[1].Value.ToUpperInvariant() : "QUERY";
    }

    private static bool IsIdentChar(char c) =>
        (c is >= 'a' and <= 'z') || (c is >= 'A' and <= 'Z') || (c is >= '0' and <= '9') || c == '_';
}
