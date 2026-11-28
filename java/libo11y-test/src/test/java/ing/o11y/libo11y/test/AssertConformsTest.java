package ing.o11y.libo11y.test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.TraceFlags;
import io.opentelemetry.api.trace.TraceState;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.sdk.common.InstrumentationScopeInfo;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.metrics.data.AggregationTemporality;
import io.opentelemetry.sdk.metrics.data.DoubleExemplarData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.internal.data.ImmutableDoubleExemplarData;
import io.opentelemetry.sdk.metrics.internal.data.ImmutableDoublePointData;
import io.opentelemetry.sdk.metrics.internal.data.ImmutableMetricData;
import io.opentelemetry.sdk.metrics.internal.data.ImmutableSumData;
import io.opentelemetry.sdk.resources.Resource;
import io.opentelemetry.sdk.testing.logs.TestLogRecordData;
import io.opentelemetry.sdk.testing.trace.TestSpanData;
import io.opentelemetry.sdk.trace.data.EventData;
import io.opentelemetry.sdk.trace.data.LinkData;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.data.StatusData;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

/**
 * Each check {@link O11yRecorder#assertConforms()} makes has a test that passes and a test that
 * proves the harness catches the violation.
 */
@ExtendWith(O11yExtension.class)
class AssertConformsTest {
    private static final String TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
    private static final String SPAN_ID = "b7ad6b7169203331";
    private static final String SECRET_KEY = "http.request.header.authorization";

    private static AssertionError conformanceFailure(O11yRecorder rec) {
        return assertThrows(AssertionError.class, rec::assertConforms);
    }

    private static Map<String, Object> completeSummary() {
        Map<String, Object> attrs = new LinkedHashMap<>();
        attrs.put("http.request.method", "GET");
        attrs.put("http.response.status_code", 200L);
        attrs.put(Spec.Attributes.OUTCOME, Spec.Outcome.SUCCESS);
        attrs.put(Spec.Attributes.DURATION, 0.012);
        return attrs;
    }

    @Test
    void conformingTelemetryOnEverySignalPasses(O11yRecorder rec) {
        Telemetry t = rec.telemetry();
        Span span = t.tracer("app").spanBuilder("op").setAttribute("order.id", "o-1").startSpan();
        try (Scope ignored = span.makeCurrent()) {
            span.addEvent("step", Attributes.of(AttributeKey.stringKey("step.name"), "charge"));
            t.logger().info("inside", Map.of("order.id", "o-1"));
            t.event(Spec.Events.REQUEST_SUMMARY, completeSummary());
            t.meter("app").histogramBuilder("app.latency").build()
                    .record(0.5, Attributes.of(AttributeKey.stringKey("region"), "eu"), Context.current());
        } finally {
            span.end();
        }
        assertDoesNotThrow(rec::assertConforms);
    }

    // (a) secrets the code under test tried to emit, read from o11y.schema.violations

    @Test
    void secretOnSpanFailsThroughTheViolationCounter(O11yRecorder rec) {
        rec.telemetry().tracer("app").spanBuilder("op").setAttribute(SECRET_KEY, "Bearer x").startSpan().end();
        // The pipeline dropped it: nothing is in the clear.
        assertEquals(null, rec.spans().get(0).getAttributes().get(AttributeKey.stringKey(SECRET_KEY)));
        AssertionError err = conformanceFailure(rec);
        assertTrue(err.getMessage().contains("emitted secret-classified attributes on traces"), err.getMessage());
    }

    @Test
    void secretOnLogFailsThroughTheViolationCounter(O11yRecorder rec) {
        rec.telemetry().logger().info("login", Map.of(SECRET_KEY, "Bearer x"));
        AssertionError err = conformanceFailure(rec);
        assertTrue(err.getMessage().contains("emitted secret-classified attributes on logs"), err.getMessage());
    }

