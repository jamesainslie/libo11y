package ing.o11y.libo11y;

/** Typed error raised by libo11y initialization and runtime contract checks. */
public final class O11yException extends RuntimeException {
    public enum ErrorCode {
        ALREADY_SETUP,
        NO_SERVICE_NAME,
        NO_ENVIRONMENT,
        INVALID_ENVIRONMENT,
        PII_HASH_KEY,
        INVALID_APP_REGISTRY,
        CANARY_REJECTED,
        UNSUPPORTED_PROTOCOL,
        EXPORTER,
        INVALID_OPTION
    }

    private final ErrorCode code;

    public O11yException(ErrorCode code, String message) {
        super(message);
        this.code = code;
    }

    public O11yException(ErrorCode code, String message, Throwable cause) {
        super(message, cause);
        this.code = code;
    }

    public ErrorCode code() {
        return code;
    }
}
