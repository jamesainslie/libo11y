package ing.o11y.libo11y.internal;

import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.BatchCallback;
import io.opentelemetry.api.metrics.DoubleCounter;
import io.opentelemetry.api.metrics.DoubleCounterBuilder;
import io.opentelemetry.api.metrics.DoubleGauge;
import io.opentelemetry.api.metrics.DoubleGaugeBuilder;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.metrics.DoubleHistogramBuilder;
import io.opentelemetry.api.metrics.DoubleUpDownCounter;
import io.opentelemetry.api.metrics.DoubleUpDownCounterBuilder;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.LongCounterBuilder;
import io.opentelemetry.api.metrics.LongGauge;
import io.opentelemetry.api.metrics.LongGaugeBuilder;
import io.opentelemetry.api.metrics.LongHistogram;
import io.opentelemetry.api.metrics.LongHistogramBuilder;
import io.opentelemetry.api.metrics.LongUpDownCounter;
import io.opentelemetry.api.metrics.LongUpDownCounterBuilder;
import io.opentelemetry.api.metrics.Meter;
import io.opentelemetry.api.metrics.MeterBuilder;
import io.opentelemetry.api.metrics.MeterProvider;
import io.opentelemetry.api.metrics.ObservableDoubleCounter;
import io.opentelemetry.api.metrics.ObservableDoubleGauge;
import io.opentelemetry.api.metrics.ObservableDoubleMeasurement;
import io.opentelemetry.api.metrics.ObservableDoubleUpDownCounter;
import io.opentelemetry.api.metrics.ObservableLongCounter;
import io.opentelemetry.api.metrics.ObservableLongGauge;
import io.opentelemetry.api.metrics.ObservableLongMeasurement;
import io.opentelemetry.api.metrics.ObservableLongUpDownCounter;
import io.opentelemetry.api.metrics.ObservableMeasurement;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.ContextKey;
import io.opentelemetry.sdk.common.CompletableResultCode;
import io.opentelemetry.sdk.logs.LogRecordProcessor;
import io.opentelemetry.sdk.logs.ReadWriteLogRecord;
import io.opentelemetry.sdk.trace.ReadWriteSpan;
import io.opentelemetry.sdk.trace.ReadableSpan;
import io.opentelemetry.sdk.trace.SpanProcessor;
import io.opentelemetry.sdk.trace.data.DelegatingSpanData;
import io.opentelemetry.sdk.trace.data.EventData;
import io.opentelemetry.sdk.trace.data.LinkData;
import io.opentelemetry.sdk.trace.data.SpanData;
import io.opentelemetry.sdk.trace.export.SpanExporter;
import com.sun.management.GarbageCollectionNotificationInfo;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.lang.management.MemoryUsage;
import java.lang.management.ThreadMXBean;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.UnaryOperator;
import javax.management.ListenerNotFoundException;
import javax.management.NotificationEmitter;
import javax.management.NotificationListener;
import javax.management.openmbean.CompositeData;

/** Sensitivity-enforcing bridges for traces, logs, metrics, plus zero-dependency JVM runtime metrics. */
public final class PolicyBridges {
    private PolicyBridges() {}

    // ---------------- Trace redaction ----------------

