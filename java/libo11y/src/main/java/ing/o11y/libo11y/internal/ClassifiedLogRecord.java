package ing.o11y.libo11y.internal;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.common.AttributesBuilder;
import io.opentelemetry.api.common.Value;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.api.trace.SpanContext;
import io.opentelemetry.sdk.common.InstrumentationScopeInfo;
import io.opentelemetry.sdk.logs.ReadWriteLogRecord;
import io.opentelemetry.sdk.logs.data.Body;
import io.opentelemetry.sdk.logs.data.LogRecordData;
import io.opentelemetry.sdk.resources.Resource;

/**
 * The view of a log record that processors and exporters behind the policy see. The SDK's record
 * cannot remove an attribute, so the classified attributes live here, and every read
 * ({@link #getAttributes()}, {@link #getAttribute(AttributeKey)}, {@link #toLogRecordData()})
 * returns them. An attribute a downstream processor sets is classified before it is stored, and is
 * visible to the processors after it, as the SDK documents for its own record.
 */
final class ClassifiedLogRecord implements ReadWriteLogRecord {
    private final ReadWriteLogRecord delegate;
    private final SensitivityPolicy policy;
    private final Object lock = new Object();
    private Attributes attributes; // guarded by lock
    private int added; // guarded by lock

    ClassifiedLogRecord(ReadWriteLogRecord delegate, SensitivityPolicy policy, Attributes classified) {
        this.delegate = delegate;
        this.policy = policy;
        this.attributes = classified;
    }

    @Override
    public <T> ReadWriteLogRecord setAttribute(AttributeKey<T> key, T value) {
        if (key == null || key.getKey().isEmpty() || value == null) {
            return this;
        }
        Attributes single = Attributes.of(key, value);
        Attributes clean = LogAttributeClassifier.classify(single, policy);
        Attributes put = clean == null ? single : clean;
        synchronized (lock) {
            AttributesBuilder b = attributes.toBuilder();
            b.removeIf(k -> k.getKey().equals(key.getKey()));
            b.putAll(put);
            attributes = b.build();
            added++;
        }
        return this;
    }

    @Override
    public Attributes getAttributes() {
        synchronized (lock) {
            return attributes;
        }
    }

    @Override
    public <T> T getAttribute(AttributeKey<T> key) {
        return getAttributes().get(key);
    }

    @Override
    public LogRecordData toLogRecordData() {
        Attributes snapshot;
        int extra;
        synchronized (lock) {
            snapshot = attributes;
            extra = added;
        }
        return new Data(delegate.toLogRecordData(), snapshot, extra);
    }

    @Override
    public String getEventName() {
        return delegate.getEventName();
    }

    @Override
    public InstrumentationScopeInfo getInstrumentationScopeInfo() {
        return delegate.getInstrumentationScopeInfo();
    }

    @Override
    public long getTimestampEpochNanos() {
        return delegate.getTimestampEpochNanos();
    }

    @Override
    public long getObservedTimestampEpochNanos() {
        return delegate.getObservedTimestampEpochNanos();
    }

    @Override
    public SpanContext getSpanContext() {
        return delegate.getSpanContext();
    }

    @Override
    public Severity getSeverity() {
        return delegate.getSeverity();
    }

    @Override
    public String getSeverityText() {
        return delegate.getSeverityText();
    }

    @Override
    public Value<?> getBodyValue() {
        return delegate.getBodyValue();
    }

    /** Immutable record data carrying the classified attributes over the SDK's own data. */
    private static final class Data implements LogRecordData {
        private final LogRecordData raw;
        private final Attributes attributes;
        private final int totalAttributeCount;

        Data(LogRecordData raw, Attributes attributes, int added) {
            this.raw = raw;
            this.attributes = attributes;
            this.totalAttributeCount = Math.max(raw.getTotalAttributeCount() + added, attributes.size());
        }

        @Override
        public Resource getResource() {
            return raw.getResource();
        }

        @Override
        public InstrumentationScopeInfo getInstrumentationScopeInfo() {
            return raw.getInstrumentationScopeInfo();
        }

        @Override
        public long getTimestampEpochNanos() {
            return raw.getTimestampEpochNanos();
        }

        @Override
        public long getObservedTimestampEpochNanos() {
            return raw.getObservedTimestampEpochNanos();
        }

        @Override
        public SpanContext getSpanContext() {
            return raw.getSpanContext();
        }

        @Override
        public Severity getSeverity() {
            return raw.getSeverity();
        }

        @Override
        public String getSeverityText() {
            return raw.getSeverityText();
        }

        @Override
        @SuppressWarnings("deprecation")
        public Body getBody() {
            return raw.getBody();
        }

        @Override
        public Value<?> getBodyValue() {
            return raw.getBodyValue();
        }

        @Override
        public Attributes getAttributes() {
            return attributes;
        }

        @Override
        public int getTotalAttributeCount() {
            return totalAttributeCount;
        }

        @Override
        public String getEventName() {
            return raw.getEventName();
        }
    }
}
