package ing.o11y.libo11y.internal;

import ing.o11y.libo11y.ExemplarFilterMode;
import ing.o11y.libo11y.O11yEnv;
import ing.o11y.libo11y.O11yException;
import io.opentelemetry.sdk.logs.LogLimits;
import io.opentelemetry.sdk.logs.LogLimitsBuilder;
import io.opentelemetry.sdk.metrics.export.AggregationTemporalitySelector;
import io.opentelemetry.sdk.trace.SpanLimits;
import io.opentelemetry.sdk.trace.SpanLimitsBuilder;
import io.opentelemetry.sdk.trace.samplers.Sampler;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.IntConsumer;

/**
 * Reads the standard {@code OTEL_*} environment variables, and nothing else.
 *
 * <p>{@link #parse(Map)} reads only the identity variables. Every other setting is parsed and
 * validated when the pipeline asks for it, so a variable that an explicit code option overrides,
 * or that belongs to a signal routed elsewhere, is never read and can never fail initialisation.
 * In hermetic mode ({@link O11yEnv#HERMETIC}) no variable is read at all and every accessor
 * returns the library default. Invalid values of the variables that select behaviour (exporters,
 * protocols, endpoints, TLS files, sampler, exemplar filter, temporality, propagators) are typed
 * {@link O11yException}s; an invalid number for a batch, timeout or limit variable keeps the SDK
 * default, as the OpenTelemetry specification asks.
 */
public final class O11yEnvParser {
    /** The signal name of the traces variables, as in {@code OTEL_TRACES_EXPORTER}. */
    public static final String TRACES = "TRACES";
    /** The signal name of the metrics variables, as in {@code OTEL_METRICS_EXPORTER}. */
    public static final String METRICS = "METRICS";
    /** The signal name of the logs variables, as in {@code OTEL_LOGS_EXPORTER}. */
    public static final String LOGS = "LOGS";

    /** The exporter names {@code OTEL_{TRACES,METRICS,LOGS}_EXPORTER} accept. */
    public static final String OTLP = "otlp";
    /** The console exporter name. */
    public static final String CONSOLE = "console";
    /** The name that turns a signal's exporter off. */
    public static final String NONE = "none";

    /**
     * The propagator names {@code OTEL_PROPAGATORS} accepts, matched case-sensitively as the
     * specification defines them. {@code jaeger} and {@code ottrace} are not offered because their
     * OpenTelemetry Java propagators are deprecated, and {@code xray} lives in contrib.
     */
    public static final Set<String> PROPAGATORS = Set.of("tracecontext", "baggage", "b3", "b3multi", NONE);

    /**
     * The resolved OTLP settings of one signal.
     *
     * @param protocol {@code grpc} or {@code http/protobuf}
     * @param endpoint the validated endpoint URL
     * @param headers the request headers, percent-decoded
     * @param timeout the export timeout
     * @param compression {@code gzip}, or empty for none
     * @param tls the TLS material, or {@code null} for the JVM defaults
     * @param temporality the metrics temporality preference; {@code null} for traces and logs
     */
    public record SignalConfig(
            String protocol,
            String endpoint,
            Map<String, String> headers,
            Duration timeout,
            String compression,
            TlsConfig tls,
            AggregationTemporalitySelector temporality) {}

    /**
     * TLS material read from the files the certificate variables name. Each value is PEM text;
     * {@code clientKey} and {@code clientCertificate} are both set or both {@code null}.
     *
     * @param trustedCertificates the CA certificates that verify the collector, or {@code null}
     * @param clientKey the PKCS#8 client private key for mutual TLS, or {@code null}
     * @param clientCertificate the client certificate chain for mutual TLS, or {@code null}
     */
    public record TlsConfig(byte[] trustedCertificates, byte[] clientKey, byte[] clientCertificate) {}

