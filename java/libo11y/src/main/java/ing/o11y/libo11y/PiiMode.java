package ing.o11y.libo11y;

/** How attributes classified as PII are handled across signals (metrics always drop PII). */
public enum PiiMode {
    DROP,
    HASH,
    KEEP
}
