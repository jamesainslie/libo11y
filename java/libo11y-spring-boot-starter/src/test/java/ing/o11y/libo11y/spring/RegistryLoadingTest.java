package ing.o11y.libo11y.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.O11y;
import ing.o11y.libo11y.O11yEnv;
import ing.o11y.libo11y.O11yException;
import ing.o11y.libo11y.O11yOptions;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.diagnostics.FailureAnalysis;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.support.GenericApplicationContext;
import org.springframework.core.io.ByteArrayResource;

/** The starter reads application registries as strictly as the CLI and closes what it opens. */
class RegistryLoadingTest {
    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(O11yAutoConfiguration.class))
            .withPropertyValues(
                    "spring.application.name=registry-api",
                    "libo11y.environment=test",
                    "libo11y.hermetic=true",
                    "libo11y.runtime-metrics=false");

    @TempDir
    Path tmp;

    @AfterEach
    void resetGlobals() {
        O11y.resetForTesting();
    }

    private static Path conformance(String name) {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("conformance").resolve("appregistry").resolve(name);
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("conformance/appregistry/" + name + " not found");
    }

    /** The error the core gives for the registry file, the path the CLI's parser takes. */
    private static O11yException coreError(Path registry) {
        return assertThrows(O11yException.class, () -> O11y.init(O11yOptions.builder()
                .serviceName("registry-api")
                .environment("test")
                .env(O11yEnv.HERMETIC)
                .runtimeMetrics(false)
                .addAppRegistryFile(registry)
                .build()));
    }

    @Test
    void anInvalidUtf8RegistryFailsStartupWithTheCoresTypedError() {
        Path registry = conformance("invalid-utf8.yaml");
        O11yException want = coreError(registry);
        runner.withPropertyValues("libo11y.app-registries=" + registry.toUri()).run(context -> {
            Throwable failure = context.getStartupFailure();
            assertNotNull(failure, "a registry the CLI rejects must fail startup");
            Throwable cause = failure;
            while (cause != null && !(cause instanceof O11yException)) {
                cause = cause.getCause();
            }
            O11yException got = assertInstanceOf(O11yException.class, cause, String.valueOf(failure));
            assertEquals(O11yException.ErrorCode.INVALID_APP_REGISTRY, got.code());
            assertEquals(want.getMessage(), got.getMessage());
        });
    }

    @Test
    void aUtf16RegistryWithAByteOrderMarkLoadsAsTheCliLoadsIt() throws IOException {
        String yaml = Files.readString(conformance("valid.yaml"), StandardCharsets.UTF_8);
        ByteBuffer utf16 = StandardCharsets.UTF_16LE.encode(yaml);
        byte[] raw = new byte[utf16.remaining() + 2];
        raw[0] = (byte) 0xFF;
        raw[1] = (byte) 0xFE;
        utf16.get(raw, 2, raw.length - 2);
        Path registry = tmp.resolve("utf16.yaml");
        Files.write(registry, raw);

        runner.withPropertyValues("libo11y.app-registries=" + registry.toUri())
                .run(context -> assertNull(context.getStartupFailure()));
    }

    @Test
    void theRegistryStreamIsClosed() throws IOException {
        byte[] yaml = Files.readAllBytes(conformance("valid.yaml"));
        AtomicInteger opened = new AtomicInteger();
        AtomicInteger closed = new AtomicInteger();
        ByteArrayResource tracked = new ByteArrayResource(yaml, "tracked registry") {
            @Override
            public InputStream getInputStream() {
                opened.incrementAndGet();
                return new ByteArrayInputStream(yaml) {
                    @Override
                    public void close() throws IOException {
                        closed.incrementAndGet();
                        super.close();
                    }
                };
            }
        };
        runner.withInitializer(ctx -> ((GenericApplicationContext) ctx).addProtocolResolver(
                        (location, loader) -> location.startsWith("tracked:") ? tracked : null))
                .withPropertyValues("libo11y.app-registries=tracked:registry.yaml")
                .run(context -> {
                    assertNull(context.getStartupFailure());
                    assertTrue(opened.get() > 0);
                    assertEquals(opened.get(), closed.get(), "every registry stream the starter opens is closed");
                });
    }

    @Test
    void exporterAdviceCoversEndpointsAndTlsFiles() {
        FailureAnalysis analysis = new O11yFailureAnalyzer().analyze(new O11yException(
                O11yException.ErrorCode.EXPORTER, "invalid OTEL_EXPORTER_OTLP_ENDPOINT"));
        String action = analysis.getAction();
        assertTrue(action.contains("OTEL_EXPORTER_OTLP_ENDPOINT"), action);
        assertTrue(action.contains("TLS"), action);
        assertTrue(action.contains("OTEL_EXPORTER_OTLP_CERTIFICATE"), action);
    }
}