    /**
     * Batch processor settings from {@code OTEL_BSP_*} or {@code OTEL_BLRP_*}; a {@code null}
     * field keeps the SDK default.
     *
     * @param scheduleDelay the delay between two exports
     * @param exportTimeout the longest an export may run
     * @param maxQueueSize the queue capacity
     * @param maxExportBatchSize the largest batch
     */
    public record BatchConfig(
            Duration scheduleDelay, Duration exportTimeout, Integer maxQueueSize, Integer maxExportBatchSize) {}

    private static final String DEFAULT_PROTOCOL = "http/protobuf";
    private static final String DEFAULT_HTTP_ENDPOINT = "http://localhost:4318";
    private static final String DEFAULT_GRPC_ENDPOINT = "http://localhost:4317";
    private static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(10);
    private static final Duration DEFAULT_METRIC_INTERVAL = Duration.ofSeconds(60);
    private static final String DEFAULT_SAMPLER = "parentbased_always_on";

    private O11yEnvParser() {}

    /**
     * Returns the environment view of {@code envInput}: the process environment when it is
     * {@code null}, nothing at all when it is {@link O11yEnv#HERMETIC}, and the map otherwise.
     * Only the identity variables ({@code OTEL_SERVICE_NAME}, {@code OTEL_RESOURCE_ATTRIBUTES})
     * are parsed here.
     */
    public static ParsedEnv parse(Map<String, String> envInput) {
        if (O11yEnv.isHermetic(envInput)) {
            return new ParsedEnv(true, Map.of());
        }
        return new ParsedEnv(false, envInput != null ? envInput : System.getenv());
    }

    /** A lazily parsed view of the standard environment variables. */
    public static final class ParsedEnv {
        private final boolean hermetic;
        private final Map<String, String> env;
        private final String serviceName;
        private final Map<String, String> resourceAttributes;

        private ParsedEnv(boolean hermetic, Map<String, String> env) {
            this.hermetic = hermetic;
            this.env = env;
            this.serviceName = get("OTEL_SERVICE_NAME").trim();
            this.resourceAttributes = parseKeyValuePairs(get("OTEL_RESOURCE_ATTRIBUTES"));
        }

        /** Reports whether no variable is read at all. */
        public boolean hermetic() {
            return hermetic;
        }

        /** Returns the variable {@code key} as set, or an empty string when it is unset or hermetic mode is on. */
        public String raw(String key) {
            return get(key);
        }

        private String get(String key) {
            String v = env.get(key);
            return v == null ? "" : v;
        }

        /** Reports whether {@code OTEL_SDK_DISABLED} is {@code true}, in any case. */
        public boolean sdkDisabled() {
            return "true".equalsIgnoreCase(get("OTEL_SDK_DISABLED").trim());
        }

        /** Returns {@code OTEL_SERVICE_NAME}, trimmed, or an empty string. */
        public String serviceName() {
            return serviceName;
        }

        /** Returns {@code OTEL_RESOURCE_ATTRIBUTES}, percent-decoded. */
        public Map<String, String> resourceAttributes() {
            return resourceAttributes;
        }

        /**
         * Returns the exporters {@code OTEL_<signal>_EXPORTER} selects, each once and in order:
         * {@code otlp} when it is unset, {@code none} alone to turn the signal off. Hermetic mode
         * selects {@code none}.
         *
         * @throws O11yException {@code EXPORTER} for an unknown exporter or {@code none} in a list
         */
        public List<String> exporters(String signal) {
            if (hermetic) {
                return List.of(NONE);
            }
            String key = "OTEL_" + signal + "_EXPORTER";
            LinkedHashSet<String> names = new LinkedHashSet<>();
            for (String part : get(key).split(",", -1)) {
                String name = part.trim().toLowerCase(Locale.ROOT);
                if (!name.isEmpty()) {
                    names.add(name);
                }
            }
            if (names.isEmpty()) {
                return List.of(OTLP);
            }
            for (String name : names) {
                if (!OTLP.equals(name) && !CONSOLE.equals(name) && !NONE.equals(name)) {
                    throw new O11yException(
                            O11yException.ErrorCode.EXPORTER,
                            "unsupported " + key + " value: " + name + " (supported: otlp, console, none)");
                }
            }
            if (names.contains(NONE) && names.size() > 1) {
                throw new O11yException(
                        O11yException.ErrorCode.EXPORTER,
                        key + " lists none together with other exporters: " + String.join(",", names));
            }
            return List.copyOf(names);
        }

