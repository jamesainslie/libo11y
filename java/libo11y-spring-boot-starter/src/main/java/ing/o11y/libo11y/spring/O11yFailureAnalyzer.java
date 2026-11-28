package ing.o11y.libo11y.spring;

import ing.o11y.libo11y.O11yException;
import org.springframework.boot.diagnostics.AbstractFailureAnalyzer;
import org.springframework.boot.diagnostics.FailureAnalysis;

/** Spring Boot startup {@code FailureAnalyzer} presenting actionable guidance for {@link O11yException}. */
public final class O11yFailureAnalyzer extends AbstractFailureAnalyzer<O11yException> {
    @Override
    protected FailureAnalysis analyze(Throwable rootFailure, O11yException cause) {
        String description = "libo11y failed to initialize (" + cause.code() + "): " + cause.getMessage();
        String action = switch (cause.code()) {
            case NO_SERVICE_NAME ->
                    "Set 'spring.application.name' or 'libo11y.service-name' (or OTEL_SERVICE_NAME).";
            case NO_ENVIRONMENT ->
                    "Set 'libo11y.environment' (e.g. production, staging, development, test) or OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=<env>.";
            case INVALID_ENVIRONMENT ->
                    "Use one of production, staging, development, test, or register custom names under 'libo11y.extra-environments'.";
            case PII_HASH_KEY ->
                    "Provide a 32+ byte key via 'libo11y.pii-hash-key' when 'libo11y.pii-mode=HASH'.";
            case INVALID_APP_REGISTRY ->
                    "Validate your application attribute registry YAML with 'libo11y registry check <path>'.";
            case CANARY_REJECTED ->
                    "Check that the configured log sink accepts startup events; see the underlying exception for details.";
            case ALREADY_SETUP ->
                    "Disable global installation via 'libo11y.install-global=false' when running multiple Spring contexts in one JVM.";
            case UNSUPPORTED_PROTOCOL ->
                    "Set OTEL_EXPORTER_OTLP_PROTOCOL and OTEL_EXPORTER_OTLP_*_PROTOCOL to a supported OTLP value (http/protobuf or grpc).";
            case EXPORTER ->
                    "Check that OTEL_*_EXPORTER names a supported exporter (otlp, console or none), that "
                            + "OTEL_EXPORTER_OTLP_ENDPOINT and OTEL_EXPORTER_OTLP_*_ENDPOINT are well-formed http or https URLs, "
                            + "and that the TLS files OTEL_EXPORTER_OTLP_CERTIFICATE, OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE "
                            + "and OTEL_EXPORTER_OTLP_CLIENT_KEY (and their per-signal forms) exist, are readable and hold valid PEM.";
            case INVALID_OPTION ->
                    "Review your 'libo11y.*' properties and OTEL_* environment variables for invalid values.";
            case INVALID_CARRIER ->
                    "Check the serialized detached carrier text: it must be a query string with a valid W3C traceparent.";
        };
        return new FailureAnalysis(description, action, cause);
    }
}
