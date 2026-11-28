package ing.o11y.libo11y.cli;

import ing.o11y.libo11y.spec.AppRegistryValidator;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.file.AccessDeniedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

/**
 * The {@code libo11y} command-line tool. {@code libo11y registry check FILE...} validates application
 * attribute registries against the libo11y policy rules, for use in a consumer's CI. Its output matches
 * the Go binary ({@code go/cmd/libo11y}).
 *
 * <p>Exit status: 0 when every file is valid, 1 when a file breaks a policy rule, 2 on a usage, read, or
 * parse error. The highest status wins.
 */
public final class Main {
    private static final String USAGE = "usage: libo11y registry check FILE...";
    private static final Set<String> HELP = Set.of("-h", "--help", "help");

    private Main() {}

    /**
     * Runs the command line and exits with its status.
     *
     * @param args the command-line arguments
     */
    public static void main(String[] args) {
        int code = run(args, System.out, System.err);
        System.out.flush();
        System.err.flush();
        System.exit(code);
    }

    /**
     * Runs the command line and returns its exit status. The usage line on request, each file's ok line,
     * and each policy violation go to {@code out}. Usage, read, and parse errors go to {@code err}.
     *
     * @param args the command-line arguments
     * @param out the stream for results
     * @param err the stream for errors
     * @return 0 when every file is valid, 1 on a policy violation, 2 on a usage, read, or parse error
     */
    public static int run(String[] args, PrintStream out, PrintStream err) {
        if (args.length == 1 && HELP.contains(args[0])) {
            line(out, USAGE);
            return 0;
        }
        if (args.length < 3 || !"registry".equals(args[0]) || !"check".equals(args[1])) {
            line(err, USAGE);
            return 2;
        }
        int status = 0;
        for (int i = 2; i < args.length; i++) {
            status = Math.max(status, checkFile(args[i], out, err));
        }
        return status;
    }

    private static int checkFile(String path, PrintStream out, PrintStream err) {
        byte[] raw;
        try {
            raw = Files.readAllBytes(Path.of(path));
        } catch (IOException ex) {
            line(err, readError(path, ex));
            return 2;
        }
        AppRegistryValidator.AppRegistry reg;
        try {
            reg = AppRegistryValidator.parseBytes(raw);
        } catch (AppRegistryValidator.AppRegistryParseException ex) {
            line(err, path + ": " + ex.getMessage());
            return 2;
        }
        List<AppRegistryValidator.AppRegistryViolation> violations = AppRegistryValidator.validate(reg);
        for (AppRegistryValidator.AppRegistryViolation v : violations) {
            line(out, path + ": " + v);
        }
        if (!violations.isEmpty()) {
            return 1;
        }
        int n = reg.attributes().size();
        line(out, path + ": ok (" + n + " " + (n == 1 ? "attribute" : "attributes")
                + " in namespace " + reg.namespace() + ")");
        return 0;
    }

    /** Renders a failed read the way Go prints the error from os.ReadFile. */
    private static String readError(String path, IOException ex) {
        if (ex instanceof NoSuchFileException) {
            return "open " + path + ": no such file or directory";
        }
        if (ex instanceof AccessDeniedException) {
            return "open " + path + ": permission denied";
        }
        if (Files.isDirectory(Path.of(path))) {
            return "read " + path + ": is a directory";
        }
        return "open " + path + ": " + ex.getMessage();
    }

    /** Writes one line ending in a newline, as Go does on every platform. */
    private static void line(PrintStream stream, String text) {
        stream.print(text + "\n");
    }
}
