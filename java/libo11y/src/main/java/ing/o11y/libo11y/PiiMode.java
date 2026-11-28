package ing.o11y.libo11y;

/**
 * How attributes classified as PII are handled across signals: {@code DROP} removes them, {@code HASH}
 * replaces them with a keyed HMAC-SHA256 token (and removes them from metrics, where a token per value
 * would multiply series cardinality), and {@code KEEP} emits them in the clear on every signal,
 * metrics included.
 */
public enum PiiMode {
    DROP,
    HASH,
    KEEP
}
