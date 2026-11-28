package ing.o11y.libo11y.internal;

import ing.o11y.libo11y.ExemplarFilterMode;
import ing.o11y.libo11y.O11yEnv;
import ing.o11y.libo11y.O11yException;
import io.opentelemetry.sdk.trace.samplers.Sampler;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/** Parses standard OTEL_* environment variables without introducing proprietary env knobs. */
public final class O11yEnvParser {
    public record SignalConfig(
            String exporter,
            String protocol,
            String endpoint,
            Map<String, String> headers,
            Duration timeout,
            String compression) {}

    public record ParsedEnv(
            boolean hermetic,
            boolean sdkDisabled,
            String serviceName,
            Map<String, String> resourceAttributes,
            SignalConfig traces,
            SignalConfig metrics,
            SignalConfig logs,
            Sampler sampler,
            String samplerName,
            ExemplarFilterMode exemplarFilter,
            Duration metricExportInterval) {}

    private static final String DEFAULT_PROTOCOL = "http/protobuf";
    private static final String DEFAULT_HTTP_ENDPOINT = "http://localhost:4318";
    private static final String DEFAULT_GRPC_ENDPOINT = "http://localhost:4317";
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration DEFAULT_METRIC_INTERVAL = Duration.ofSeconds(60);

    private O11yEnvParser() {}

    public static ParsedEnv parse(Map<String, String> envInput) {
        if (O11yEnv.isHermetic(envInput)) {
            SignalConfig none = new SignalConfig("none", DEFAULT_PROTOCOL, "", Map.of(), DEFAULT_TIMEOUT, "");
            return new ParsedEnv(
                    true,
                    false,
                    "",
                    Map.of(),
                    none,
                    none,
                    none,
                    Sampler.parentBased(Sampler.alwaysOn()),
                    "parentbased_always_on",
                    ExemplarFilterMode.TRACE_BASED,
                    DEFAULT_METRIC_INTERVAL);
        }

        Map<String, String> env = envInput != null ? envInput : System.getenv();
        boolean disabled = "true".equalsIgnoreCase(get(env, "OTEL_SDK_DISABLED").trim());
        String serviceName = get(env, "OTEL_SERVICE_NAME").trim();
        Map<String, String> resAttrs = parseKeyValuePairs(get(env, "OTEL_RESOURCE_ATTRIBUTES"));

        SignalConfig traces = parseSignal(env, "TRACES", "v1/traces", disabled);
        SignalConfig metrics = parseSignal(env, "METRICS", "v1/metrics", disabled);
        SignalConfig logs = parseSignal(env, "LOGS", "v1/logs", disabled);

        String samplerRaw = get(env, "OTEL_TRACES_SAMPLER").trim().toLowerCase(Locale.ROOT);
        String samplerArg = get(env, "OTEL_TRACES_SAMPLER_ARG").trim();
        Sampler sampler = parseSampler(samplerRaw, samplerArg);
        String samplerName = samplerRaw.isEmpty() ? "parentbased_always_on" : samplerRaw;

        ExemplarFilterMode exemplarFilter = parseExemplarFilter(get(env, "OTEL_METRICS_EXEMPLAR_FILTER").trim());
        Duration metricInterval = parseDurationMs(get(env, "OTEL_METRIC_EXPORT_INTERVAL"), DEFAULT_METRIC_INTERVAL);

        return new ParsedEnv(
                false,
                disabled,
                serviceName,
                resAttrs,
                traces,
                metrics,
                logs,
                sampler,
                samplerName,
                exemplarFilter,
                metricInterval);
    }

    private static String get(Map<String, String> env, String key) {
        String v = env.get(key);
        return v == null ? "" : v;
    }

