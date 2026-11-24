/**
 * OTLP/protobuf metrics with exemplars. Upstream's ProtobufMetricsSerializer writes no exemplars, so
 * this is a dependency-free encoder of opentelemetry-proto's ExportMetricsServiceRequest. It writes
 * every field upstream writes, in upstream's order, so a collection without exemplars encodes to
 * upstream's bytes exactly, and adds each data point's exemplars (NumberDataPoint field 5,
 * HistogramDataPoint field 8, ExponentialHistogramDataPoint field 11).
 *
 * It walks the SDK's ResourceMetrics rather than the OTLP/JSON object core's JSON serializer builds,
 * because JSON has no NaN or Infinity: a NaN gauge or an empty exponential histogram's infinite
 * bounds would come back as null.
 */
import { exemplarsOf, type ResourceMetricsWithExemplars } from "@libo11y/core";
import { type Attributes, type HrTime, ValueType } from "@opentelemetry/api";
import {
  type IExportMetricsServiceResponse,
  type ISerializer,
  ProtobufMetricsSerializer,
} from "@opentelemetry/otlp-transformer";
import {
  AggregationTemporality,
  type DataPoint,
  DataPointType,
  type ExponentialHistogram,
  type Histogram,
  type MetricData,
  type ResourceMetrics,
  type ScopeMetrics,
} from "@opentelemetry/sdk-metrics";

const VARINT = 0;
const FIXED64 = 1;
const LEN = 2;

const TWO_32 = 4294967296;
const MIN_INT64 = -(2 ** 63);
const MAX_INT64 = 2 ** 63;

const encoder = new TextEncoder();

/** A protobuf wire writer. Embedded messages are written to their own writer and then copied in. */
class Writer {
  private buf = new Uint8Array(256);
  private pos = 0;

  private reserve(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  private byte(b: number): void {
    this.reserve(1);
    this.buf[this.pos++] = b;
  }

  tag(field: number, wireType: number): void {
    this.varint((field << 3) | wireType);
  }

  /** A varint from a 64-bit two's complement pair. */
  private varint64(low: number, high: number): void {
    let lo = low >>> 0;
    let hi = high >>> 0;
    while (hi > 0 || lo > 0x7f) {
      this.byte((lo & 0x7f) | 0x80);
      lo = ((lo >>> 7) | (hi << 25)) >>> 0;
      hi >>>= 7;
    }
    this.byte(lo);
  }

  /** A varint for an integer number; a negative one is written as its 64-bit two's complement. */
  varint(value: number): void {
    const [low, high] = split64(value);
    this.varint64(low, high);
  }

  /** A zigzag varint, as sint32 fields take. */
  sint32(value: number): void {
    this.varint64(((value << 1) ^ (value >> 31)) >>> 0, 0);
  }

  fixed64(low: number, high: number): void {
    this.reserve(8);
    const l = low >>> 0;
    const h = high >>> 0;
    this.buf[this.pos++] = l & 0xff;
    this.buf[this.pos++] = (l >>> 8) & 0xff;
    this.buf[this.pos++] = (l >>> 16) & 0xff;
    this.buf[this.pos++] = (l >>> 24) & 0xff;
    this.buf[this.pos++] = h & 0xff;
    this.buf[this.pos++] = (h >>> 8) & 0xff;
    this.buf[this.pos++] = (h >>> 16) & 0xff;
    this.buf[this.pos++] = (h >>> 24) & 0xff;
  }

  /** An unsigned or signed 64-bit integer number as fixed64 or sfixed64, as upstream converts it. */
  fixed64Number(value: number): void {
    const [low, high] = split64(value);
    this.fixed64(low, high);
  }

  fixed64BigInt(value: bigint): void {
    const v = BigInt.asUintN(64, value);
    this.fixed64(Number(v & 0xffffffffn), Number(v >> 32n));
  }

  double(value: number): void {
    this.reserve(8);
    new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).setFloat64(0, value, true);
    this.pos += 8;
  }

  bytes(value: Uint8Array): void {
    this.varint(value.length);
    this.reserve(value.length);
    this.buf.set(value, this.pos);
    this.pos += value.length;
  }

  string(value: string): void {
    this.bytes(encoder.encode(value));
  }

