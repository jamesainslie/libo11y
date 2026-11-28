package ing.o11y.libo11y.micrometer;

import ing.o11y.libo11y.Telemetry;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.observation.DefaultMeterObservationHandler;
import io.micrometer.observation.ObservationHandler;
import io.micrometer.observation.ObservationRegistry;
import io.micrometer.tracing.CurrentTraceContext;
import io.micrometer.tracing.Span;
import io.micrometer.tracing.Tracer;
import io.micrometer.tracing.handler.DefaultTracingObservationHandler;
import io.micrometer.tracing.handler.PropagatingReceiverTracingObservationHandler;
import io.micrometer.tracing.handler.PropagatingSenderTracingObservationHandler;
import io.micrometer.tracing.handler.TracingObservationHandler;
import io.micrometer.tracing.otel.bridge.OtelBaggageManager;
import io.micrometer.tracing.otel.bridge.OtelCurrentTraceContext;
import io.micrometer.tracing.otel.bridge.OtelPropagator;
import io.micrometer.tracing.otel.bridge.OtelSpan;
import io.micrometer.tracing.otel.bridge.OtelTracer;
import io.micrometer.tracing.propagation.Propagator;
import io.opentelemetry.context.Scope;
import java.util.Collections;
import java.util.List;

/**
 * Wires Micrometer Tracing ({@link Tracer}, {@link CurrentTraceContext}, {@link Propagator})
 * and {@link ObservationRegistry} handlers directly to a single {@link Telemetry} handle.
 */
public final class O11yMicrometerTracing {
    private final CurrentTraceContext currentTraceContext;
    private final OtelBaggageManager baggageManager;
    private final Tracer tracer;
    private final Propagator propagator;

    private O11yMicrometerTracing(
            CurrentTraceContext currentTraceContext,
            OtelBaggageManager baggageManager,
            Tracer tracer,
            Propagator propagator) {
        this.currentTraceContext = currentTraceContext;
        this.baggageManager = baggageManager;
        this.tracer = tracer;
        this.propagator = propagator;
    }

    public static O11yMicrometerTracing create(Telemetry telemetry) {
        return create(telemetry, List.of(), List.of());
    }

    public static O11yMicrometerTracing create(
            Telemetry telemetry,
            List<String> remoteFields,
            List<String> tagFields) {
        OtelCurrentTraceContext currentTraceContext = new OtelCurrentTraceContext();
        OtelBaggageManager baggageManager = new OtelBaggageManager(
                currentTraceContext,
                remoteFields == null ? Collections.emptyList() : remoteFields,
                tagFields == null ? Collections.emptyList() : tagFields);
        io.opentelemetry.api.trace.Tracer otelTracer = telemetry.tracer("libo11y.micrometer.tracing");
        OtelTracer tracer = new OtelTracer(otelTracer, currentTraceContext, event -> {}, baggageManager);
        OtelPropagator propagator = new OtelPropagator(telemetry.propagators(), otelTracer);
        return new O11yMicrometerTracing(currentTraceContext, baggageManager, tracer, propagator);
    }

    public CurrentTraceContext currentTraceContext() {
        return currentTraceContext;
    }

    public OtelBaggageManager baggageManager() {
        return baggageManager;
    }

    public Tracer tracer() {
        return tracer;
    }

    public Propagator propagator() {
        return propagator;
    }

    /**
     * Configures an {@link ObservationRegistry} with libo11y's unified tracing, meter (with exemplars),
     * and wide-event observation handlers in the canonical Micrometer order.
     */
    public ObservationRegistry configureObservationRegistry(
            ObservationRegistry registry,
            Telemetry telemetry,
            MeterRegistry meterRegistry,
            boolean emitStandaloneEvent) {
        DefaultMeterObservationHandler meterHandler = new ExemplarPreservingMeterObservationHandler(meterRegistry);
        registry.observationConfig()
                .observationHandler(new ObservationHandler.FirstMatchingCompositeObservationHandler(
                        new PropagatingSenderTracingObservationHandler<>(tracer, propagator),
                        new PropagatingReceiverTracingObservationHandler<>(tracer, propagator),
                        new DefaultTracingObservationHandler(tracer)))
                .observationHandler(meterHandler)
                .observationHandler(new O11yObservationHandler(telemetry, emitStandaloneEvent));
        return registry;
    }

    /**
     * Micrometer closes observation scopes before invoking {@code onStop}, which would otherwise
     * strip the active OTel span before {@link DefaultMeterObservationHandler} records the timer.
     * Restoring the observation's OTel span during {@code onStop} ensures trace exemplars attach.
     */
    private static final class ExemplarPreservingMeterObservationHandler extends DefaultMeterObservationHandler {
        @SuppressWarnings("deprecation")
        ExemplarPreservingMeterObservationHandler(MeterRegistry meterRegistry) {
            super(meterRegistry);
        }

        @Override
        public void onStop(io.micrometer.observation.Observation.Context context) {
            TracingObservationHandler.TracingContext tc =
                    context.get(TracingObservationHandler.TracingContext.class);
            Span span = tc != null ? tc.getSpan() : null;
            if (span != null) {
                io.opentelemetry.api.trace.Span otelSpan = OtelSpan.toOtel(span);
                if (otelSpan != null) {
                    try (Scope ignored = otelSpan.makeCurrent()) {
                        super.onStop(context);
                        return;
                    }
                }
            }
            super.onStop(context);
        }
    }
}