    private static SignalConfig parseSignal(Map<String, String> env, String upper, String defaultPath, boolean disabled) {
        if (disabled) {
            return new SignalConfig("none", DEFAULT_PROTOCOL, "", Map.of(), DEFAULT_TIMEOUT, "");
        }
        String rawExp = firstValue(get(env, "OTEL_" + upper + "_EXPORTER"));
        String exporter = rawExp.isEmpty() ? "otlp" : rawExp.toLowerCase(Locale.ROOT);
        if (!"otlp".equals(exporter) && !"none".equals(exporter) && !"console".equals(exporter)) {
            throw new O11yException(
                    O11yException.ErrorCode.EXPORTER,
                    "unsupported OTEL_" + upper + "_EXPORTER value: " + exporter);
        }

        String rawProto = get(env, "OTEL_EXPORTER_OTLP_" + upper + "_PROTOCOL").trim();
        if (rawProto.isEmpty()) {
            rawProto = get(env, "OTEL_EXPORTER_OTLP_PROTOCOL").trim();
        }
        String protocol = rawProto.isEmpty() ? DEFAULT_PROTOCOL : rawProto.toLowerCase(Locale.ROOT);
        if ("otlp".equals(exporter)
                && !"http/protobuf".equals(protocol)
                && !"grpc".equals(protocol)) {
            throw new O11yException(
                    O11yException.ErrorCode.UNSUPPORTED_PROTOCOL,
                    "unsupported OTLP protocol for " + upper.toLowerCase(Locale.ROOT) + ": " + protocol);
        }

        String sigEndpoint = get(env, "OTEL_EXPORTER_OTLP_" + upper + "_ENDPOINT").trim();
        String baseEndpoint = get(env, "OTEL_EXPORTER_OTLP_ENDPOINT").trim();
        String endpoint;
        if (!sigEndpoint.isEmpty()) {
            endpoint = sigEndpoint;
        } else if (!baseEndpoint.isEmpty()) {
            if ("grpc".equals(protocol)) {
                endpoint = baseEndpoint;
            } else {
                endpoint = baseEndpoint.endsWith("/") ? baseEndpoint + defaultPath : baseEndpoint + "/" + defaultPath;
            }
        } else {
            endpoint = "grpc".equals(protocol) ? DEFAULT_GRPC_ENDPOINT : DEFAULT_HTTP_ENDPOINT + "/" + defaultPath;
        }

        Map<String, String> headers = new LinkedHashMap<>();
        headers.putAll(parseKeyValuePairs(get(env, "OTEL_EXPORTER_OTLP_HEADERS")));
        headers.putAll(parseKeyValuePairs(get(env, "OTEL_EXPORTER_OTLP_" + upper + "_HEADERS")));

        String timeoutStr = get(env, "OTEL_EXPORTER_OTLP_" + upper + "_TIMEOUT").trim();
        if (timeoutStr.isEmpty()) {
            timeoutStr = get(env, "OTEL_EXPORTER_OTLP_TIMEOUT").trim();
        }
        Duration timeout = parseDurationMs(timeoutStr, DEFAULT_TIMEOUT);

        String compression = get(env, "OTEL_EXPORTER_OTLP_" + upper + "_COMPRESSION").trim();
        if (compression.isEmpty()) {
            compression = get(env, "OTEL_EXPORTER_OTLP_COMPRESSION").trim();
        }

        return new SignalConfig(
                exporter,
                protocol,
                endpoint,
                Collections.unmodifiableMap(headers),
                timeout,
                compression.toLowerCase(Locale.ROOT));
    }

    private static String firstValue(String raw) {
        if (raw == null || raw.isBlank()) {
            return "";
        }
        int comma = raw.indexOf(',');
        return (comma >= 0 ? raw.substring(0, comma) : raw).trim();
    }

    public static Map<String, String> parseKeyValuePairs(String raw) {
        if (raw == null || raw.isBlank()) {
            return Map.of();
        }
        Map<String, String> out = new LinkedHashMap<>();
        for (String part : raw.split(",")) {
            String trimmed = part.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            int eq = trimmed.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String k = trimmed.substring(0, eq).trim();
            String v = trimmed.substring(eq + 1).trim();
            try {
                v = URLDecoder.decode(v, StandardCharsets.UTF_8);
            } catch (IllegalArgumentException ignored) {
                // keep literal value
            }
            if (!k.isEmpty()) {
                out.put(k, v);
            }
        }
        return Collections.unmodifiableMap(out);
    }

    private static Sampler parseSampler(String name, String arg) {
        return switch (name) {
            case "", "parentbased_always_on" -> Sampler.parentBased(Sampler.alwaysOn());
            case "always_on" -> Sampler.alwaysOn();
            case "always_off" -> Sampler.alwaysOff();
            case "parentbased_always_off" -> Sampler.parentBased(Sampler.alwaysOff());
            case "traceidratio" -> Sampler.traceIdRatioBased(parseRatio(arg));
            case "parentbased_traceidratio" -> Sampler.parentBased(Sampler.traceIdRatioBased(parseRatio(arg)));
            default -> throw new O11yException(
                    O11yException.ErrorCode.INVALID_OPTION,
                    "unsupported OTEL_TRACES_SAMPLER: " + name);
        };
    }

    private static double parseRatio(String arg) {
        if (arg == null || arg.isEmpty()) {
            return 1.0;
        }
        try {
            double r = Double.parseDouble(arg);
            if (r < 0.0 || r > 1.0 || Double.isNaN(r)) {
                throw new O11yException(
                        O11yException.ErrorCode.INVALID_OPTION,
                        "OTEL_TRACES_SAMPLER_ARG must be between 0.0 and 1.0, got: " + arg);
            }
            return r;
        } catch (NumberFormatException ex) {
            throw new O11yException(
                    O11yException.ErrorCode.INVALID_OPTION,
                    "invalid OTEL_TRACES_SAMPLER_ARG: " + arg,
                    ex);
        }
    }

    private static ExemplarFilterMode parseExemplarFilter(String raw) {
        if (raw.isEmpty()) {
            return ExemplarFilterMode.TRACE_BASED;
        }
        return switch (raw.toLowerCase(Locale.ROOT)) {
            case "trace_based" -> ExemplarFilterMode.TRACE_BASED;
            case "always_on" -> ExemplarFilterMode.ALWAYS_ON;
            case "always_off" -> ExemplarFilterMode.ALWAYS_OFF;
            default -> throw new O11yException(
                    O11yException.ErrorCode.INVALID_OPTION,
                    "invalid OTEL_METRICS_EXEMPLAR_FILTER: " + raw);
        };
    }

    private static Duration parseDurationMs(String raw, Duration fallback) {
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        try {
            long ms = Long.parseLong(raw.trim());
            return ms > 0 ? Duration.ofMillis(ms) : fallback;
        } catch (NumberFormatException ex) {
            return fallback;
        }
    }
}