        /**
         * Resolves the OTLP exporter settings of {@code signal} ({@link #TRACES}, {@link #METRICS}
         * or {@link #LOGS}), with the per-signal variables over the general ones, and validates
         * them: protocol, endpoint URL and TLS files.
         *
         * @throws O11yException {@code UNSUPPORTED_PROTOCOL} or {@code EXPORTER}, and
         *     {@code INVALID_OPTION} for an unknown temporality preference
         */
        public SignalConfig otlp(String signal) {
            String lower = signal.toLowerCase(Locale.ROOT);
            String protocol = perSignal(signal, "PROTOCOL").trim().toLowerCase(Locale.ROOT);
            if (protocol.isEmpty()) {
                protocol = DEFAULT_PROTOCOL;
            }
            if (!"http/protobuf".equals(protocol) && !"grpc".equals(protocol)) {
                throw new O11yException(
                        O11yException.ErrorCode.UNSUPPORTED_PROTOCOL,
                        "unsupported OTLP protocol for " + lower + ": " + protocol);
            }
            String endpoint = endpoint(signal, protocol);

            Map<String, String> headers = new LinkedHashMap<>();
            headers.putAll(parseKeyValuePairs(get("OTEL_EXPORTER_OTLP_HEADERS")));
            headers.putAll(parseKeyValuePairs(get("OTEL_EXPORTER_OTLP_" + signal + "_HEADERS")));

            Duration timeout = parseMillis(perSignal(signal, "TIMEOUT"), DEFAULT_TIMEOUT);
            String compression = perSignal(signal, "COMPRESSION").trim().toLowerCase(Locale.ROOT);
            if (NONE.equals(compression)) {
                compression = "";
            }

            AggregationTemporalitySelector temporality = METRICS.equals(signal) ? temporality() : null;
            return new SignalConfig(
                    protocol,
                    endpoint,
                    Collections.unmodifiableMap(headers),
                    timeout,
                    compression,
                    tls(signal),
                    temporality);
        }

        /** Returns the per-signal variable {@code OTEL_EXPORTER_OTLP_<signal>_<suffix>}, or the general one. */
        private String perSignal(String signal, String suffix) {
            String v = get("OTEL_EXPORTER_OTLP_" + signal + "_" + suffix);
            return v.trim().isEmpty() ? get("OTEL_EXPORTER_OTLP_" + suffix) : v;
        }

        /** Returns the name of the variable that set {@code suffix} for {@code signal}, for error messages. */
        private String perSignalKey(String signal, String suffix) {
            String key = "OTEL_EXPORTER_OTLP_" + signal + "_" + suffix;
            return get(key).trim().isEmpty() ? "OTEL_EXPORTER_OTLP_" + suffix : key;
        }

        private String endpoint(String signal, String protocol) {
            String sigKey = "OTEL_EXPORTER_OTLP_" + signal + "_ENDPOINT";
            String sigEndpoint = get(sigKey).trim();
            String baseEndpoint = get("OTEL_EXPORTER_OTLP_ENDPOINT").trim();
            boolean grpc = "grpc".equals(protocol);
            String path = "v1/" + signal.toLowerCase(Locale.ROOT);
            if (!sigEndpoint.isEmpty()) {
                return validEndpoint(sigKey, sigEndpoint);
            }
            if (!baseEndpoint.isEmpty()) {
                validEndpoint("OTEL_EXPORTER_OTLP_ENDPOINT", baseEndpoint);
                if (grpc) {
                    return baseEndpoint;
                }
                return baseEndpoint.endsWith("/") ? baseEndpoint + path : baseEndpoint + "/" + path;
            }
            return grpc ? DEFAULT_GRPC_ENDPOINT : DEFAULT_HTTP_ENDPOINT + "/" + path;
        }

