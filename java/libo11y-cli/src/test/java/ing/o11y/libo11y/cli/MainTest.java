package ing.o11y.libo11y.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/** Expectations follow go/cmd/libo11y/main.go and its tests. */
class MainTest {
    private static final String USAGE = "usage: libo11y registry check FILE...\n";

    @TempDir
    Path tmp;

    private record Result(int code, String out, String err) {}

    private static Result run(String... args) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteArrayOutputStream err = new ByteArrayOutputStream();
        int code = Main.run(
                args,
                new PrintStream(out, true, StandardCharsets.UTF_8),
                new PrintStream(err, true, StandardCharsets.UTF_8));
        return new Result(code, out.toString(StandardCharsets.UTF_8), err.toString(StandardCharsets.UTF_8));
    }

    private String write(String name, String body) throws IOException {
        Path path = tmp.resolve(name);
        Files.writeString(path, body, StandardCharsets.UTF_8);
        return path.toString();
    }

    private String valid() throws IOException {
        return write("valid.yaml", "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n"
                + "  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n");
    }

    private String invalid() throws IOException {
        return write("invalid.yaml", "schema: libo11y.app-registry/v1\nnamespace: http\nattributes:\n"
                + "  http.thing: {type: string, sensitivity: public, cardinality: bounded}\n");
    }

    private String broken() throws IOException {
        return write("broken.yaml", "schema: [\n");
    }

    @Test
    void validFilePrintsTheOkLine() throws IOException {
        String path = valid();
        assertEquals(new Result(0, path + ": ok (1 attribute in namespace lor)\n", ""),
                run("registry", "check", path));
    }

    @Test
    void okLineCountsInThePlural() throws IOException {
        String path = write("two.yaml", "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n"
                + "  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n"
                + "  lor.user.tier: {type: string, sensitivity: public, cardinality: bounded}\n");
        assertEquals(new Result(0, path + ": ok (2 attributes in namespace lor)\n", ""),
                run("registry", "check", path));
    }

    @Test
    void violationsGoToStdoutAndExitOne() throws IOException {
        String path = invalid();
        assertEquals(new Result(1, path + ": libo11y_app_namespace_reserved: namespace \"http\" belongs to "
                + "libo11y, OpenTelemetry, or semconv\n", ""),
                run("registry", "check", path));
    }

    @Test
    void parseErrorGoesToStderrAndExitsTwo() throws IOException {
        String path = broken();
        Result r = run("registry", "check", path);
        assertEquals(2, r.code());
        assertEquals("", r.out());
        assertTrue(r.err().startsWith(path + ": parsing application registry: syntax: "), r.err());
        assertTrue(r.err().endsWith("\n") && r.err().indexOf('\n') == r.err().length() - 1, r.err());
    }

    @Test
    void emptyFileReadsLikeGo() throws IOException {
        String path = write("empty.yaml", "# nothing here\n");
        assertEquals(new Result(2, "", path + ": application registry is empty\n"),
                run("registry", "check", path));
    }

    @Test
    void secondDocumentReadsLikeGo() throws IOException {
        String path = write("two-docs.yaml", "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n"
                + "  lor.user.id: {type: string, sensitivity: internal, cardinality: unbounded}\n---\nx: 1\n");
        assertEquals(new Result(2, "", path + ": parsing application registry: an application registry "
                + "holds one YAML document, found a second\n"),
                run("registry", "check", path));
    }

    @Test
    void missingFileReadsLikeGo() {
        String path = tmp.resolve("nope.yaml").toString();
        assertEquals(new Result(2, "", "open " + path + ": no such file or directory\n"),
                run("registry", "check", path));
    }

    @Test
    void directoryReadsLikeGo() {
        String path = tmp.toString();
        assertEquals(new Result(2, "", "read " + path + ": is a directory\n"),
                run("registry", "check", path));
    }

    @Test
    void worstStatusWinsInEitherOrder() throws IOException {
        String bad = invalid();
        String broken = broken();
        Result first = run("registry", "check", broken, bad);
        assertEquals(2, first.code());
        assertTrue(first.out().contains("libo11y_app_namespace_reserved"), first.out());
        assertTrue(first.err().contains("parsing"), first.err());

        Result last = run("registry", "check", bad, broken);
        assertEquals(2, last.code());

        Result mixed = run("registry", "check", bad, valid());
        assertEquals(1, mixed.code());
        assertTrue(mixed.out().endsWith(": ok (1 attribute in namespace lor)\n"), mixed.out());
    }

    @Test
    void usageErrorsGoToStderr() {
        assertEquals(new Result(2, "", USAGE), run("registry", "check"));
        assertEquals(new Result(2, "", USAGE), run("lint"));
        assertEquals(new Result(2, "", USAGE), run());
        assertEquals(new Result(2, "", USAGE), run("-h", "extra"));
    }

    @Test
    void helpGoesToStdout() {
        for (String flag : List.of("-h", "--help", "help")) {
            assertEquals(new Result(0, USAGE, ""), run(flag), flag);
        }
    }

    private static Path conformanceDir() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            if (Files.isDirectory(dir.resolve("conformance").resolve("appregistry"))) {
                return dir.resolve("conformance").resolve("appregistry");
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("could not locate repository root");
    }

    static Stream<String> conformanceCases() {
        try (Stream<Path> files = Files.list(conformanceDir())) {
            return files.map(p -> p.getFileName().toString())
                    .filter(n -> n.endsWith(".yaml"))
                    .map(n -> n.substring(0, n.length() - ".yaml".length()))
                    .sorted()
                    .toList()
                    .stream();
        } catch (IOException ex) {
            throw new UncheckedIOException(ex);
        }
    }

    /**
     * Each shared case's .want line maps to the Go binary's output: {@code ok N NS} is the ok line and exit
     * 0, a violation list is one stdout line per violation and exit 1, and {@code parse: KIND} is one
     * stderr line and exit 2.
     */
    @ParameterizedTest(name = "{0}")
    @MethodSource("conformanceCases")
    void conformanceCaseMatchesGoOutput(String name) throws IOException {
        Path dir = conformanceDir();
        String path = dir.resolve(name + ".yaml").toString();
        String want = Files.readString(dir.resolve(name + ".want"), StandardCharsets.UTF_8)
                .trim()
                .replace("\r\n", "\n");
        Result r = run("registry", "check", path);
        if (want.startsWith("ok ")) {
            String[] parts = want.split(" ");
            String noun = "1".equals(parts[1]) ? "attribute" : "attributes";
            assertEquals(new Result(0, path + ": ok (" + parts[1] + " " + noun + " in namespace " + parts[2] + ")\n", ""), r);
        } else if (want.startsWith("parse: ")) {
            assertEquals(2, r.code());
            assertEquals("", r.out());
            String prefix = "parse: empty".equals(want)
                    ? path + ": application registry is empty"
                    : path + ": parsing application registry: ";
            assertTrue(r.err().startsWith(prefix), r.err());
        } else {
            String lines = Arrays.stream(want.split("\n"))
                    .map(line -> path + ": " + line + "\n")
                    .collect(Collectors.joining());
            assertEquals(new Result(1, lines, ""), r);
        }
    }
}