    @Test
    void secretOnResourceFailsAndNamesTheOptions() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.resourceAttribute(SECRET_KEY, "Bearer x"))) {
            AssertionError err = conformanceFailure(rec);
            assertTrue(err.getMessage().contains("put a secret-classified attribute on the resource"), err.getMessage());
        }
    }

    @Test
    void piiInDropModeIsNotAConformanceFailure(O11yRecorder rec) {
        rec.telemetry().logger().info("signup", Map.of("device.id", "dev-123"));
        assertDoesNotThrow(rec::assertConforms);
    }

    // (b) registered event contracts

    @Test
    void completeRequestSummaryPasses(O11yRecorder rec) {
        rec.telemetry().event(Spec.Events.REQUEST_SUMMARY, completeSummary());
        assertDoesNotThrow(rec::assertConforms);
    }

    @Test
    void emptyRequestSummaryFailsForEachMissingAttribute(O11yRecorder rec) {
        rec.telemetry().event(Spec.Events.REQUEST_SUMMARY, Map.of());
        AssertionError err = conformanceFailure(rec);
        for (String req : List.of("http.request.method", "http.response.status_code", "o11y.outcome", "o11y.duration")) {
            assertTrue(err.getMessage().contains("event o11y.request.summary: missing required attribute " + req),
                    err.getMessage());
        }
    }

    @Test
    void wideRecordWithoutRequiredAttributesFails(O11yRecorder rec) {
        try (O11yRecord wide = O11yRecord.start(rec.telemetry(), Spec.Events.REQUEST_SUMMARY)) {
            wide.set("order.id", "o-1").setOutcome(Spec.Outcome.SUCCESS);
        }
        AssertionError err = conformanceFailure(rec);
        assertTrue(err.getMessage().contains("missing required attribute o11y.duration"), err.getMessage());
    }

    @Test
    void requiredTemplateNeedsAKeyAfterThePrefix(O11yRecorder rec) {
        rec.telemetry().event(Spec.Events.TELEMETRY_CONFIGURED, Map.of("o11y.config", "x"));
        AssertionError err = conformanceFailure(rec);
        assertTrue(err.getMessage().contains(
                "event o11y.telemetry.configured: missing required template attribute o11y.config.<key>"),
                err.getMessage());
    }

    @Test
    void requiredTemplateSatisfiedPasses(O11yRecorder rec) {
        rec.telemetry().event(Spec.Events.TELEMETRY_CONFIGURED, Map.of("o11y.config.traces", "otlp"));
        assertDoesNotThrow(rec::assertConforms);
    }

    @Test
    void unregisteredEventHasNoContract(O11yRecorder rec) {
        rec.telemetry().event("app.checkout.done", Map.of());
        assertDoesNotThrow(rec::assertConforms);
    }

    // (c) secrets in the clear on every surface: a record that reached the exporter unredacted

    private static SpanData spanWith(Attributes attrs, List<EventData> events, List<LinkData> links) {
        return TestSpanData.builder()
                .setSpanContext(SpanContext.create(TRACE_ID, SPAN_ID, TraceFlags.getSampled(), TraceState.getDefault()))
                .setName("leaky")
                .setKind(SpanKind.INTERNAL)
                .setStartEpochNanos(1L)
                .setEndEpochNanos(2L)
                .setHasEnded(true)
                .setStatus(StatusData.unset())
                .setAttributes(attrs)
                .setEvents(events)
                .setTotalRecordedEvents(events.size())
                .setLinks(links)
                .setTotalRecordedLinks(links.size())
                .build();
    }

    private static Attributes secretAttrs() {
        return Attributes.of(AttributeKey.stringKey(SECRET_KEY), "Bearer x");
    }

    @Test
    void secretOnSpanAttributesInTheClearFails(O11yRecorder rec) {
        rec.spanExporter().export(List.of(spanWith(secretAttrs(), List.of(), List.of())));
        AssertionError err = conformanceFailure(rec);
        assertTrue(err.getMessage().contains(
                "span \"leaky\" carries secret-classified attribute \"" + SECRET_KEY + "\" in the clear"),
                err.getMessage());
    }

    @Test
    void secretOnSpanEventInTheClearFails(O11yRecorder rec) {
        EventData ev = EventData.create(1L, "retry", secretAttrs());
        rec.spanExporter().export(List.of(spanWith(Attributes.empty(), List.of(ev), List.of())));
        AssertionError err = conformanceFailure(rec);
        assertTrue(err.getMessage().contains("span \"leaky\" event \"retry\" carries secret-classified attribute"),
                err.getMessage());
    }

    @Test
    void secretOnSpanLinkInTheClearFails(O11yRecorder rec) {
        LinkData link = LinkData.create(
                SpanContext.create(TRACE_ID, SPAN_ID, TraceFlags.getSampled(), TraceState.getDefault()), secretAttrs());
        rec.spanExporter().export(List.of(spanWith(Attributes.empty(), List.of(), List.of(link))));
        AssertionError err = conformanceFailure(rec);
        assertTrue(err.getMessage().contains("span \"leaky\" link carries secret-classified attribute"),
                err.getMessage());
    }

    @Test
    void cleanSpanEventsAndLinksPass(O11yRecorder rec) {
        Attributes ok = Attributes.of(AttributeKey.stringKey("order.id"), "o-1");
        LinkData link = LinkData.create(
                SpanContext.create(TRACE_ID, SPAN_ID, TraceFlags.getSampled(), TraceState.getDefault()), ok);
        rec.spanExporter().export(List.of(spanWith(ok, List.of(EventData.create(1L, "retry", ok)), List.of(link))));
        assertDoesNotThrow(rec::assertConforms);
    }

    @Test
    void secretOnLogRecordInTheClearFails(O11yRecorder rec) {
        LogRecordData leaked = TestLogRecordData.builder()
                .setResource(rec.telemetry().resource())
                .setInstrumentationScopeInfo(InstrumentationScopeInfo.create("bridge"))
                .setTimestamp(1L, java.util.concurrent.TimeUnit.NANOSECONDS)
                .setBody("login")
                .setAttributes(secretAttrs())
                .build();
        rec.logExporter().export(List.of(leaked));
        AssertionError err = conformanceFailure(rec);
        assertTrue(err.getMessage().contains(
                "log record \"login\" carries secret-classified attribute \"" + SECRET_KEY + "\" in the clear"),
                err.getMessage());
    }

    private static MetricData sumWithExemplar(Attributes pointAttrs, Attributes exemplarAttrs) {
        DoubleExemplarData ex = ImmutableDoubleExemplarData.create(
                exemplarAttrs, 2L,
                SpanContext.create(TRACE_ID, SPAN_ID, TraceFlags.getSampled(), TraceState.getDefault()), 1.0);
        return ImmutableMetricData.createDoubleSum(
                Resource.empty(),
                InstrumentationScopeInfo.create("app"),
                "app.total",
                "",
                "1",
                ImmutableSumData.create(true, AggregationTemporality.CUMULATIVE,
                        List.of(ImmutableDoublePointData.create(1L, 2L, pointAttrs, 1.0, List.of(ex)))));
    }

    @Test
    void secretOnExemplarFilteredAttributesFails(O11yRecorder rec) {
        List<String> problems = new ArrayList<>();
        ConformanceChecks.checkMetrics(rec.telemetry().policy(),
                List.of(sumWithExemplar(Attributes.empty(), secretAttrs())), problems);
        assertEquals(1, problems.size(), problems.toString());
        assertTrue(problems.get(0).contains("exemplar"), problems.toString());
        assertTrue(problems.get(0).contains(SECRET_KEY), problems.toString());
    }

    @Test
    void piiOnExemplarFilteredAttributesFailsUnlessKept(O11yRecorder rec) {
        List<String> problems = new ArrayList<>();
        ConformanceChecks.checkMetrics(rec.telemetry().policy(),
                List.of(sumWithExemplar(Attributes.empty(), Attributes.of(AttributeKey.stringKey("device.id"), "dev-123"))),
                problems);
        assertEquals(1, problems.size(), problems.toString());
    }

    @Test
    void secretOnMetricPointFails(O11yRecorder rec) {
        List<String> problems = new ArrayList<>();
        ConformanceChecks.checkMetrics(rec.telemetry().policy(),
                List.of(sumWithExemplar(secretAttrs(), Attributes.empty())), problems);
        assertEquals(1, problems.size(), problems.toString());
        assertTrue(problems.get(0).contains("metric app.total"), problems.toString());
    }

    @Test
    void cleanExemplarPasses(O11yRecorder rec) {
        List<String> problems = new ArrayList<>();
        ConformanceChecks.checkMetrics(rec.telemetry().policy(),
                List.of(sumWithExemplar(Attributes.empty(), Attributes.of(AttributeKey.stringKey("region"), "eu"))),
                problems);
        assertEquals(List.of(), problems);
    }

    // (d) the environment allow-list includes extraEnvironments

    @Test
    void customEnvironmentFromExtraEnvironmentsPasses() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.addExtraEnvironment("perf").environment("perf"))) {
            assertDoesNotThrow(rec::assertConforms);
        }
    }

    @Test
    void invalidEnvironmentUnderLenientIdentityFails() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.strictIdentity(false).environment("mars"))) {
            AssertionError err = conformanceFailure(rec);
            assertTrue(err.getMessage().contains("identity_environment_invalid"), err.getMessage());
        }
    }

    @Test
    void missingTierZeroAttributeFails() {
        try (O11yRecorder rec = O11yRecorder.start(b -> b.strictIdentity(false).environment(""))) {
            AssertionError err = conformanceFailure(rec);
            assertTrue(err.getMessage().contains(
                    "resource missing required tier-0 attribute \"deployment.environment.name\""), err.getMessage());
        }
    }

    // (e) a flush runs first, so buffered telemetry is checked

    @Test
    void bufferedSpanIsFlushedBeforeTheChecks() {
        io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter batched =
                io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter.create();
        try (O11yRecorder rec = O11yRecorder.start(b -> b.addSpanProcessor(
                io.opentelemetry.sdk.trace.export.BatchSpanProcessor.builder(batched)
                        .setScheduleDelay(java.time.Duration.ofHours(1))
                        .build()))) {
            rec.telemetry().tracer("app").spanBuilder("op").setAttribute(SECRET_KEY, "x").startSpan().end();
            assertEquals(0, batched.getFinishedSpanItems().size());
            conformanceFailure(rec);
            assertEquals(1, batched.getFinishedSpanItems().size());
        }
    }

    @Test
    void reportsEveryProblemAtOnce(O11yRecorder rec) {
        rec.telemetry().tracer("app").spanBuilder("op").setAttribute(SECRET_KEY, "x").startSpan().end();
        rec.telemetry().event(Spec.Events.REQUEST_SUMMARY, Map.of());
        AssertionError err = conformanceFailure(rec);
        assertTrue(err.getMessage().startsWith("libo11y conformance check failed"), err.getMessage());
        assertTrue(err.getMessage().contains("on traces"), err.getMessage());
        assertTrue(err.getMessage().contains("missing required attribute"), err.getMessage());
    }
}
