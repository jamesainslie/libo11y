package ing.o11y.libo11y.spring;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ing.o11y.libo11y.O11yRecord;
import ing.o11y.libo11y.StructuredLogger;
import ing.o11y.libo11y.Telemetry;
import ing.o11y.libo11y.spec.generated.Spec;
import ing.o11y.libo11y.test.O11yRecorder;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.SpanKind;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.sdk.logs.export.SimpleLogRecordProcessor;
import io.opentelemetry.sdk.metrics.data.HistogramPointData;
import io.opentelemetry.sdk.testing.exporter.InMemoryLogRecordExporter;
import io.opentelemetry.sdk.testing.exporter.InMemoryMetricReader;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import jakarta.servlet.AsyncListener;
import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.MethodParameter;
import org.springframework.http.MediaType;
import org.springframework.http.converter.HttpMessageConverter;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.mock.web.MockAsyncContext;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.async.DeferredResult;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyAdvice;

/**
 * One asynchronous request produces one SERVER span, one duration measurement and one
 * {@code o11y.request.summary}, finished when the response completes, with the span and the
 * wide record current while the async work and the async dispatch run.
 */
@SpringBootTest(
        classes = {AsyncRequestTelemetryTest.AsyncApp.class, AsyncRequestTelemetryTest.Exporters.class},
        properties = {
            "spring.application.name=async-api",
            "libo11y.environment=test",
            "libo11y.hermetic=true",
            "libo11y.install-logback-appender=false",
            "libo11y.runtime-metrics=false",
            "libo11y.http.canonical-line=true"
        })
@AutoConfigureMockMvc
class AsyncRequestTelemetryTest {
    static final AtomicReference<DeferredResult<String>> PENDING = new AtomicReference<>();
    static final AtomicReference<String> CALLABLE_SPAN = new AtomicReference<>();

    @SpringBootApplication
    static class AsyncApp {
        @RestController
        static class AsyncController {
            @GetMapping("/async/callable")
            Callable<String> callable() {
                return () -> {
                    CALLABLE_SPAN.set(Span.current().getSpanContext().getSpanId());
                    O11yRecord record = O11yRecord.current();
                    if (record != null) {
                        record.set("callable.ran", true);
                    }
                    return "called";
                };
            }

            @GetMapping("/async/callable-error")
            Callable<String> callableError() {
                return () -> {
                    throw new IllegalStateException("callable failed");
                };
            }

            @GetMapping("/async/deferred")
            DeferredResult<String> deferred() {
                DeferredResult<String> result = new DeferredResult<>(60_000L);
                PENDING.set(result);
                return result;
            }

            @GetMapping("/async/timeout")
            DeferredResult<String> timeout() {
                return new DeferredResult<>(60_000L);
            }
        }

        /** Runs during the async dispatch, when the controller's value is written. */
        @ControllerAdvice
        static class RecordingAdvice implements ResponseBodyAdvice<Object> {
            @Override
            public boolean supports(MethodParameter returnType, Class<? extends HttpMessageConverter<?>> type) {
                return true;
            }

            @Override
            public Object beforeBodyWrite(
                    Object body,
                    MethodParameter returnType,
                    MediaType contentType,
                    Class<? extends HttpMessageConverter<?>> type,
                    ServerHttpRequest request,
                    ServerHttpResponse response) {
                O11yRecord record = O11yRecord.current();
                if (record != null) {
                    record.set("advice.span", Span.current().getSpanContext().getSpanId());
                }
                return body;
            }
        }
    }

    @Configuration
    static class Exporters {
        private final InMemorySpanExporter spans = InMemorySpanExporter.create();
        private final InMemoryMetricReader metrics = InMemoryMetricReader.create();
        private final InMemoryLogRecordExporter logs = InMemoryLogRecordExporter.create();
        private final ByteArrayOutputStream console = new ByteArrayOutputStream();
        private final List<StructuredLogger.LogEntry> entries = new CopyOnWriteArrayList<>();

        @Bean
        O11yOptionsCustomizer asyncExporters() {
            return b -> b.consoleOutput(console)
                    .addSpanProcessor(SimpleSpanProcessor.create(spans))
                    .metricReader(metrics)
                    .addLogRecordProcessor(SimpleLogRecordProcessor.create(logs))
                    .addExtraLogSink(entries::add);
        }

        @Bean
        O11yRecorder asyncRecorder(Telemetry telemetry) {
            return O11yRecorder.attach(spans, metrics, logs, console, entries, telemetry);
        }
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private O11yRecorder recorder;

    @BeforeEach
    void reset() {
        recorder.reset();
        PENDING.set(null);
        CALLABLE_SPAN.set(null);
    }

    private List<SpanData> serverSpans() {
        return recorder.spans().stream().filter(s -> s.getKind() == SpanKind.SERVER).toList();
    }

    private SpanData onlyServerSpan() {
        List<SpanData> spans = serverSpans();
        assertEquals(1, spans.size(), "server spans: " + spans);
        return spans.get(0);
    }