    public static SpanData redactSpanData(SpanData raw, SensitivityPolicy policy) {
        Attributes redactedAttrs = policy.classifyAttributes(raw.getAttributes(), Spec.Signal.TRACES, true);

        List<EventData> rawEvents = raw.getEvents();
        List<EventData> redactedEvents = new ArrayList<>(rawEvents.size());
        for (EventData ev : rawEvents) {
            Attributes evAttrs = policy.classifyAttributes(ev.getAttributes(), Spec.Signal.TRACES, true);
            redactedEvents.add(EventData.create(ev.getEpochNanos(), ev.getName(), evAttrs, ev.getTotalAttributeCount()));
        }

        List<LinkData> rawLinks = raw.getLinks();
        List<LinkData> redactedLinks = new ArrayList<>(rawLinks.size());
        for (LinkData link : rawLinks) {
            Attributes linkAttrs = policy.classifyAttributes(link.getAttributes(), Spec.Signal.TRACES, true);
            redactedLinks.add(LinkData.create(link.getSpanContext(), linkAttrs, link.getTotalAttributeCount()));
        }

        return new DelegatingSpanData(raw) {
            @Override
            public Attributes getAttributes() {
                return redactedAttrs;
            }

            @Override
            public List<EventData> getEvents() {
                return redactedEvents;
            }

            @Override
            public List<LinkData> getLinks() {
                return redactedLinks;
            }
        };
    }

    public static final class PolicySpanExporter implements SpanExporter {
        private final SpanExporter delegate;
        private final SensitivityPolicy policy;

        public PolicySpanExporter(SpanExporter delegate, SensitivityPolicy policy) {
            this.delegate = delegate;
            this.policy = policy;
        }

        @Override
        public CompletableResultCode export(Collection<SpanData> spans) {
            List<SpanData> clean = new ArrayList<>(spans.size());
            for (SpanData s : spans) {
                clean.add(redactSpanData(s, policy));
            }
            return delegate.export(clean);
        }

        @Override
        public CompletableResultCode flush() {
            return delegate.flush();
        }

        @Override
        public CompletableResultCode shutdown() {
            return delegate.shutdown();
        }
    }

    /** Wraps an injected SpanProcessor so onEnd receives redacted SpanData while onStart sees live spans. */
    public static final class PolicySpanProcessor implements SpanProcessor {
        private final SpanProcessor delegate;
        private final SensitivityPolicy policy;

        public PolicySpanProcessor(SpanProcessor delegate, SensitivityPolicy policy) {
            this.delegate = delegate;
            this.policy = policy;
        }

        @Override
        public void onStart(Context parentContext, ReadWriteSpan span) {
            delegate.onStart(parentContext, span);
        }

        @Override
        public boolean isStartRequired() {
            return delegate.isStartRequired();
        }

        @Override
        public void onEnd(ReadableSpan span) {
            SpanData clean = redactSpanData(span.toSpanData(), policy);
            delegate.onEnd(new RedactedReadableSpan(span, clean));
        }

        @Override
        public boolean isEndRequired() {
            return delegate.isEndRequired();
        }

        @Override
        public CompletableResultCode shutdown() {
            return delegate.shutdown();
        }

        @Override
        public CompletableResultCode forceFlush() {
            return delegate.forceFlush();
        }
    }

    private static final class RedactedReadableSpan implements ReadableSpan {
        private final ReadableSpan delegate;
        private final SpanData clean;

        RedactedReadableSpan(ReadableSpan delegate, SpanData clean) {
            this.delegate = delegate;
            this.clean = clean;
        }

        @Override
        public io.opentelemetry.api.trace.SpanContext getSpanContext() {
            return delegate.getSpanContext();
        }

        @Override
        public io.opentelemetry.api.trace.SpanContext getParentSpanContext() {
            return delegate.getParentSpanContext();
        }

        @Override
        public String getName() {
            return delegate.getName();
        }

        @Override
        public SpanData toSpanData() {
            return clean;
        }

        @Override
        @SuppressWarnings("deprecation")
        public io.opentelemetry.sdk.common.InstrumentationLibraryInfo getInstrumentationLibraryInfo() {
            return delegate.getInstrumentationLibraryInfo();
        }

        @Override
        public io.opentelemetry.sdk.common.InstrumentationScopeInfo getInstrumentationScopeInfo() {
            return delegate.getInstrumentationScopeInfo();
        }

        @Override
        public boolean hasEnded() {
            return delegate.hasEnded();
        }

        @Override
        public long getLatencyNanos() {
            return delegate.getLatencyNanos();
        }

