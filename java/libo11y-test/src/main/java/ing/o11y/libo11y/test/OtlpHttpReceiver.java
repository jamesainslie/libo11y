package ing.o11y.libo11y.test;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.zip.GZIPInputStream;

/**
 * Lightweight in-process OTLP/HTTP receiver on loopback for wire-level export verification.
 * Accepts {@code /v1/traces}, {@code /v1/metrics}, and {@code /v1/logs}, transparently gunzipping payloads.
 */
public final class OtlpHttpReceiver implements AutoCloseable {
    public record CapturedRequest(
            String path,
            String contentType,
            Map<String, List<String>> headers,
            byte[] body) {}

    private final HttpServer server;
    private final List<CapturedRequest> requests = new CopyOnWriteArrayList<>();

    private OtlpHttpReceiver(HttpServer server) {
        this.server = server;
    }

    public static OtlpHttpReceiver start() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        OtlpHttpReceiver receiver = new OtlpHttpReceiver(server);
        server.createContext("/", receiver::handle);
        server.start();
        return receiver;
    }

    public String endpoint() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public List<CapturedRequest> requests() {
        return List.copyOf(requests);
    }

    public List<CapturedRequest> requestsForPath(String path) {
        return requests.stream().filter(r -> path.equals(r.path())).toList();
    }

    private void handle(HttpExchange exchange) throws IOException {
        byte[] raw = exchange.getRequestBody().readAllBytes();
        String encoding = exchange.getRequestHeaders().getFirst("Content-Encoding");
        byte[] body = "gzip".equalsIgnoreCase(encoding) ? gunzip(raw) : raw;
        Map<String, List<String>> headers = new LinkedHashMap<>();
        exchange.getRequestHeaders().forEach((k, v) -> headers.put(k, List.copyOf(v)));
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        requests.add(new CapturedRequest(exchange.getRequestURI().getPath(), contentType, headers, body));

        byte[] resp = new byte[0];
        exchange.getResponseHeaders().add("Content-Type", "application/x-protobuf");
        exchange.sendResponseHeaders(200, resp.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(resp);
        }
    }

    private static byte[] gunzip(byte[] compressed) throws IOException {
        try (GZIPInputStream gis = new GZIPInputStream(new ByteArrayInputStream(compressed))) {
            return gis.readAllBytes();
        }
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
