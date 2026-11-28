package ing.o11y.libo11y.internal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;

/** Deterministic UUIDv5 service.instance.id derivation matching conformance/vectors/instance-id.json. */
public final class InstanceId {
    private static final byte[] NAMESPACE_BYTES =
            HexFormat.of().parseHex("4d63009a8d0f11eeaad74c796ed8e320");

    private InstanceId() {}

    public static String uuidV5(String name) {
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            sha1.update(NAMESPACE_BYTES);
            sha1.update(name.getBytes(StandardCharsets.UTF_8));
            byte[] hash = sha1.digest();
            byte[] bytes = new byte[16];
            System.arraycopy(hash, 0, bytes, 0, 16);
            bytes[6] = (byte) ((bytes[6] & 0x0F) | 0x50);
            bytes[8] = (byte) ((bytes[8] & 0x3F) | 0x80);
            String hex = HexFormat.of().formatHex(bytes);
            return hex.substring(0, 8)
                    + "-" + hex.substring(8, 12)
                    + "-" + hex.substring(12, 16)
                    + "-" + hex.substring(16, 20)
                    + "-" + hex.substring(20, 32);
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-1 unavailable", ex);
        }
    }

    public static String derive(String podUid, String podName, String k8sNamespace) {
        if (podUid != null && !podUid.isEmpty()) {
            return uuidV5(podUid);
        }
        if (podName != null && !podName.isEmpty()) {
            String ns = k8sNamespace == null ? "" : k8sNamespace;
            return uuidV5(ns + "/" + podName);
        }
        return null;
    }

    public static String random() {
        return UUID.randomUUID().toString();
    }
}