        @Override
        public io.opentelemetry.api.trace.SpanKind getKind() {
            return delegate.getKind();
        }

        @Override
        public <T> T getAttribute(AttributeKey<T> key) {
            return clean.getAttributes().get(key);
        }

        @Override
        public Attributes getAttributes() {
            return clean.getAttributes();
        }
    }

    // ---------------- Log redaction ----------------

    /**
     * Enforces the sensitivity policy on every record the SDK's logger provider emits, whichever
     * bridge produced it. libo11y registers one instance in front of all of its log processors, so
     * each record is classified, and each violation counted, exactly once. The SDK's record cannot
     * remove an attribute, so the delegate receives a view whose reads return the classified
     * attributes; a record with nothing classified is passed through untouched. Records from
     * libo11y's own {@code StructuredLogger} are already classified (see {@link #classifiedMark})
     * and pass through, so their tokens match the console's. The record body is not classified.
     */
    public static final class PolicyLogRecordProcessor implements LogRecordProcessor {
        /** This instance's mark. Context keys compare by identity, so no other code can recreate it. */
        private final ContextKey<Boolean> classifiedKey = ContextKey.named("libo11y.log.classified");

        private final SensitivityPolicy policy;
        private final LogRecordProcessor delegate;

        public PolicyLogRecordProcessor(SensitivityPolicy policy, LogRecordProcessor delegate) {
            this.policy = policy;
            this.delegate = delegate;
        }

        /**
         * Returns the operation that marks a context as carrying a record libo11y's structured logger
         * has already classified, so this processor does not classify it again. The mark belongs to
         * this instance: only the code its owner hands the operation to can set it, and the mark is
         * cleared before a delegate sees the context, so a context captured downstream carries none.
         */
        public UnaryOperator<Context> classifiedMark() {
            return context -> context.with(classifiedKey, Boolean.TRUE);
        }

        @Override
        public void onEmit(Context context, ReadWriteLogRecord logRecord) {
            if (delegate == null) {
                return;
            }
            if (context != null && Boolean.TRUE.equals(context.get(classifiedKey))) {
                delegate.onEmit(context.with(classifiedKey, Boolean.FALSE), logRecord);
                return;
            }
            Attributes clean = LogAttributeClassifier.classify(logRecord.getAttributes(), policy);
            delegate.onEmit(context, clean == null ? logRecord : new ClassifiedLogRecord(logRecord, policy, clean));
        }

        @Override
        public CompletableResultCode shutdown() {
            return delegate != null ? delegate.shutdown() : CompletableResultCode.ofSuccess();
        }

        @Override
        public CompletableResultCode forceFlush() {
            return delegate != null ? delegate.forceFlush() : CompletableResultCode.ofSuccess();
        }
    }

    // ---------------- Metric classification ----------------

    public static final class PolicyMeterProvider implements MeterProvider {
        private final MeterProvider delegate;
        private final SensitivityPolicy policy;

        public PolicyMeterProvider(MeterProvider delegate, SensitivityPolicy policy) {
            this.delegate = delegate;
            this.policy = policy;
        }

        @Override
        public MeterBuilder meterBuilder(String instrumentationScopeName) {
            MeterBuilder inner = delegate.meterBuilder(instrumentationScopeName);
            return new MeterBuilder() {
                @Override
                public MeterBuilder setSchemaUrl(String schemaUrl) {
                    inner.setSchemaUrl(schemaUrl);
                    return this;
                }

                @Override
                public MeterBuilder setInstrumentationVersion(String instrumentationScopeVersion) {
                    inner.setInstrumentationVersion(instrumentationScopeVersion);
                    return this;
                }

                @Override
                public Meter build() {
                    return new PolicyMeter(inner.build(), policy);
                }
            };
        }
    }