    private StructuredLogger.LogEntry onlySummary() {
        List<StructuredLogger.LogEntry> summaries = recorder.entries().stream()
                .filter(e -> Spec.Events.REQUEST_SUMMARY.equals(e.eventName()))
                .toList();
        assertEquals(1, summaries.size(), "summaries: " + summaries);
        return summaries.get(0);
    }

    private long durationCount(String route) {
        return recorder.metrics().stream()
                .filter(m -> "http.server.request.duration".equals(m.getName()))
                .flatMap(m -> m.getHistogramData().getPoints().stream())
                .filter(p -> route.equals(p.getAttributes().get(AttributeKey.stringKey("http.route"))))
                .mapToLong(HistogramPointData::getCount)
                .sum();
    }

    @Test
    void callableFinishesOnceWhenTheResponseCompletes() throws Exception {
        MvcResult started = mockMvc.perform(get("/async/callable"))
                .andExpect(request().asyncStarted())
                .andReturn();
        started.getAsyncResult(10_000);
        assertTrue(serverSpans().isEmpty(), "the span must stay open until the response completes");

        mockMvc.perform(asyncDispatch(started))
                .andExpect(status().isOk())
                .andExpect(content().string("called"));

        SpanData span = onlyServerSpan();
        assertEquals("GET /async/callable", span.getName());
        assertEquals(200L, span.getAttributes().get(AttributeKey.longKey("http.response.status_code")));
        assertEquals(span.getSpanId(), CALLABLE_SPAN.get(), "the Callable must run inside the server span");
        assertEquals(1, durationCount("/async/callable"));

        StructuredLogger.LogEntry summary = onlySummary();
        assertEquals(span.getTraceId(), summary.traceId());
        assertEquals(true, summary.attributes().get("callable.ran"));
        assertEquals(span.getSpanId(), summary.attributes().get("advice.span"));
        assertEquals(200L, summary.attributes().get("http.response.status_code"));
        assertEquals(Spec.Outcome.SUCCESS, summary.attributes().get(Spec.Attributes.OUTCOME));
    }

    @Test
    void deferredResultFinishesOnceWithTheFinalStatus() throws Exception {
        MvcResult started = mockMvc.perform(get("/async/deferred"))
                .andExpect(request().asyncStarted())
                .andReturn();
        assertTrue(serverSpans().isEmpty());
        DeferredResult<String> pending = PENDING.get();
        assertNotNull(pending);
        Thread producer = new Thread(() -> pending.setResult("deferred"));
        producer.start();
        producer.join(10_000);

        mockMvc.perform(asyncDispatch(started))
                .andExpect(status().isOk())
                .andExpect(content().string("deferred"));

        SpanData span = onlyServerSpan();
        assertEquals("GET /async/deferred", span.getName());
        assertEquals(1, durationCount("/async/deferred"));
        StructuredLogger.LogEntry summary = onlySummary();
        assertEquals(span.getSpanId(), summary.attributes().get("advice.span"));
        assertEquals(Spec.Outcome.SUCCESS, summary.attributes().get(Spec.Attributes.OUTCOME));
    }

    @Test
    void callableFailureFinishesOnceAsAFailure() throws Exception {
        MvcResult started = mockMvc.perform(get("/async/callable-error"))
                .andExpect(request().asyncStarted())
                .andReturn();
        started.getAsyncResult(10_000);
        assertThrows(Exception.class, () -> mockMvc.perform(asyncDispatch(started)));

        SpanData span = onlyServerSpan();
        assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
        assertEquals(500L, span.getAttributes().get(AttributeKey.longKey("http.response.status_code")));
        assertNotNull(span.getAttributes().get(AttributeKey.stringKey("error.type")));
        assertEquals(1, durationCount("/async/callable-error"));
        assertEquals(Spec.Outcome.FAILURE, onlySummary().attributes().get(Spec.Attributes.OUTCOME));
    }

    @Test
    void timeoutFinishesOnceWithTheTimeoutStatus() throws Exception {
        MvcResult started = mockMvc.perform(get("/async/timeout"))
                .andExpect(request().asyncStarted())
                .andReturn();
        MockAsyncContext asyncContext = (MockAsyncContext) started.getRequest().getAsyncContext();
        assertNotNull(asyncContext);
        for (AsyncListener listener : List.copyOf(asyncContext.getListeners())) {
            listener.onTimeout(null);
        }
        assertTrue(serverSpans().isEmpty());

        mockMvc.perform(asyncDispatch(started)).andExpect(status().isServiceUnavailable());

        SpanData span = onlyServerSpan();
        assertEquals(503L, span.getAttributes().get(AttributeKey.longKey("http.response.status_code")));
        assertEquals("503", span.getAttributes().get(AttributeKey.stringKey("error.type")));
        assertEquals(StatusCode.ERROR, span.getStatus().getStatusCode());
        assertEquals(1, durationCount("/async/timeout"));
        assertEquals(Spec.Outcome.FAILURE, onlySummary().attributes().get(Spec.Attributes.OUTCOME));
    }
}
