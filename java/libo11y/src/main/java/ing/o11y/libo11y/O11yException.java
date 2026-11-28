package ing.o11y.libo11y;

/** Typed error raised by libo11y initialization and runtime contract checks. */
public final class O11yException extends RuntimeException {
    /** What went wrong, for callers that branch on the failure. */
    public enum ErrorCode {
        /**
         * {@link O11y#setup} was called while a libo11y global is active, or while
         * {@code GlobalOpenTelemetry} already holds an instance libo11y did not install (for
         * example from the OpenTelemetry Java agent, or from a {@code GlobalOpenTelemetry.get()}
         * call made before setup).
         */
        ALREADY_SETUP,
        /** No {@code service.name} resolved from the options or the environment. */
        NO_SERVICE_NAME,
        /** No {@code deployment.environment.name} resolved. */
        NO_ENVIRONMENT,
        /** The deployment environment is not in the allowed set. */
        INVALID_ENVIRONMENT,
        /** PII hashing was requested without a key of at least 32 bytes. */
        PII_HASH_KEY,
        /** An application attribute registry failed to load or validate. */
        INVALID_APP_REGISTRY,
        /** A log sink rejected the startup canary, so {@link O11y#setup} installed nothing. */
        CANARY_REJECTED,
        /** An OTLP protocol other than {@code grpc} or {@code http/protobuf} was configured. */
        UNSUPPORTED_PROTOCOL,
        /**
         * An exporter could not be built: an unsupported {@code OTEL_*_EXPORTER} value, an
         * invalid endpoint, an unreadable or invalid TLS file, or a failed shutdown.
         */
        EXPORTER,
        /** A code option or an {@code OTEL_*} variable has an invalid value. */
        INVALID_OPTION,
        /**
         * Serialized {@link Detached.Carrier} text cannot be restored: too long, not a query
         * string, or without a valid W3C traceparent.
         */
        INVALID_CARRIER
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