    /** An observer that classifies attributes before recording into the SDK's observer. */
    private static final class PolicyLongObserver implements ObservableLongMeasurement {
        private final ObservableLongMeasurement delegate;
        private final SensitivityPolicy policy;

        PolicyLongObserver(ObservableLongMeasurement delegate, SensitivityPolicy policy) {
            this.delegate = delegate;
            this.policy = policy;
        }

        @Override
        public void record(long value) {
            delegate.record(value);
        }

        @Override
        public void record(long value, Attributes attributes) {
            delegate.record(value, policy.classifyMetricAttributes(attributes));
        }
    }

    /** An observer that classifies attributes before recording into the SDK's observer. */
    private static final class PolicyDoubleObserver implements ObservableDoubleMeasurement {
        private final ObservableDoubleMeasurement delegate;
        private final SensitivityPolicy policy;

        PolicyDoubleObserver(ObservableDoubleMeasurement delegate, SensitivityPolicy policy) {
            this.delegate = delegate;
            this.policy = policy;
        }

        @Override
        public void record(double value) {
            delegate.record(value);
        }

        @Override
        public void record(double value, Attributes attributes) {
            delegate.record(value, policy.classifyMetricAttributes(attributes));
        }
    }

    private static final class PolicyMeter implements Meter {
        private final Meter delegate;
        private final SensitivityPolicy policy;

        PolicyMeter(Meter delegate, SensitivityPolicy policy) {
            this.delegate = delegate;
            this.policy = policy;
        }

        private Consumer<ObservableLongMeasurement> wrapLongCallback(Consumer<ObservableLongMeasurement> cb) {
            return measurement -> cb.accept(new PolicyLongObserver(measurement, policy));
        }

        private Consumer<ObservableDoubleMeasurement> wrapDoubleCallback(Consumer<ObservableDoubleMeasurement> cb) {
            return measurement -> cb.accept(new PolicyDoubleObserver(measurement, policy));
        }

        /**
         * Registers a callback that observes several instruments at once. The observers this meter's
         * {@code buildObserver()} returns wrap the SDK's own, so they are unwrapped for the SDK, while
         * the callback keeps recording through the wrappers and so through the policy.
         */
        @Override
        public BatchCallback batchCallback(
                Runnable callback,
                ObservableMeasurement observableMeasurement,
                ObservableMeasurement... additionalMeasurements) {
            ObservableMeasurement[] rest = new ObservableMeasurement[additionalMeasurements.length];
            for (int i = 0; i < rest.length; i++) {
                rest[i] = unwrap(additionalMeasurements[i]);
            }
            return delegate.batchCallback(callback, unwrap(observableMeasurement), rest);
        }

        private static ObservableMeasurement unwrap(ObservableMeasurement m) {
            if (m instanceof PolicyLongObserver o) {
                return o.delegate;
            }
            if (m instanceof PolicyDoubleObserver o) {
                return o.delegate;
            }
            return m;
        }

