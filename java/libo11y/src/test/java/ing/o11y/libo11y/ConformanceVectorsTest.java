package ing.o11y.libo11y;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.internal.EndpointSanitizer;
import ing.o11y.libo11y.internal.InstanceId;
import ing.o11y.libo11y.internal.PiiTokenizer;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

class ConformanceVectorsTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static Path conformanceDir() {
        Path dir = Path.of("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("conformance");
            if (Files.isDirectory(candidate)) {
                return candidate;
            }
            dir = dir.getParent();
        }
        throw new IllegalStateException("conformance/ directory not found");
    }

    @Test
    void instanceIdMatchesAllSharedVectors() throws IOException {
        JsonNode root = MAPPER.readTree(Files.readString(
                conformanceDir().resolve("vectors").resolve("instance-id.json"),
                StandardCharsets.UTF_8));
        assertTrue(root.isArray() && root.size() > 0);
        for (JsonNode v : root) {
            String podUid = v.get("k8s_pod_uid").asString("");
            String podName = v.get("k8s_pod_name").asString("");
            String ns = v.get("k8s_namespace_name").asString("");
            String want = v.get("want").isNull() ? null : v.get("want").asString();
            assertEquals(want, InstanceId.derive(podUid, podName, ns));
        }
    }

    @Test
    void endpointSanitizeMatchesAllSharedVectors() throws IOException {
        JsonNode root = MAPPER.readTree(Files.readString(
                conformanceDir().resolve("vectors").resolve("endpoint-sanitize.json"),
                StandardCharsets.UTF_8));
        assertTrue(root.isArray() && root.size() > 0);
        for (JsonNode v : root) {
            String input = v.get("in").asString();
            String want = v.get("want").asString();
            assertEquals(want, EndpointSanitizer.sanitize(input), "input: " + input);
        }
    }

    private static Object decodeJsonValue(JsonNode el, String kind) {
        if ("bytes".equals(kind)) {
            return Base64.getDecoder().decode(el.asString(""));
        }
        return convertNode(el);
    }

    private static Object convertNode(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (node.isBoolean()) {
            return node.asBoolean();
        }
        if (node.isString()) {
            return node.asString();
        }
        if (node.isIntegralNumber()) {
            return node.asLong();
        }
        if (node.isFloatingPointNumber()) {
            return node.asDouble();
        }
        if (node.isArray()) {
            List<Object> list = new ArrayList<>(node.size());
            for (JsonNode child : node) {
                list.add(convertNode(child));
            }
            return list;
        }
        if (node.isObject()) {
            Map<String, Object> map = new LinkedHashMap<>();
            for (Map.Entry<String, JsonNode> entry : node.properties()) {
                map.put(entry.getKey(), convertNode(entry.getValue()));
            }
            return map;
        }
        return node.asString();
    }

    @Test
    void piiHashMatchesAllSharedVectors() throws IOException {
        JsonNode root = MAPPER.readTree(Files.readString(
                conformanceDir().resolve("vectors").resolve("pii-hash.json"),
                StandardCharsets.UTF_8));
        byte[] key = HexFormat.of().parseHex(root.get("key_hex").asString());
        JsonNode cases = root.get("cases");
        assertTrue(cases.size() >= 31);
        for (JsonNode c : cases) {
            String name = c.get("name").asString();
            String kind = c.get("kind").asString();
            Object val = decodeJsonValue(c.get("value"), kind);
            String wantCanonical = c.get("canonical").asString();
            String wantToken = c.get("token").asString();

            assertEquals(wantCanonical, PiiTokenizer.canonicalValue(val), "canonical mismatch on " + name);
            assertEquals(wantToken, PiiTokenizer.token(key, val), "token mismatch on " + name);
        }
    }
}
