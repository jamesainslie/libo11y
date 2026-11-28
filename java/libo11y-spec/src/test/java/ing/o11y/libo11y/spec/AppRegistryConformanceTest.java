package ing.o11y.libo11y.spec;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

class AppRegistryConformanceTest {
    private static Path repoRoot() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            if (Files.isDirectory(dir.resolve("conformance")) && Files.isDirectory(dir.resolve("spec"))) {
                return dir;
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("could not locate repository root");
    }

    private static Path casesDir() {
        return repoRoot().resolve("conformance").resolve("appregistry");
    }

    static Stream<String> caseNames() {
        try (Stream<Path> stream = Files.list(casesDir())) {
            List<String> names = stream
                    .map(p -> p.getFileName().toString())
                    .filter(n -> n.endsWith(".yaml"))
                    .map(n -> n.substring(0, n.length() - ".yaml".length()))
                    .sorted()
                    .toList();
            return names.stream();
        } catch (IOException ex) {
            throw new UncheckedIOException(ex);
        }
    }

    @Test
    void generatedSpecConstantsPresent() {
        assertTrue(Spec.SCHEMA_URL.startsWith("https://schemas.o11y.ing/libo11y/"));
        assertEquals("event.name", Spec.EVENT_NAME_KEY);
        assertTrue(Spec.DeploymentEnvironment.isRegistered(Spec.DeploymentEnvironment.PRODUCTION));
        assertEquals(SpecTables.Sensitivity.SECRET, SpecTables.SENSITIVITY_OF.get("http.request.header.authorization"));
    }

    @Test
    void sharedSuiteHoldsEveryCase() {
        long count = caseNames().count();
        assertTrue(count >= 46, "expected at least 46 app registry cases, got " + count);
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("caseNames")
    void conformanceCase(String name) throws IOException {
        Path dir = casesDir();
        String want = Files.readString(dir.resolve(name + ".want"), StandardCharsets.UTF_8)
                .trim()
                .replace("\r\n", "\n");

        String got;
        try {
            AppRegistryValidator.AppRegistry reg =
                    AppRegistryValidator.parseBytes(Files.readAllBytes(dir.resolve(name + ".yaml")));
            List<AppRegistryValidator.AppRegistryViolation> violations = AppRegistryValidator.validate(reg);
            if (violations.isEmpty()) {
                got = "ok " + reg.attributes().size() + " " + reg.namespace();
            } else {
                got = String.join(
                        "\n",
                        violations.stream().map(AppRegistryValidator.AppRegistryViolation::toString).toList());
            }
        } catch (AppRegistryValidator.AppRegistryParseException ex) {
            got = "parse: " + ex.kind();
        }
        assertEquals(want, got);
    }
}
