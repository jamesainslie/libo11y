package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import ing.o11y.libo11y.TestReaders.CollectingReader;
import ing.o11y.libo11y.spec.generated.SpecTables;
import org.junit.jupiter.api.Test;

class AppRegistryNamespaceTest {
    private static final String SECRET_REG = """
            schema: libo11y.app-registry/v1
            namespace: lor
            attributes:
              lor.api.token: {type: string, sensitivity: secret, cardinality: unbounded}
            """;
    private static final String PUBLIC_REG = """
            schema: libo11y.app-registry/v1
            namespace: lor
            attributes:
              lor.api.token: {type: string, sensitivity: public, cardinality: unbounded}
            """;

    @Test
    void twoRegistriesClaimingOneNamespaceFailSetupNamingBothSources() {
        O11yOptions opts = TestReaders.baseOptions(new CollectingReader())
                .addAppRegistryYaml(SECRET_REG, "first.yaml")
                .addAppRegistryYaml(PUBLIC_REG, "second.yaml")
                .build();
        O11yException ex = assertThrows(O11yException.class, () -> O11y.init(opts));
        assertEquals(O11yException.ErrorCode.INVALID_APP_REGISTRY, ex.code());
        assertEquals(
                "o11y: invalid application registry: first.yaml and second.yaml both declare namespace \"lor\"",
                ex.getMessage());
    }

    @Test
    void oneRegistryStillClassifies() {
        Telemetry t = O11y.init(TestReaders.baseOptions(new CollectingReader())
                .addAppRegistryYaml(SECRET_REG, "first.yaml")
                .build());
        try {
            assertEquals(SpecTables.Sensitivity.SECRET, t.policy().sensitivityOf("lor.api.token"));
        } finally {
            t.shutdown();
        }
    }
}