        private static String validEndpoint(String key, String value) {
            String why;
            try {
                URI uri = new URI(value);
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    why = "the URL must start with http:// or https://";
                } else if (uri.getHost() == null || uri.getHost().isEmpty()) {
                    why = "the URL has no host";
                } else {
                    return value;
                }
            } catch (URISyntaxException ex) {
                why = "not a URL";
            }
            // The value can carry credentials, so the message names it only sanitized.
            throw new O11yException(
                    O11yException.ErrorCode.EXPORTER,
                    "invalid " + key + " " + EndpointSanitizer.sanitize(value) + ": " + why);
        }

        private TlsConfig tls(String signal) {
            byte[] trusted = readFile(signal, "CERTIFICATE");
            byte[] key = readFile(signal, "CLIENT_KEY");
            byte[] cert = readFile(signal, "CLIENT_CERTIFICATE");
            if ((key == null) != (cert == null)) {
                throw new O11yException(
                        O11yException.ErrorCode.EXPORTER,
                        "mutual TLS for " + signal.toLowerCase(Locale.ROOT) + " needs both "
                                + perSignalKey(signal, "CLIENT_KEY") + " and "
                                + perSignalKey(signal, "CLIENT_CERTIFICATE"));
            }
            if (trusted == null && key == null) {
                return null;
            }
            return new TlsConfig(trusted, key, cert);
        }

        private byte[] readFile(String signal, String suffix) {
            String path = perSignal(signal, suffix).trim();
            if (path.isEmpty()) {
                return null;
            }
            String key = perSignalKey(signal, suffix);
            try {
                return Files.readAllBytes(Path.of(path));
            } catch (IOException | InvalidPathException ex) {
                throw new O11yException(
                        O11yException.ErrorCode.EXPORTER,
                        "cannot read the file " + key + " names (" + path + "): " + ex.getMessage(),
                        ex);
            }
        }

        private AggregationTemporalitySelector temporality() {
            String raw = get("OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE").trim().toLowerCase(Locale.ROOT);
            return switch (raw) {
                case "", "cumulative" -> AggregationTemporalitySelector.alwaysCumulative();
                case "delta" -> AggregationTemporalitySelector.deltaPreferred();
                case "lowmemory" -> AggregationTemporalitySelector.lowMemory();
                default -> throw new O11yException(
                        O11yException.ErrorCode.INVALID_OPTION,
                        "invalid OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: " + raw
                                + " (supported: cumulative, delta, lowmemory)");
            };
        }

        /**
         * Returns the sampler {@code OTEL_TRACES_SAMPLER} and {@code OTEL_TRACES_SAMPLER_ARG}
         * select; the parent-based always-on sampler when unset or hermetic.
         *
         * @throws O11yException {@code INVALID_OPTION} for an unknown sampler or a bad ratio
         */
        public Sampler sampler() {
            String arg = get("OTEL_TRACES_SAMPLER_ARG").trim();
            return switch (samplerName()) {
                case DEFAULT_SAMPLER -> Sampler.parentBased(Sampler.alwaysOn());
                case "always_on" -> Sampler.alwaysOn();
                case "always_off" -> Sampler.alwaysOff();
                case "parentbased_always_off" -> Sampler.parentBased(Sampler.alwaysOff());
                case "traceidratio" -> Sampler.traceIdRatioBased(parseRatio(arg));
                case "parentbased_traceidratio" -> Sampler.parentBased(Sampler.traceIdRatioBased(parseRatio(arg)));
                default -> throw new O11yException(
                        O11yException.ErrorCode.INVALID_OPTION,
                        "unsupported OTEL_TRACES_SAMPLER: " + samplerName());
            };
        }

