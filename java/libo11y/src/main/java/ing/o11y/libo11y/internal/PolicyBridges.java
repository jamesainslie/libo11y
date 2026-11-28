package ing.o11y.libo11y.internal;

import ing.o11y.libo11y.spec.generated.Spec;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
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
import io.opentelemetry.context.Context;
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

    public static final class PolicyLogRecordProcessor implements LogRecordProcessor {
        private final SensitivityPolicy policy;
        private final LogRecordProcessor delegate;

        public PolicyLogRecordProcessor(SensitivityPolicy policy, LogRecordProcessor delegate) {
            this.policy = policy;
            this.delegate = delegate;
        }

        @Override
        public void onEmit(Context context, ReadWriteLogRecord logRecord) {
            Attributes raw = logRecord.toLogRecordData().getAttributes();
            if (!raw.isEmpty()) {
                Attributes clean = policy.classifyAttributes(raw, Spec.Signal.LOGS, true);
                // Replace by clearing removed keys and updating changed keys
                raw.forEach((key, val) -> {
                    Object kept = clean.get(key);
                    if (kept == null && clean.get(AttributeKey.stringKey(key.getKey())) != null) {
                        // Hash mode converted non-string PII to string token
                        logRecord.setAttribute(key, null);
                        logRecord.setAttribute(
                                AttributeKey.stringKey(key.getKey()),
                                clean.get(AttributeKey.stringKey(key.getKey())));
                    } else if (kept == null) {
                        logRecord.setAttribute(key, null);
                    } else if (!kept.equals(val)) {
                        setTyped(logRecord, key, kept);
                    }
                });
            }
            if (delegate != null) {
                delegate.onEmit(context, logRecord);
            }
        }

        @SuppressWarnings("unchecked")
        private static <T> void setTyped(ReadWriteLogRecord rec, AttributeKey<T> key, Object value) {
            rec.setAttribute(key, (T) value);
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

    private static final class PolicyMeter implements Meter {
        private final Meter delegate;
        private final SensitivityPolicy policy;

        PolicyMeter(Meter delegate, SensitivityPolicy policy) {
            this.delegate = delegate;
            this.policy = policy;
        }

        private Consumer<ObservableLongMeasurement> wrapLongCallback(Consumer<ObservableLongMeasurement> cb) {
            return measurement -> cb.accept(new ObservableLongMeasurement() {
                @Override
                public void record(long value) {
                    measurement.record(value);
                }

                @Override
                public void record(long value, Attributes attributes) {
                    measurement.record(value, policy.classifyMetricAttributes(attributes));
                }
            });
        }

        private Consumer<ObservableDoubleMeasurement> wrapDoubleCallback(Consumer<ObservableDoubleMeasurement> cb) {
            return measurement -> cb.accept(new ObservableDoubleMeasurement() {
                @Override
                public void record(double value) {
                    measurement.record(value);
                }

                @Override
                public void record(double value, Attributes attributes) {
                    measurement.record(value, policy.classifyMetricAttributes(attributes));
                }
            });
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
                            ObservableDoubleMeasurement m = db.buildObserver();
                            return new ObservableDoubleMeasurement() {
                                @Override
                                public void record(double value) {
                                    m.record(value);
                                }

                                @Override
                                public void record(double value, Attributes attributes) {
                                    m.record(value, policy.classifyMetricAttributes(attributes));
                                }
                            };
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
                    ObservableLongMeasurement m = b.buildObserver();
                    return new ObservableLongMeasurement() {
                        @Override
                        public void record(long value) {
                            m.record(value);
                        }

                        @Override
                        public void record(long value, Attributes attributes) {
                            m.record(value, policy.classifyMetricAttributes(attributes));
                        }
                    };
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
                            ObservableDoubleMeasurement m = db.buildObserver();
                            return new ObservableDoubleMeasurement() {
                                @Override
                                public void record(double value) {
                                    m.record(value);
                                }

                                @Override
                                public void record(double value, Attributes attributes) {
                                    m.record(value, policy.classifyMetricAttributes(attributes));
                                }
                            };
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
                    ObservableLongMeasurement m = b.buildObserver();
                    return new ObservableLongMeasurement() {
                        @Override
                        public void record(long value) {
                            m.record(value);
                        }

                        @Override
                        public void record(long value, Attributes attributes) {
                            m.record(value, policy.classifyMetricAttributes(attributes));
                        }
                    };
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
                            ObservableLongMeasurement m = lb.buildObserver();
                            return new ObservableLongMeasurement() {
                                @Override
                                public void record(long value) {
                                    m.record(value);
                                }

                                @Override
                                public void record(long value, Attributes attributes) {
                                    m.record(value, policy.classifyMetricAttributes(attributes));
                                }
                            };
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
                    ObservableDoubleMeasurement m = b.buildObserver();
                    return new ObservableDoubleMeasurement() {
                        @Override
                        public void record(double value) {
                            m.record(value);
                        }

                        @Override
                        public void record(double value, Attributes attributes) {
                            m.record(value, policy.classifyMetricAttributes(attributes));
                        }
                    };
                }
            };
        }
    }

    // ---------------- Zero-dependency JVM runtime metrics ----------------

    public static final class JvmRuntimeMetrics implements AutoCloseable {
        private static final AttributeKey<String> MEMORY_TYPE = AttributeKey.stringKey("jvm.memory.type");
        private static final AttributeKey<String> POOL_NAME = AttributeKey.stringKey("jvm.memory.pool.name");
        private static final AttributeKey<String> GC_NAME = AttributeKey.stringKey("jvm.gc.name");
        private static final AttributeKey<Boolean> THREAD_DAEMON = AttributeKey.booleanKey("jvm.thread.daemon");

        private final List<AutoCloseable> registrations = new ArrayList<>();

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
                    }));

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
                    }));

            ThreadMXBean threads = ManagementFactory.getThreadMXBean();
            metrics.registrations.add(meter.upDownCounterBuilder("jvm.thread.count")
                    .setDescription("Number of executing platform threads.")
                    .setUnit("{thread}")
                    .buildWithCallback(m -> {
                        int daemon = threads.getDaemonThreadCount();
                        int nonDaemon = Math.max(0, threads.getThreadCount() - daemon);
                        m.record(daemon, Attributes.of(THREAD_DAEMON, true));
                        m.record(nonDaemon, Attributes.of(THREAD_DAEMON, false));
                    }));

            List<GarbageCollectorMXBean> gcs = ManagementFactory.getGarbageCollectorMXBeans();
            metrics.registrations.add(meter.counterBuilder("jvm.gc.duration")
                    .ofDoubles()
                    .setDescription("Cumulative garbage collection time.")
                    .setUnit("s")
                    .buildWithCallback(m -> {
                        for (GarbageCollectorMXBean gc : gcs) {
                            long ms = gc.getCollectionTime();
                            if (ms >= 0) {
                                m.record(ms / (double) TimeUnit.SECONDS.toMillis(1), Attributes.of(GC_NAME, gc.getName()));
                            }
                        }
                    }));

            return metrics;
        }

        @Override
        public void close() {
            for (AutoCloseable reg : registrations) {
                try {
                    reg.close();
                } catch (Exception ignored) {
                    // best effort
                }
            }
            registrations.clear();
        }
    }
}