        @Override
        public LongCounterBuilder counterBuilder(String name) {
            LongCounterBuilder b = delegate.counterBuilder(name);
            return new LongCounterBuilder() {
                @Override
                public LongCounterBuilder setDescription(String description) {
                    b.setDescription(description);
                    return this;
                }

                @Override
                public LongCounterBuilder setUnit(String unit) {
                    b.setUnit(unit);
                    return this;
                }

                @Override
                public DoubleCounterBuilder ofDoubles() {
                    DoubleCounterBuilder db = b.ofDoubles();
                    return new DoubleCounterBuilder() {
                        @Override
                        public DoubleCounterBuilder setDescription(String description) {
                            db.setDescription(description);
                            return this;
                        }

                        @Override
                        public DoubleCounterBuilder setUnit(String unit) {
                            db.setUnit(unit);
                            return this;
                        }

                        @Override
                        public DoubleCounter build() {
                            DoubleCounter c = db.build();
                            return new DoubleCounter() {
                                @Override
                                public void add(double value) {
                                    c.add(value);
                                }

                                @Override
                                public void add(double value, Attributes attributes) {
                                    c.add(value, policy.classifyMetricAttributes(attributes));
                                }

                                @Override
                                public void add(double value, Attributes attributes, Context context) {
                                    c.add(value, policy.classifyMetricAttributes(attributes), context);
                                }
                            };
                        }

                        @Override
                        public ObservableDoubleCounter buildWithCallback(Consumer<ObservableDoubleMeasurement> callback) {
                            return db.buildWithCallback(wrapDoubleCallback(callback));
                        }

                        @Override
                        public ObservableDoubleMeasurement buildObserver() {
                            return new PolicyDoubleObserver(db.buildObserver(), policy);
                        }
                    };
                }

                @Override
                public LongCounter build() {
                    LongCounter c = b.build();
                    return new LongCounter() {
                        @Override
                        public void add(long value) {
                            c.add(value);
                        }

                        @Override
                        public void add(long value, Attributes attributes) {
                            c.add(value, policy.classifyMetricAttributes(attributes));
                        }

                        @Override
                        public void add(long value, Attributes attributes, Context context) {
                            c.add(value, policy.classifyMetricAttributes(attributes), context);
                        }
                    };
                }

                @Override
                public ObservableLongCounter buildWithCallback(Consumer<ObservableLongMeasurement> callback) {
                    return b.buildWithCallback(wrapLongCallback(callback));
                }

                @Override
                public ObservableLongMeasurement buildObserver() {
                    return new PolicyLongObserver(b.buildObserver(), policy);
                }
            };
        }

        @Override
        public LongUpDownCounterBuilder upDownCounterBuilder(String name) {
            LongUpDownCounterBuilder b = delegate.upDownCounterBuilder(name);
            return new LongUpDownCounterBuilder() {
                @Override
                public LongUpDownCounterBuilder setDescription(String description) {
                    b.setDescription(description);
                    return this;
                }

                @Override
                public LongUpDownCounterBuilder setUnit(String unit) {
                    b.setUnit(unit);
                    return this;
                }

                @Override
                public DoubleUpDownCounterBuilder ofDoubles() {
                    DoubleUpDownCounterBuilder db = b.ofDoubles();
                    return new DoubleUpDownCounterBuilder() {
                        @Override
                        public DoubleUpDownCounterBuilder setDescription(String description) {
                            db.setDescription(description);
                            return this;
                        }

                        @Override
                        public DoubleUpDownCounterBuilder setUnit(String unit) {
                            db.setUnit(unit);
                            return this;
                        }

                        @Override
                        public DoubleUpDownCounter build() {
                            DoubleUpDownCounter c = db.build();
                            return new DoubleUpDownCounter() {
                                @Override
                                public void add(double value) {
                                    c.add(value);
                                }

                                @Override
                                public void add(double value, Attributes attributes) {
                                    c.add(value, policy.classifyMetricAttributes(attributes));
                                }

                                @Override
                                public void add(double value, Attributes attributes, Context context) {
                                    c.add(value, policy.classifyMetricAttributes(attributes), context);
                                }
                            };
                        }

                        @Override
                        public ObservableDoubleUpDownCounter buildWithCallback(Consumer<ObservableDoubleMeasurement> callback) {
                            return db.buildWithCallback(wrapDoubleCallback(callback));
                        }

                        @Override
                        public ObservableDoubleMeasurement buildObserver() {
                            return new PolicyDoubleObserver(db.buildObserver(), policy);
                        }
                    };
                }

                @Override
                public LongUpDownCounter build() {
                    LongUpDownCounter c = b.build();
                    return new LongUpDownCounter() {
                        @Override
                        public void add(long value) {
                            c.add(value);
                        }

                        @Override
                        public void add(long value, Attributes attributes) {
                            c.add(value, policy.classifyMetricAttributes(attributes));
                        }

                        @Override
                        public void add(long value, Attributes attributes, Context context) {
                            c.add(value, policy.classifyMetricAttributes(attributes), context);
                        }
                    };
                }

                @Override
                public ObservableLongUpDownCounter buildWithCallback(Consumer<ObservableLongMeasurement> callback) {
                    return b.buildWithCallback(wrapLongCallback(callback));
                }

                @Override
                public ObservableLongMeasurement buildObserver() {
                    return new PolicyLongObserver(b.buildObserver(), policy);
                }
            };
        }