        /** Returns the name {@code OTEL_TRACES_SAMPLER} sets, trimmed and lowercased, or the default name. */
        public String samplerName() {
            String raw = get("OTEL_TRACES_SAMPLER").trim().toLowerCase(Locale.ROOT);
            return raw.isEmpty() ? DEFAULT_SAMPLER : raw;
        }

        /**
         * Returns the exemplar filter {@code OTEL_METRICS_EXEMPLAR_FILTER} selects; trace-based
         * when unset or hermetic.
         *
         * @throws O11yException {@code INVALID_OPTION} for an unknown filter
         */
        public ExemplarFilterMode exemplarFilter() {
            String raw = get("OTEL_METRICS_EXEMPLAR_FILTER").trim();
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

        /** Returns {@code OTEL_METRIC_EXPORT_INTERVAL}, 60 seconds by default. */
        public Duration metricExportInterval() {
            return parseMillis(get("OTEL_METRIC_EXPORT_INTERVAL"), DEFAULT_METRIC_INTERVAL);
        }

        /** Returns {@code OTEL_METRIC_EXPORT_TIMEOUT}, or {@code null} for the SDK default. */
        public Duration metricExportTimeout() {
            return parseMillis(get("OTEL_METRIC_EXPORT_TIMEOUT"), null);
        }

        /** Returns the span batch settings {@code OTEL_BSP_*} set. */
        public BatchConfig spanBatch() {
            return batch("OTEL_BSP_");
        }

        /** Returns the log batch settings {@code OTEL_BLRP_*} set. */
        public BatchConfig logBatch() {
            return batch("OTEL_BLRP_");
        }

        private BatchConfig batch(String prefix) {
            return new BatchConfig(
                    parseMillis(get(prefix + "SCHEDULE_DELAY"), null),
                    parseMillis(get(prefix + "EXPORT_TIMEOUT"), null),
                    parsePositiveInt(get(prefix + "MAX_QUEUE_SIZE")),
                    parsePositiveInt(get(prefix + "MAX_EXPORT_BATCH_SIZE")));
        }

        /**
         * Returns the span limits the {@code OTEL_SPAN_*}, {@code OTEL_EVENT_*} and
         * {@code OTEL_LINK_*} variables set, with {@code OTEL_ATTRIBUTE_COUNT_LIMIT} and
         * {@code OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT} as their fallbacks, over the SDK defaults.
         */
        public SpanLimits spanLimits() {
            SpanLimitsBuilder b = SpanLimits.builder();
            setLimit(limit("OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT", "OTEL_ATTRIBUTE_COUNT_LIMIT"), b::setMaxNumberOfAttributes);
            setLimit(limit("OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT", "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT"),
                    b::setMaxAttributeValueLength);
            setLimit(limit("OTEL_SPAN_EVENT_COUNT_LIMIT", null), b::setMaxNumberOfEvents);
            setLimit(limit("OTEL_SPAN_LINK_COUNT_LIMIT", null), b::setMaxNumberOfLinks);
            setLimit(limit("OTEL_EVENT_ATTRIBUTE_COUNT_LIMIT", "OTEL_ATTRIBUTE_COUNT_LIMIT"),
                    b::setMaxNumberOfAttributesPerEvent);
            setLimit(limit("OTEL_LINK_ATTRIBUTE_COUNT_LIMIT", "OTEL_ATTRIBUTE_COUNT_LIMIT"),
                    b::setMaxNumberOfAttributesPerLink);
            return b.build();
        }

        /**
         * Returns the log record limits {@code OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT} and
         * {@code OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT} set, with the general attribute
         * limits as their fallbacks, over the SDK defaults.
         */
        public LogLimits logLimits() {
            LogLimitsBuilder b = LogLimits.builder();
            setLimit(limit("OTEL_LOGRECORD_ATTRIBUTE_COUNT_LIMIT", "OTEL_ATTRIBUTE_COUNT_LIMIT"),
                    b::setMaxNumberOfAttributes);
            setLimit(limit("OTEL_LOGRECORD_ATTRIBUTE_VALUE_LENGTH_LIMIT", "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT"),
                    b::setMaxAttributeValueLength);
            return b.build();
        }

        private Integer limit(String key, String fallbackKey) {
            Integer v = parsePositiveInt(get(key));
            if (v == null && fallbackKey != null) {
                v = parsePositiveInt(get(fallbackKey));
            }
            return v;
        }

        private static void setLimit(Integer value, IntConsumer setter) {
            if (value != null) {
                setter.accept(value);
            }
        }

        /**
         * Returns the propagator names {@code OTEL_PROPAGATORS} lists, trimmed and in order, or an
         * empty list when it is unset (the W3C default then applies).
         *
         * @throws O11yException {@code INVALID_OPTION} for a name libo11y cannot build
         */
        public List<String> propagators() {
            List<String> names = new ArrayList<>();
            for (String part : get("OTEL_PROPAGATORS").split(",", -1)) {
                String name = part.trim();
                if (name.isEmpty()) {
                    continue;
                }
                if (!PROPAGATORS.contains(name)) {
                    throw new O11yException(
                            O11yException.ErrorCode.INVALID_OPTION,
                            "unsupported OTEL_PROPAGATORS entry: " + name
                                    + " (supported: tracecontext, baggage, b3, b3multi, none)");
                }
                if (!names.contains(name)) {
                    names.add(name);
                }
            }
            return List.copyOf(names);
        }
    }

