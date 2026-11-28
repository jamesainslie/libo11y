package ing.o11y.libo11y.cli;

import ing.o11y.libo11y.spec.AppRegistryValidator;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.file.Path;

/** CLI entry point for {@code libo11y registry check <path>...}. */
public final class Main {
    private Main() {}

    public static void main(String[] args) {
        int code = run(args, System.err);
        if (code != 0) {
            System.exit(code);
        }
    }

    public static int run(String[] args, PrintStream err) {
        if (args.length < 3 || !"registry".equals(args[0]) || !"check".equals(args[1])) {
            err.println("usage: libo11y registry check <path> [<path>...]");
            return 2;
        }
        int exitCode = 0;
        for (int i = 2; i < args.length; i++) {
            String pathStr = args[i];
            try {
                AppRegistryValidator.loadFile(Path.of(pathStr));
            } catch (AppRegistryValidator.AppRegistryValidationException ex) {
                for (AppRegistryValidator.AppRegistryViolation v : ex.violations()) {
                    err.println(pathStr + ": " + v);
                }
                exitCode = 1;
            } catch (AppRegistryValidator.AppRegistryParseException ex) {
                err.println(pathStr + ": " + ex.getMessage());
                exitCode = 1;
            } catch (IOException ex) {
                err.println(pathStr + ": " + ex.getMessage());
                exitCode = 1;
            }
        }
        return exitCode;
    }
}