        @Override
        public DoubleHistogramBuilder histogramBuilder(String name) {
            DoubleHistogramBuilder b = delegate.histogramBuilder(name);
            return new DoubleHistogramBuilder() {
                @Override
                public DoubleHistogramBuilder setDescription(String description) {
                    b.setDescription(description);
                    return this;
                }

                @Override
                public DoubleHistogramBuilder setUnit(String unit) {
                    b.setUnit(unit);
                    return this;
                }

                @Override
                public DoubleHistogramBuilder setExplicitBucketBoundariesAdvice(List<Double> bucketBoundaries) {
                    b.setExplicitBucketBoundariesAdvice(bucketBoundaries);
                    return this;
                }

                @Override
                public LongHistogramBuilder ofLongs() {
                    LongHistogramBuilder lb = b.ofLongs();
                    return new LongHistogramBuilder() {
                        @Override
                        public LongHistogramBuilder setDescription(String description) {
                            lb.setDescription(description);
                            return this;
                        }

                        @Override
                        public LongHistogramBuilder setUnit(String unit) {
                            lb.setUnit(unit);
                            return this;
                        }

                        @Override
                        public LongHistogramBuilder setExplicitBucketBoundariesAdvice(List<Long> bucketBoundaries) {
                            lb.setExplicitBucketBoundariesAdvice(bucketBoundaries);
                            return this;
                        }

                        @Override
                        public LongHistogram build() {
                            LongHistogram h = lb.build();
                            return new LongHistogram() {
                                @Override
                                public void record(long value) {
                                    h.record(value);
                                }

                                @Override
                                public void record(long value, Attributes attributes) {
                                    h.record(value, policy.classifyMetricAttributes(attributes));
                                }

                                @Override
                                public void record(long value, Attributes attributes, Context context) {
                                    h.record(value, policy.classifyMetricAttributes(attributes), context);
                                }
                            };
                        }
                    };
                }

                @Override
                public DoubleHistogram build() {
                    DoubleHistogram h = b.build();
                    return new DoubleHistogram() {
                        @Override
                        public void record(double value) {
                            h.record(value);
                        }

                        @Override
                        public void record(double value, Attributes attributes) {
                            h.record(value, policy.classifyMetricAttributes(attributes));
                        }

                        @Override
                        public void record(double value, Attributes attributes, Context context) {
                            h.record(value, policy.classifyMetricAttributes(attributes), context);
                        }
                    };
                }
            };
        }