  /** A length-delimited field whose content fn writes. */
  message(field: number, fn: (w: Writer) => void): void {
    const inner = new Writer();
    fn(inner);
    this.tag(field, LEN);
    this.bytes(inner.finish());
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

// split64 is upstream's conversion of a number to a 64-bit two's complement pair: the low and high
// 32 bits of its magnitude, negated for a negative value.
function split64(value: number): [number, number] {
  if (value >= 0) return [value >>> 0, (value / TWO_32) >>> 0];
  const abs = Math.abs(value);
  let low = ~(abs >>> 0) >>> 0;
  let high = ~((abs / TWO_32) >>> 0) >>> 0;
  low = (low + 1) >>> 0;
  if (low === 0) high = (high + 1) >>> 0;
  return [low, high];
}

function hrTimeNanos(t: HrTime): bigint {
  return BigInt(Math.trunc(t[0])) * 1_000_000_000n + BigInt(Math.trunc(t[1]));
}

function hex(id: string): Uint8Array {
  const out = new Uint8Array(id.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(id.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// anyValue writes an AnyValue's content as upstream's writeAnyValue does.
function anyValue(w: Writer, value: unknown): void {
  switch (typeof value) {
    case "string":
      w.tag(1, LEN);
      w.string(value);
      return;
    case "boolean":
      w.tag(2, VARINT);
      w.varint(value ? 1 : 0);
      return;
    case "number":
      if (Number.isInteger(value) && value >= MIN_INT64 && value < MAX_INT64) {
        w.tag(3, VARINT);
        w.varint(value);
      } else {
        w.tag(4, FIXED64);
        w.double(value);
      }
      return;
  }
  if (value instanceof Uint8Array) {
    w.tag(7, LEN);
    w.bytes(value);
  } else if (Array.isArray(value)) {
    w.message(5, (arr) => {
      for (const item of value) arr.message(1, (v) => anyValue(v, item));
    });
  } else if (typeof value === "object" && value !== null) {
    w.message(6, (list) => {
      for (const [k, v] of Object.entries(value)) list.message(1, (kv) => keyValue(kv, k, v));
    });
  }
}

function keyValue(w: Writer, key: string, value: unknown): void {
  w.tag(1, LEN);
  w.string(key);
  w.message(2, (v) => anyValue(v, value));
}

function attributes(w: Writer, field: number, attrs: Attributes | undefined): void {
  if (attrs === undefined) return;
  for (const [key, value] of Object.entries(attrs)) w.message(field, (kv) => keyValue(kv, key, value));
}

function exemplars(w: Writer, field: number, point: DataPoint<unknown>, valueType: ValueType): void {
  for (const e of exemplarsOf(point)) {
    w.message(field, (x) => {
      attributes(x, 7, e.filteredAttributes);
      x.tag(2, FIXED64);
      x.fixed64BigInt(e.timeUnixNano);
      if (valueType === ValueType.INT) {
        x.tag(6, FIXED64);
        x.fixed64Number(e.value);
      } else {
        x.tag(3, FIXED64);
        x.double(e.value);
      }
      if (e.traceId !== undefined && e.spanId !== undefined) {
        x.tag(4, LEN);
        x.bytes(hex(e.spanId));
        x.tag(5, LEN);
        x.bytes(hex(e.traceId));
      }
    });
  }
}

function times(w: Writer, point: DataPoint<unknown>): void {
  w.tag(2, FIXED64);
  w.fixed64BigInt(hrTimeNanos(point.startTime));
  w.tag(3, FIXED64);
  w.fixed64BigInt(hrTimeNanos(point.endTime));
}

function numberPoint(w: Writer, point: DataPoint<number>, valueType: ValueType): void {
  times(w, point);
  if (valueType === ValueType.INT) {
    w.tag(6, FIXED64);
    w.fixed64Number(point.value);
  } else {
    w.tag(4, FIXED64);
    w.double(point.value);
  }
  attributes(w, 7, point.attributes);
  exemplars(w, 5, point, valueType);
}

function histogramPoint(w: Writer, point: DataPoint<Histogram>, valueType: ValueType): void {
  const h = point.value;
  times(w, point);
  w.tag(4, FIXED64);
  w.fixed64Number(h.count);
  if (h.sum !== undefined) {
    w.tag(5, FIXED64);
    w.double(h.sum);
  }
  if (h.buckets.counts.length > 0) {
    w.message(6, (p) => {
      for (const c of h.buckets.counts) p.fixed64Number(c);
    });
  }
  if (h.buckets.boundaries.length > 0) {
    w.message(7, (p) => {
      for (const b of h.buckets.boundaries) p.double(b);
    });
  }
  attributes(w, 9, point.attributes);
  if (h.min !== undefined) {
    w.tag(11, FIXED64);
    w.double(h.min);
  }
  if (h.max !== undefined) {
    w.tag(12, FIXED64);
    w.double(h.max);
  }
  exemplars(w, 8, point, valueType);
}

function buckets(w: Writer, field: number, offset: number, counts: readonly number[]): void {
  w.message(field, (b) => {
    if (offset !== 0) {
      b.tag(1, VARINT);
      b.sint32(offset);
    }
    if (counts.length > 0) {
      b.message(2, (p) => {
        for (const c of counts) p.varint(c);
      });
    }
  });
}

function exponentialPoint(w: Writer, point: DataPoint<ExponentialHistogram>, valueType: ValueType): void {
  const h = point.value;
  attributes(w, 1, point.attributes);
  times(w, point);
  w.tag(4, FIXED64);
  w.fixed64Number(h.count);
  if (h.sum !== undefined) {
    w.tag(5, FIXED64);
    w.double(h.sum);
  }
  if (h.scale !== 0) {
    w.tag(6, VARINT);
    w.sint32(h.scale);
  }
  w.tag(7, FIXED64);
  w.fixed64Number(h.zeroCount);
  buckets(w, 8, h.positive.offset, h.positive.bucketCounts);
  buckets(w, 9, h.negative.offset, h.negative.bucketCounts);
  if (h.min !== undefined) {
    w.tag(12, FIXED64);
    w.double(h.min);
  }
  if (h.max !== undefined) {
    w.tag(13, FIXED64);
    w.double(h.max);
  }
  exemplars(w, 11, point, valueType);
}

function temporality(w: Writer, t: AggregationTemporality): void {
  const value = t === AggregationTemporality.DELTA ? 1 : t === AggregationTemporality.CUMULATIVE ? 2 : 0;
  if (value === 0) return;
  w.tag(2, VARINT);
  w.varint(value);
}

function metric(w: Writer, m: MetricData): void {
  const valueType = m.descriptor.valueType;
  w.tag(1, LEN);
  w.string(m.descriptor.name);
  if (m.descriptor.description) {
    w.tag(2, LEN);
    w.string(m.descriptor.description);
  }
  if (m.descriptor.unit) {
    w.tag(3, LEN);
    w.string(m.descriptor.unit);
  }
  switch (m.dataPointType) {
    case DataPointType.GAUGE:
      w.message(5, (g) => {
        for (const p of m.dataPoints) g.message(1, (dp) => numberPoint(dp, p, valueType));
      });
      return;
    case DataPointType.SUM:
      w.message(7, (s) => {
        for (const p of m.dataPoints) s.message(1, (dp) => numberPoint(dp, p, valueType));
        temporality(s, m.aggregationTemporality);
        if (m.isMonotonic) {
          s.tag(3, VARINT);
          s.varint(1);
        }
      });
      return;
    case DataPointType.HISTOGRAM:
      w.message(9, (h) => {
        for (const p of m.dataPoints) h.message(1, (dp) => histogramPoint(dp, p, valueType));
        temporality(h, m.aggregationTemporality);
      });
      return;
    case DataPointType.EXPONENTIAL_HISTOGRAM:
      w.message(10, (h) => {
        for (const p of m.dataPoints) h.message(1, (dp) => exponentialPoint(dp, p, valueType));
        temporality(h, m.aggregationTemporality);
      });
      return;
  }
}

function scopeMetrics(w: Writer, sm: ScopeMetrics): void {
  const scope = sm.scope as ScopeMetrics["scope"] & {
    attributes?: Attributes;
    droppedAttributesCount?: number;
  };
  w.message(1, (s) => {
    s.tag(1, LEN);
    s.string(scope.name);
    if (scope.version) {
      s.tag(2, LEN);
      s.string(scope.version);
    }
    attributes(s, 3, scope.attributes);
    if (scope.droppedAttributesCount) {
      s.tag(4, VARINT);
      s.varint(scope.droppedAttributesCount);
    }
  });
  for (const m of sm.metrics) w.message(2, (mw) => metric(mw, m));
  if (scope.schemaUrl) {
    w.tag(3, LEN);
    w.string(scope.schemaUrl);
  }
}

function resourceMetrics(w: Writer, rm: ResourceMetrics): void {
  w.message(1, (r) => {
    attributes(r, 1, rm.resource.attributes);
    r.tag(2, VARINT);
    r.varint(0);
  });
  for (const sm of rm.scopeMetrics) w.message(2, (s) => scopeMetrics(s, sm));
  if (rm.resource.schemaUrl) {
    w.tag(3, LEN);
    w.string(rm.resource.schemaUrl);
  }
}

/**
 * Encodes an ExportMetricsServiceRequest holding each collection in order, with the exemplars
 * ExemplarStore.attach gave its data points.
 */
export function encodeMetricsRequest(collections: readonly ResourceMetricsWithExemplars[]): Uint8Array {
  const w = new Writer();
  for (const rm of collections) w.message(1, (r) => resourceMetrics(r, rm));
  return w.finish();
}

/** OTLP/protobuf metrics with exemplars, for upstream's OTLP HTTP export delegate. */
export const OtlpProtobufMetricsSerializer: ISerializer<
  ResourceMetrics | ResourceMetricsWithExemplars,
  IExportMetricsServiceResponse
> = {
  serializeRequest: (rm) => encodeMetricsRequest([rm]),
  deserializeResponse: (data) => ProtobufMetricsSerializer.deserializeResponse(data),
};
