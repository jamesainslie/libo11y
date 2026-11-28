package ing.o11y.libo11y.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class MainTest {
    private static Path repoRoot() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            if (Files.isDirectory(dir.resolve("conformance"))) {
                return dir;
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("could not locate repository root");
    }

    @Test
    void registryCheckValidAndInvalid() {
        Path appReg = repoRoot().resolve("conformance").resolve("appregistry");
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        PrintStream err = new PrintStream(buf, true, StandardCharsets.UTF_8);

        int ok = Main.run(new String[] {"registry", "check", appReg.resolve("valid.yaml").toString()}, err);
        assertEquals(0, ok);
        assertEquals("", buf.toString(StandardCharsets.UTF_8));

        int bad = Main.run(new String[] {"registry", "check", appReg.resolve("schema-unknown.yaml").toString()}, err);
        assertEquals(1, bad);
        assertTrue(buf.toString(StandardCharsets.UTF_8).contains("libo11y_app_schema_unknown"));

        int usage = Main.run(new String[] {"nope"}, err);
        assertEquals(2, usage);
    }
}