        @Override
        public DoubleGaugeBuilder gaugeBuilder(String name) {
            DoubleGaugeBuilder b = delegate.gaugeBuilder(name);
            return new DoubleGaugeBuilder() {
                @Override
                public DoubleGaugeBuilder setDescription(String description) {
                    b.setDescription(description);
                    return this;
                }

                @Override
                public DoubleGaugeBuilder setUnit(String unit) {
                    b.setUnit(unit);
                    return this;
                }

                @Override
                public LongGaugeBuilder ofLongs() {
                    LongGaugeBuilder lb = b.ofLongs();
                    return new LongGaugeBuilder() {
                        @Override
                        public LongGaugeBuilder setDescription(String description) {
                            lb.setDescription(description);
                            return this;
                        }

                        @Override
                        public LongGaugeBuilder setUnit(String unit) {
                            lb.setUnit(unit);
                            return this;
                        }

                        @Override
                        public LongGauge build() {
                            LongGauge g = lb.build();
                            return new LongGauge() {
                                @Override
                                public void set(long value) {
                                    g.set(value);
                                }

                                @Override
                                public void set(long value, Attributes attributes) {
                                    g.set(value, policy.classifyMetricAttributes(attributes));
                                }

                                @Override
                                public void set(long value, Attributes attributes, Context context) {
                                    g.set(value, policy.classifyMetricAttributes(attributes), context);
                                }
                            };
                        }

                        @Override
                        public ObservableLongGauge buildWithCallback(Consumer<ObservableLongMeasurement> callback) {
                            return lb.buildWithCallback(wrapLongCallback(callback));
                        }

                        @Override
                        public ObservableLongMeasurement buildObserver() {
                            return new PolicyLongObserver(lb.buildObserver(), policy);
                        }
                    };
                }

                @Override
                public DoubleGauge build() {
                    DoubleGauge g = b.build();
                    return new DoubleGauge() {
                        @Override
                        public void set(double value) {
                            g.set(value);
                        }

                        @Override
                        public void set(double value, Attributes attributes) {
                            g.set(value, policy.classifyMetricAttributes(attributes));
                        }

                        @Override
                        public void set(double value, Attributes attributes, Context context) {
                            g.set(value, policy.classifyMetricAttributes(attributes), context);
                        }
                    };
                }

                @Override
                public ObservableDoubleGauge buildWithCallback(Consumer<ObservableDoubleMeasurement> callback) {
                    return b.buildWithCallback(wrapDoubleCallback(callback));
                }

                @Override
                public ObservableDoubleMeasurement buildObserver() {
                    return new PolicyDoubleObserver(b.buildObserver(), policy);
                }
            };
        }
    }

    // ---------------- Zero-dependency JVM runtime metrics ----------------

    /**
     * Records {@code jvm.gc.duration} (semantic conventions 1.41.0): a histogram of the duration of
     * each garbage collection, from the platform's GC notifications, with {@code jvm.gc.name} and
     * {@code jvm.gc.action}. Kept apart so a runtime without {@code com.sun.management} never loads
     * it.
     */
    private static final class GcNotifications {
        private static final AttributeKey<String> GC_NAME = AttributeKey.stringKey("jvm.gc.name");
        private static final AttributeKey<String> GC_ACTION = AttributeKey.stringKey("jvm.gc.action");
        private static final List<Double> BUCKETS = List.of(0.01, 0.1, 1.0, 10.0);

        private GcNotifications() {}

        static boolean available() {
            try {
                Class.forName(
                        "com.sun.management.GarbageCollectionNotificationInfo",
                        false,
                        GcNotifications.class.getClassLoader());
                return true;
            } catch (ClassNotFoundException ex) {
                return false;
            }
        }

        static List<Registration> register(Meter meter) {
            DoubleHistogram duration = meter.histogramBuilder("jvm.gc.duration")
                    .setDescription("Duration of JVM garbage collection actions.")
                    .setUnit("s")
                    .setExplicitBucketBoundariesAdvice(BUCKETS)
                    .build();
            List<Registration> registrations = new ArrayList<>();
            for (GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
                if (!(gc instanceof NotificationEmitter emitter)) {
                    continue;
                }
                NotificationListener listener = (notification, handback) -> {
                    if (!GarbageCollectionNotificationInfo.GARBAGE_COLLECTION_NOTIFICATION.equals(notification.getType())
                            || !(notification.getUserData() instanceof CompositeData data)) {
                        return;
                    }
                    GarbageCollectionNotificationInfo info = GarbageCollectionNotificationInfo.from(data);
                    duration.record(
                            info.getGcInfo().getDuration() / (double) TimeUnit.SECONDS.toMillis(1),
                            Attributes.of(GC_NAME, info.getGcName(), GC_ACTION, info.getGcAction()));
                };
                emitter.addNotificationListener(listener, null, null);
                registrations.add(() -> emitter.removeNotificationListener(listener));
            }
            return registrations;
        }
    }

