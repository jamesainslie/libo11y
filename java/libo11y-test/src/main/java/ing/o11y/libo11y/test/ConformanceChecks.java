package ing.o11y.libo11y.test;

import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.internal.SensitivityPolicy;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.spec.generated.SpecTables;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.metrics.data.ExemplarData;
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.PointData;
import io.opentelemetry.sdk.metrics.data.SumData;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.trace.data.EventData;
import io.opentelemetry.sdk.trace.data.LinkData;
import io.opentelemetry.sdk.trace.data.SpanData;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Consumer;

/**
 * The checks behind {@link O11yRecorder#assertConforms()}, in the order the Go reference
 * ({@code o11ytest.AssertConforms}) runs them. Each method appends one message per problem.
 */
final class ConformanceChecks {
    /** The violation rule the policy records when it removes a secret-classified attribute. */
    static final String SECRET_ATTRIBUTE_RULE = SensitivityPolicy.RULE_SECRET_ATTRIBUTE;

    /** Rules the resource composer records under lenient identity for an unmet identity requirement. */
    private static final String IDENTITY_RULE_PREFIX = "identity_";

    private static final AttributeKey<String> RULE_KEY = AttributeKey.stringKey(Spec.Attributes.RULE.getKey());
    private static final AttributeKey<String> SIGNAL_KEY = AttributeKey.stringKey(Spec.Attributes.SIGNAL.getKey());
    private static final AttributeKey<String> EVENT_NAME_KEY = AttributeKey.stringKey(Spec.EVENT_NAME_KEY);

    private ConformanceChecks() {}

    /** Reports the schema URL and every required tier-0 attribute missing or empty on the resource. */
    static void checkResource(Resource resource, List<String> problems) {
        if (!Spec.SCHEMA_URL.equals(resource.getSchemaUrl())) {
            problems.add("resource schema URL is " + quote(resource.getSchemaUrl()) + ", want " + quote(Spec.SCHEMA_URL));
        }
        Attributes attrs = resource.getAttributes();
        for (String key : SpecTables.REQUIRED_TIER0) {
            Object value = attrs.get(AttributeKey.stringKey(key));
            if (value == null || value.toString().isBlank()) {
                problems.add("resource missing required tier-0 attribute " + quote(key));
            }
        }
    }

    /**
     * Reports, from the {@code o11y.schema.violations} self-metric, each signal on which the code
     * under test tried to emit a secret-classified attribute, and each identity rule a lenient
     * startup did not meet. The pipeline removed the secret, but secrets must never be emitted.
     * Secret attributes on metric measurements are dropped on the hot path without being counted,
     * so the metric-side checks in {@link #checkMetrics} cover them.
     */
    static void checkViolations(Collection<MetricData> metrics, List<String> problems) {
        Map<String, Long> secretsBySignal = new TreeMap<>();
        Map<String, Long> identityRules = new TreeMap<>();
        for (MetricData md : metrics) {
            if (!Spec.Metrics.SCHEMA_VIOLATIONS.equals(md.getName())) {
                continue;
            }
            if (!(md.getData() instanceof SumData<?> sum)) {
                continue;
            }
            for (PointData pt : sum.getPoints()) {
                if (!(pt instanceof LongPointData lp) || lp.getValue() <= 0) {
                    continue;
                }
                String rule = lp.getAttributes().get(RULE_KEY);
                String signal = lp.getAttributes().get(SIGNAL_KEY);
                if (SECRET_ATTRIBUTE_RULE.equals(rule)) {
                    secretsBySignal.merge(signal == null ? "" : signal, lp.getValue(), Long::sum);
                } else if (rule != null && rule.startsWith(IDENTITY_RULE_PREFIX)
                        && Spec.Signal.RESOURCE.value().equals(signal)) {
                    identityRules.merge(rule, lp.getValue(), Long::sum);
                }
            }
        }
        secretsBySignal.forEach((signal, n) -> {
            if (Spec.Signal.RESOURCE.value().equals(signal)) {
                problems.add(String.format(Locale.ROOT,
                        "options passed to O11yRecorder.start put a secret-classified attribute on the resource "
                                + "(%d redaction(s) counted); it was redacted, but secrets must never be emitted", n));
            } else {
                problems.add(String.format(Locale.ROOT,
                        "the code under test emitted secret-classified attributes on %s "
                                + "(%d redaction(s) counted); they were redacted, but secrets must never be emitted",
                        signal, n));
            }
        });
        identityRules.keySet().forEach(rule -> problems.add(
                "resource identity rule " + rule + " is not met; strictIdentity(false) let startup continue, "
                        + "but the service identity does not conform"));
    }