    /**
     * Parses a {@code key=value,key=value} list as {@code OTEL_RESOURCE_ATTRIBUTES} and
     * {@code OTEL_EXPORTER_OTLP_HEADERS} define it. Only percent escapes are decoded, as Go's
     * {@code url.PathUnescape} does, so a {@code +} stays a plus sign; a value with a malformed
     * escape is kept as written. Entries without {@code =} or with an empty key are skipped.
     */
    public static Map<String, String> parseKeyValuePairs(String raw) {
        if (raw == null || raw.isBlank()) {
            return Map.of();
        }
        Map<String, String> out = new LinkedHashMap<>();
        for (String part : raw.split(",")) {
            String trimmed = part.trim();
            int eq = trimmed.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String k = trimmed.substring(0, eq).trim();
            String v = trimmed.substring(eq + 1).trim();
            if (!k.isEmpty()) {
                out.put(k, percentDecode(v));
            }
        }
        return Collections.unmodifiableMap(out);
    }

    /** Decodes {@code %XX} escapes as UTF-8 bytes and nothing else; a malformed escape returns {@code s} unchanged. */
    static String percentDecode(String s) {
        if (s.indexOf('%') < 0) {
            return s;
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(s.length());
        int run = 0;
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) != '%') {
                continue;
            }
            // Literal text is copied in whole runs, so a surrogate pair is encoded as one code point.
            bytes.writeBytes(s.substring(run, i).getBytes(StandardCharsets.UTF_8));
            if (i + 2 >= s.length()) {
                return s;
            }
            int hi = Character.digit(s.charAt(i + 1), 16);
            int lo = Character.digit(s.charAt(i + 2), 16);
            if (hi < 0 || lo < 0) {
                return s;
            }
            bytes.write((hi << 4) | lo);
            i += 2;
            run = i + 1;
        }
        bytes.writeBytes(s.substring(run).getBytes(StandardCharsets.UTF_8));
        return bytes.toString(StandardCharsets.UTF_8);
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

    /** Parses a positive number of milliseconds; anything else returns {@code fallback}. */
    private static Duration parseMillis(String raw, Duration fallback) {
        Integer ms = parsePositiveInt(raw);
        return ms == null ? fallback : Duration.ofMillis(ms);
    }

    /** Parses a positive integer; an unset, malformed or non-positive value returns {@code null}. */
    private static Integer parsePositiveInt(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            int v = Integer.parseInt(raw.trim());
            return v > 0 ? v : null;
        } catch (NumberFormatException ex) {
            return null;
        }
    }
}