    /** One thing the runtime metrics registered; only removing a GC listener declares a checked exception. */
    @FunctionalInterface
    private interface Registration {
        void close() throws ListenerNotFoundException;
    }

    public static final class JvmRuntimeMetrics implements AutoCloseable {
        private static final AttributeKey<String> MEMORY_TYPE = AttributeKey.stringKey("jvm.memory.type");
        private static final AttributeKey<String> POOL_NAME = AttributeKey.stringKey("jvm.memory.pool.name");
        private static final AttributeKey<Boolean> THREAD_DAEMON = AttributeKey.booleanKey("jvm.thread.daemon");

        private final List<Registration> registrations = new ArrayList<>();

        public static JvmRuntimeMetrics register(Meter meter) {
            JvmRuntimeMetrics metrics = new JvmRuntimeMetrics();
            List<MemoryPoolMXBean> pools = ManagementFactory.getMemoryPoolMXBeans();

            metrics.registrations.add(meter.upDownCounterBuilder("jvm.memory.used")
                    .setDescription("Measure of memory used.")
                    .setUnit("By")
                    .buildWithCallback(m -> {
                        for (MemoryPoolMXBean pool : pools) {
                            MemoryUsage usage = pool.getUsage();
                            if (usage != null && usage.getUsed() >= 0) {
                                String type = pool.getType() == MemoryType.HEAP ? "heap" : "non_heap";
                                m.record(usage.getUsed(), Attributes.of(MEMORY_TYPE, type, POOL_NAME, pool.getName()));
                            }
                        }
                    })::close);

            metrics.registrations.add(meter.upDownCounterBuilder("jvm.memory.committed")
                    .setDescription("Measure of memory committed.")
                    .setUnit("By")
                    .buildWithCallback(m -> {
                        for (MemoryPoolMXBean pool : pools) {
                            MemoryUsage usage = pool.getUsage();
                            if (usage != null && usage.getCommitted() >= 0) {
                                String type = pool.getType() == MemoryType.HEAP ? "heap" : "non_heap";
                                m.record(usage.getCommitted(), Attributes.of(MEMORY_TYPE, type, POOL_NAME, pool.getName()));
                            }
                        }
                    })::close);

            ThreadMXBean threads = ManagementFactory.getThreadMXBean();
            metrics.registrations.add(meter.upDownCounterBuilder("jvm.thread.count")
                    .setDescription("Number of executing platform threads.")
                    .setUnit("{thread}")
                    .buildWithCallback(m -> {
                        int daemon = threads.getDaemonThreadCount();
                        int nonDaemon = Math.max(0, threads.getThreadCount() - daemon);
                        m.record(daemon, Attributes.of(THREAD_DAEMON, true));
                        m.record(nonDaemon, Attributes.of(THREAD_DAEMON, false));
                    })::close);

            if (GcNotifications.available()) {
                metrics.registrations.addAll(GcNotifications.register(meter));
            }

            return metrics;
        }

        /**
         * Closes every registration, even after one fails, then throws the first failure with the
         * others suppressed onto it, so the shutdown report carries it on the metrics signal.
         */
        @Override
        public void close() {
            RuntimeException failure = null;
            for (Registration reg : registrations) {
                RuntimeException failed;
                try {
                    reg.close();
                    continue;
                } catch (ListenerNotFoundException ex) {
                    failed = new IllegalStateException("libo11y could not remove a JVM GC notification listener", ex);
                } catch (RuntimeException ex) {
                    failed = ex;
                }
                if (failure == null) {
                    failure = failed;
                } else if (failed != failure) {
                    failure.addSuppressed(failed);
                }
            }
            registrations.clear();
            if (failure != null) {
                throw failure;
            }
        }
    }
}
