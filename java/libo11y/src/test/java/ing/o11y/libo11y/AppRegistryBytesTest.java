package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import ing.o11y.libo11y.TestReaders.CollectingReader;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

/** A registry given as bytes is decoded as strictly as a registry file. */
class AppRegistryBytesTest {
    private static final String REG = """
            schema: libo11y.app-registry/v1
            namespace: lor
            attributes:
              lor.api.token: {type: string, sensitivity: secret, cardinality: unbounded}
            """;

    @Test
    void invalidUtf8FailsSetupWithTheRegistryError() {
        byte[] raw = REG.getBytes(StandardCharsets.UTF_8);
        byte[] invalid = new byte[raw.length + 1];
        System.arraycopy(raw, 0, invalid, 0, raw.length);
        invalid[raw.length] = (byte) 0xC3; // a two-byte sequence cut short
        O11yOptions opts = TestReaders.baseOptions(new CollectingReader())
                .addAppRegistryBytes(invalid, "bad.yaml")
                .build();
        O11yException ex = assertThrows(O11yException.class, () -> O11y.init(opts));
        assertEquals(O11yException.ErrorCode.INVALID_APP_REGISTRY, ex.code());
    }

    @Test
    void validBytesLoadAndTheSourceIsCopied() {
        byte[] raw = REG.getBytes(StandardCharsets.UTF_8);
        O11yOptions.AppRegistryBytes source = new O11yOptions.AppRegistryBytes(raw, "reg.yaml");
        raw[0] = 'X';
        byte[] read = source.yaml();
        read[1] = 'Y';
        assertArrayEquals(REG.getBytes(StandardCharsets.UTF_8), source.yaml());

        Telemetry t = O11y.init(TestReaders.baseOptions(new CollectingReader())
                .addAppRegistryBytes(REG.getBytes(StandardCharsets.UTF_8), "reg.yaml")
                .build());
        t.shutdown();
    }
}
