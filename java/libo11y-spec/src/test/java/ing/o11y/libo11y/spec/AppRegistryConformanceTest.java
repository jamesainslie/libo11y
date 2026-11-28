package ing.o11y.libo11y.spec;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

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

    @Test
    void generatedSpecConstantsPresent() {
        assertTrue(Spec.SCHEMA_URL.startsWith("https://schemas.o11y.ing/libo11y/"));
        assertEquals("event.name", Spec.EVENT_NAME_KEY);
        assertTrue(Spec.DeploymentEnvironment.isValid(Spec.DeploymentEnvironment.PRODUCTION));
        assertEquals(SpecTables.Sensitivity.SECRET, SpecTables.SENSITIVITY_OF.get("http.request.header.authorization"));
    }

    @Test
    void allConformanceAppRegistryCasesMatch() throws IOException {
        Path dir = repoRoot().resolve("conformance").resolve("appregistry");
        List<Path> yamlFiles;
        try (var stream = Files.list(dir)) {
            yamlFiles = stream.filter(p -> p.toString().endsWith(".yaml")).sorted().toList();
        }
        assertTrue(yamlFiles.size() >= 46, "expected at least 46 app registry cases, got " + yamlFiles.size());

        List<String> failures = new ArrayList<>();
        for (Path yamlPath : yamlFiles) {
            String baseName = yamlPath.getFileName().toString().replace(".yaml", "");
            Path wantPath = dir.resolve(baseName + ".want");
            String want = Files.readString(wantPath, StandardCharsets.UTF_8).trim().replace("\r\n", "\n");

            String got;
            try {
                AppRegistryValidator.AppRegistry reg = AppRegistryValidator.parseBytes(Files.readAllBytes(yamlPath));
                List<AppRegistryValidator.AppRegistryViolation> violations = AppRegistryValidator.validate(reg);
                if (violations.isEmpty()) {
                    got = "ok " + reg.attributes().size() + " " + reg.namespace();
                } else {
                    got = String.join("\n", violations.stream().map(AppRegistryValidator.AppRegistryViolation::toString).toList());
                }
            } catch (AppRegistryValidator.AppRegistryParseException ex) {
                got = "parse: " + ex.kind();
            }

            if (!got.equals(want)) {
                failures.add(yamlPath.getFileName() + ":\n  got:  " + got + "\n  want: " + want);
            }
        }
        assertTrue(failures.isEmpty(), String.join("\n", failures));
    }
}