    /**
     * Reports every secret-classified attribute in the clear on a log record or structured log
     * entry, and every registered event record lacking an attribute its contract requires.
     */
    static void checkLogs(
            SensitivityPolicy policy,
            Collection<LogRecordData> records,
            Collection<StructuredLogger.LogEntry> entries,
            List<String> problems) {
        for (LogRecordData lr : records) {
            String body = lr.getBodyValue() == null ? "" : lr.getBodyValue().asString();
            List<String> keys = new ArrayList<>();
            lr.getAttributes().forEach((k, v) -> keys.add(k.getKey()));
            for (String key : keys) {
                if (isSecret(policy, key)) {
                    problems.add("log record " + quote(body) + " carries secret-classified attribute "
                            + quote(key) + " in the clear");
                }
            }
            String eventName = lr.getEventName();
            if (eventName == null || eventName.isEmpty()) {
                eventName = lr.getAttributes().get(EVENT_NAME_KEY);
            }
            if (eventName != null) {
                problems.addAll(checkEvent(eventName, keys));
            }
        }
        for (StructuredLogger.LogEntry entry : entries) {
            walkKeys("", entry.attributes(), new IdentityHashMap<>(), key -> {
                if (isSecret(policy, key)) {
                    problems.add("log entry " + quote(entry.message()) + " carries secret-classified attribute "
                            + quote(key) + " in the clear");
                }
            });
        }
    }

    /**
     * Reports every way a record for the named event, carrying the given attribute keys, violates
     * its registered contract. Unregistered event names have no contract and yield no problems.
     */
    static List<String> checkEvent(String name, Collection<String> keys) {
        SpecTables.EventInfo info = SpecTables.EVENTS.get(name);
        if (info == null) {
            return List.of();
        }
        Set<String> present = new HashSet<>(keys);
        List<String> problems = new ArrayList<>();
        for (String req : info.required()) {
            if (!present.contains(req)) {
                problems.add("event " + name + ": missing required attribute " + req);
            }
        }
        for (String template : info.requiredTemplates()) {
            String prefix = template + ".";
            // A bare "<template>." carries no key, so it does not satisfy the template.
            boolean satisfied = keys.stream().anyMatch(k -> k.length() > prefix.length() && k.startsWith(prefix));
            if (!satisfied) {
                problems.add("event " + name + ": missing required template attribute " + prefix + "<key>");
            }
        }
        return problems;
    }

    /** Reports every secret-classified attribute in the clear on a span, a span event or a span link. */
    static void checkSpans(SensitivityPolicy policy, Collection<SpanData> spans, List<String> problems) {
        for (SpanData span : spans) {
            span.getAttributes().forEach((k, v) -> {
                if (isSecret(policy, k.getKey())) {
                    problems.add("span " + quote(span.getName()) + " carries secret-classified attribute "
                            + quote(k.getKey()) + " in the clear");
                }
            });
            for (EventData ev : span.getEvents()) {
                ev.getAttributes().forEach((k, v) -> {
                    if (isSecret(policy, k.getKey())) {
                        problems.add("span " + quote(span.getName()) + " event " + quote(ev.getName())
                                + " carries secret-classified attribute " + quote(k.getKey()) + " in the clear");
                    }
                });
            }
            for (LinkData link : span.getLinks()) {
                link.getAttributes().forEach((k, v) -> {
                    if (isSecret(policy, k.getKey())) {
                        problems.add("span " + quote(span.getName()) + " link carries secret-classified attribute "
                                + quote(k.getKey()) + " in the clear");
                    }
                });
            }
        }
    }

    /**
     * Reports every metric data point and exemplar carrying an attribute the policy removes from
     * metrics: secret always, and PII unless the PII mode keeps it.
     */
    static void checkMetrics(SensitivityPolicy policy, Collection<MetricData> metrics, List<String> problems) {
        for (MetricData md : metrics) {
            for (PointData pt : md.getData().getPoints()) {
                pt.getAttributes().forEach((k, v) -> {
                    if (policy.isMetricDisallowed(k.getKey())) {
                        problems.add("metric " + md.getName() + " data point carries disallowed "
                                + policy.sensitivityOf(k.getKey()).name().toLowerCase(Locale.ROOT)
                                + " attribute " + quote(k.getKey()));
                    }
                });
                for (ExemplarData ex : pt.getExemplars()) {
                    ex.getFilteredAttributes().forEach((k, v) -> {
                        if (policy.isMetricDisallowed(k.getKey())) {
                            problems.add("metric " + md.getName() + " exemplar carries disallowed "
                                    + policy.sensitivityOf(k.getKey()).name().toLowerCase(Locale.ROOT)
                                    + " attribute " + quote(k.getKey()));
                        }
                    });
                }
            }
        }
    }

    private static boolean isSecret(SensitivityPolicy policy, String key) {
        return policy.sensitivityOf(key) == SpecTables.Sensitivity.SECRET;
    }

    /** Visits the dotted key of every leaf under a nested structured-log attribute map. */
    private static void walkKeys(String prefix, Map<?, ?> map, IdentityHashMap<Object, Boolean> seen,
            Consumer<String> visit) {
        if (seen.put(map, Boolean.TRUE) != null) {
            return;
        }
        for (Map.Entry<?, ?> e : map.entrySet()) {
            String key = prefix.isEmpty() ? String.valueOf(e.getKey()) : prefix + "." + e.getKey();
            if (e.getValue() instanceof Map<?, ?> nested) {
                walkKeys(key, nested, seen, visit);
            } else {
                visit.accept(key);
            }
        }
    }

    private static String quote(String s) {
        return "\"" + s + "\"";
    }
}
