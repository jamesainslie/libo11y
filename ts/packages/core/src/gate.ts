/**
 * WP2 (queue and consent). The recording gate in core: the sampler and span processor wrappers the
 * tracer provider uses, the log record processor wrapper the logger provider uses, and the check the meter and log
 * pipelines share. telemetry.ts, metrics.ts and logger.ts call these; only WP2 edits those files in
 * L4.
 */
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { type Sampler, SamplingDecision, type SpanProcessor } from "@opentelemetry/sdk-trace";
import type { RecordingGate } from "./platform.ts";

/**
 * A sampler that returns NOT_RECORD while the gate is closed and asks inner otherwise. toString
 * is inner's, so the startup summary reports the configured sampler.
 */
export function gatedSampler(inner: Sampler, gate: RecordingGate): Sampler {
  return {
    shouldSample(ctx, traceId, spanName, spanKind, attributes, links) {
      if (!gate.recording()) return { decision: SamplingDecision.NOT_RECORD };
      return inner.shouldSample(ctx, traceId, spanName, spanKind, attributes, links);
    },
    toString: () => inner.toString(),
  };
}

/**
 * A log record processor that drops every record while the gate is closed and reports itself
 * disabled, so a record emitted straight through the logs API is neither classified nor buffered.
 * Flush and shutdown always reach inner.
 */
export function gatedLogRecordProcessor(inner: LogRecordProcessor, gate: RecordingGate): LogRecordProcessor {
  return {
    onEmit(record, ctx) {
      if (gate.recording()) inner.onEmit(record, ctx);
    },
    enabled(opts) {
      if (!gate.recording()) return false;
      return inner.enabled === undefined ? true : inner.enabled(opts);
    },
    forceFlush: (opts) => inner.forceFlush(opts),
    shutdown: () => inner.shutdown(),
  };
}

/**
 * A span processor that drops every span ending while the gate is closed, so a span started under
 * consent and ended after revocation is neither buffered nor exported, as the log processor drops
 * records. onStart, onEnding, flush and shutdown always reach inner.
 */
export function gatedSpanProcessor(inner: SpanProcessor, gate: RecordingGate): SpanProcessor {
  const processor: SpanProcessor = {
    onStart: (span, ctx) => inner.onStart(span, ctx),
    onEnd(span) {
      if (gate.recording()) inner.onEnd(span);
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
  if (inner.onEnding !== undefined) {
    const onEnding = inner.onEnding.bind(inner);
    processor.onEnding = (span) => onEnding(span);
  }
  return processor;
}

/** True when there is no gate or the gate is open. */
export function gateOpen(gate: RecordingGate | undefined): boolean {
  return gate === undefined || gate.recording();
}
