package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsParameters;
import com.sun.net.httpserver.HttpsServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.TrustManagerFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The OTLP exporters honour OTEL_EXPORTER_OTLP_CERTIFICATE, OTEL_EXPORTER_OTLP_CLIENT_KEY and
 * OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE and their per-signal forms (G4 a), against a local HTTPS
 * server that only accepts a client presenting the generated client certificate.
 */
class OtlpTlsTest {
    private static final char[] PASS = "changeit".toCharArray();

    @TempDir
    Path dir;

    private HttpsServer server;
    private final List<String> paths = new CopyOnWriteArrayList<>();

    private void keytool(String... args) throws IOException, InterruptedException {
        List<String> cmd = new java.util.ArrayList<>();
        cmd.add(Path.of(System.getProperty("java.home"), "bin", "keytool").toString());
        cmd.addAll(List.of(args));
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        byte[] out = p.getInputStream().readAllBytes();
        assertTrue(p.waitFor(60, TimeUnit.SECONDS), "keytool timed out");
        assertEquals(0, p.exitValue(), new String(out, StandardCharsets.UTF_8));
    }

    /** Generates a self-signed key pair in {@code name}.p12 and writes its certificate to {@code name}.pem. */
    private Path keyPair(String name) throws IOException, InterruptedException {
        Path store = dir.resolve(name + ".p12");
        keytool("-genkeypair", "-alias", name, "-keyalg", "EC", "-groupname", "secp256r1",
                "-dname", "CN=" + name, "-ext", "SAN=ip:127.0.0.1,dns:localhost", "-validity", "2",
                "-storetype", "PKCS12", "-keystore", store.toString(),
                "-storepass", new String(PASS), "-keypass", new String(PASS));
        keytool("-exportcert", "-rfc", "-alias", name, "-keystore", store.toString(),
                "-storepass", new String(PASS), "-file", dir.resolve(name + ".pem").toString());
        return store;
    }

    private static KeyStore load(Path store) throws IOException, GeneralSecurityException {
        KeyStore ks = KeyStore.getInstance("PKCS12");
        try (InputStream in = Files.newInputStream(store)) {
            ks.load(in, PASS);
        }
        return ks;
    }

    /** Writes the client's private key as an unencrypted PKCS#8 PEM file. */
    private Path writeKeyPem(Path store, String alias) throws IOException, GeneralSecurityException {
        PrivateKey key = (PrivateKey) load(store).getKey(alias, PASS);
        String pem = "-----BEGIN PRIVATE KEY-----\n"
                + Base64.getMimeEncoder(64, "\n".getBytes(StandardCharsets.US_ASCII)).encodeToString(key.getEncoded())
                + "\n-----END PRIVATE KEY-----\n";
        Path out = dir.resolve(alias + ".key");
        Files.writeString(out, pem, StandardCharsets.US_ASCII);
        return out;
    }

    @BeforeEach
    void startServer() throws Exception {
        Path serverStore = keyPair("server");
        Path clientStore = keyPair("client");
        writeKeyPem(clientStore, "client");

        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(load(serverStore), PASS);
        KeyStore trusted = KeyStore.getInstance("PKCS12");
        trusted.load(null, null);
        Certificate clientCert = load(clientStore).getCertificate("client");
        trusted.setCertificateEntry("client", clientCert);
        TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        tmf.init(trusted);
        SSLContext ssl = SSLContext.getInstance("TLS");
        ssl.init(kmf.getKeyManagers(), tmf.getTrustManagers(), null);

        server = HttpsServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.setHttpsConfigurator(new HttpsConfigurator(ssl) {
            @Override
            public void configure(HttpsParameters params) {
                SSLParameters p = ssl.getDefaultSSLParameters();
                p.setNeedClientAuth(true);
                params.setSSLParameters(p);
            }
        });
        server.createContext("/", exchange -> {
            paths.add(exchange.getRequestURI().getPath());
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private String url(String path) {
        return "https://127.0.0.1:" + server.getAddress().getPort() + path;
    }

    private static O11yOptions.Builder envOptions(Map<String, String> env) {
        return O11yOptions.builder()
                .env(env)
                .serviceName("tls-test")
                .environment("test")
                .serviceVersion("1.0.0")
                .consoleOutput(new ByteArrayOutputStream())
                .runtimeMetrics(false);
    }

    @Test
    void perSignalVariablesConfigureMutualTlsForTraces() {
        Telemetry t = O11y.init(envOptions(Map.of(
                        "OTEL_TRACES_EXPORTER", "otlp",
                        "OTEL_METRICS_EXPORTER", "none",
                        "OTEL_LOGS_EXPORTER", "none",
                        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", url("/v1/traces"),
                        "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE", dir.resolve("server.pem").toString(),
                        "OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY", dir.resolve("client.key").toString(),
                        "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE", dir.resolve("client.pem").toString()))
                .build());
        t.tracer("tls").spanBuilder("secure").startSpan().end();
        ShutdownReport report = t.shutdown(Duration.ofSeconds(10));
        assertTrue(report.isOk(), "" + report);
        assertEquals(List.of("/v1/traces"), paths);
    }

    @Test
    void generalVariablesConfigureMutualTlsForLogs() {
        Telemetry t = O11y.init(envOptions(Map.of(
                        "OTEL_TRACES_EXPORTER", "none",
                        "OTEL_METRICS_EXPORTER", "none",
                        "OTEL_LOGS_EXPORTER", "otlp",
                        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", url("/v1/logs"),
                        "OTEL_EXPORTER_OTLP_CERTIFICATE", dir.resolve("server.pem").toString(),
                        "OTEL_EXPORTER_OTLP_CLIENT_KEY", dir.resolve("client.key").toString(),
                        "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", dir.resolve("client.pem").toString()))
                .build());
        t.logger().info("secure record");
        ShutdownReport report = t.shutdown(Duration.ofSeconds(10));
        assertTrue(report.isOk(), "" + report);
        assertEquals(List.of("/v1/logs"), paths);
    }
}
