using Libo11y.Spec;

namespace Libo11y.Cli;

/// <summary>
/// The <c>libo11y</c> command: <c>libo11y registry check FILE...</c> validates
/// application attribute registries (SPEC section 5a). It matches
/// <c>go/cmd/libo11y</c>: the same output lines, streams and exit statuses.
/// </summary>
internal static class CommandLine
{
    /// <summary>The usage line, printed for help and for a usage error.</summary>
    public const string Usage = "usage: libo11y registry check FILE...";

    /// <summary>Exit status when every file is valid.</summary>
    public const int ExitOk = 0;

    /// <summary>Exit status when a file breaks a policy rule.</summary>
    public const int ExitViolations = 1;

    /// <summary>Exit status for a usage error, or a file that cannot be read or parsed.</summary>
    public const int ExitError = 2;

    /// <summary>
    /// Runs the command. <c>-h</c>, <c>--help</c> or <c>help</c> alone print
    /// the usage line to <paramref name="stdout"/> and return 0. Any other
    /// command line that is not <c>registry check</c> with at least one file
    /// prints it to <paramref name="stderr"/> and returns 2. Otherwise every
    /// file is checked, and the highest status of any file is returned.
    /// </summary>
    /// <param name="args">The command-line arguments, without the program name.</param>
    /// <param name="stdout">Where results go: one line per violation, or an ok line per valid file.</param>
    /// <param name="stderr">Where usage, read and parse errors go, one line each.</param>
    /// <returns>The exit status: 0, 1 or 2.</returns>
    public static int Run(string[] args, TextWriter stdout, TextWriter stderr)
    {
        if (args.Length == 1 && args[0] is "-h" or "--help" or "help")
        {
            WriteLine(stdout, Usage);
            return ExitOk;
        }
        if (args.Length < 3 || args[0] != "registry" || args[1] != "check")
        {
            WriteLine(stderr, Usage);
            return ExitError;
        }

        int status = ExitOk;
        foreach (string path in args.AsSpan(2))
        {
            status = Math.Max(status, CheckFile(path, stdout, stderr));
        }
        return status;
    }

    // Go writes "\n" on every platform, so the lines here do too.
    private static void WriteLine(TextWriter writer, string line) => writer.Write(line + "\n");

    private static int CheckFile(string path, TextWriter stdout, TextWriter stderr)
    {
        byte[] raw;
        try
        {
            raw = File.ReadAllBytes(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            WriteLine(stderr, ReadError(path, ex));
            return ExitError;
        }

        AppRegistry reg;
        try
        {
            reg = AppRegistryValidator.ParseBytes(raw);
        }
        catch (AppRegistryParseException ex)
        {
            WriteLine(stderr, $"{path}: {ex.Message}");
            return ExitError;
        }

        var violations = AppRegistryValidator.Validate(reg);
        foreach (var v in violations)
        {
            WriteLine(stdout, $"{path}: {v}");
        }
        if (violations.Count > 0)
        {
            return ExitViolations;
        }
        string noun = reg.Attributes.Count == 1 ? "attribute" : "attributes";
        WriteLine(stdout, $"{path}: ok ({reg.Attributes.Count} {noun} in namespace {reg.Namespace})");
        return ExitOk;
    }

    // ReadError renders a failed read the way Go prints the *fs.PathError
    // os.ReadFile returns: "open PATH: REASON", or "read PATH: is a directory"
    // when the open succeeds on a directory and the read fails.
    private static string ReadError(string path, Exception ex)
    {
        if (path.Length > 0 && !path.Contains('\0', StringComparison.Ordinal) && Directory.Exists(path))
        {
            return $"read {path}: is a directory";
        }
        string reason = ex switch
        {
            FileNotFoundException or DirectoryNotFoundException => "no such file or directory",
            UnauthorizedAccessException => "permission denied",
            PathTooLongException => "file name too long",
            ArgumentException when path.Length == 0 => "no such file or directory",
            ArgumentException or NotSupportedException => "invalid argument",
            _ => ex.Message,
        };
        return $"open {path}: {reason}";
    }
}
