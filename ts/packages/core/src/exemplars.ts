/**
 * Exemplars. sdk-metrics 3.1.1 records none, so libo11y samples them itself: the policy meter
 * provider offers every synchronous measurement here, and ExemplarStore.attach joins the samples to
 * the data points of a collection before they are exported.
 *
 * A series is one scope, instrument and (classified) attribute set. A histogram series keeps its
 * latest 16 samples, and attach keeps the latest per bucket of the point's own boundaries, so a view
 * with any boundaries is served; any other series keeps a uniform sample of 4 per collection cycle
 * (Algorithm R). attach gives each series to the matching data point with the most attributes,
 * where matching means the point's attributes are a subset of the series' with equal values. The
 * series attributes the point lacks, typically keys a view dropped, become the exemplar's
 * filteredAttributes. Samples newer than the point's end time wait for the next cycle.
 *
 * attach consumes what it attaches, so with several readers the first to collect gets each sample.
 * A series is matched by the instrument's name, so a view that renames an instrument leaves its
 * stream without exemplars.
 *
 * Nothing may ever read the store (an injected reader nobody wraps, say), so offer discards samples
 * more than 5 minutes older than the newest one it has seen, and a full store first sweeps those
 * before it refuses a new series. The series cap warns only when live series really fill it.
 */
import {
  type Attributes,
  type AttributeValue,
  type Context,
  diag,
  type HrTime,
  isSpanContextValid,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import {
  type DataPoint,
  DataPointType,
  type Histogram,
  type MetricData,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { renderUnbounded } from "./canonical.ts";
import { metricWatchFor } from "./internal/watches.ts";

/** Which measurements may become exemplars. */
export type ExemplarFilter = "trace_based" | "always_on" | "always_off";

/** One sampled measurement attached to a data point. */
export interface Exemplar {
  readonly timeUnixNano: bigint;
  readonly value: number;
  /** Lowercase hex, present when the measurement ran inside a valid span context. */
  readonly traceId?: string;
  readonly spanId?: string;
  /** The measurement's attributes that the data point does not carry. */
  readonly filteredAttributes: Attributes;
}

/** A data point that may carry exemplars, as ExemplarStore.attach returns it. */
export type DataPointWithExemplars<T> = DataPoint<T> & { readonly exemplars?: readonly Exemplar[] };

/**
 * ResourceMetrics whose data points may carry an `exemplars` array, as ExemplarStore.attach
 * returns it. Structurally a ResourceMetrics, so any exporter accepts it; read the exemplars with
 * exemplarsOf.
 */
export type ResourceMetricsWithExemplars = ResourceMetrics;

/** The exemplars attached to point, or none. */
export function exemplarsOf(point: DataPoint<unknown>): readonly Exemplar[] {
  return (point as DataPointWithExemplars<unknown>).exemplars ?? [];
}

/** The instrument kinds the store samples. */
export type ExemplarKind = "histogram" | "sum" | "gauge";

/** One measurement offered to the store. */
export interface ExemplarMeasurement {
  /** The meter's scope, as scopeKey renders it. */
  readonly scope: string;
  readonly instrument: string;
  readonly kind: ExemplarKind;
  readonly value: number;
  /** The measurement's attributes after classification. */
  readonly attributes: Attributes;
  readonly context: Context;
  /** When the measurement happened. Defaults to now, at millisecond precision as sdk-metrics records. */
  readonly time?: HrTime;
}

/** Options for ExemplarStore. */
export interface ExemplarStoreOptions {
  readonly filter: ExemplarFilter;
  /** The most series sampled at once. Default 2000. */
  readonly maxSeries?: number;
}

/** The exemplars a non-histogram point carries at most. */
export const FIXED_RESERVOIR_SIZE = 4;

/** The latest samples a histogram series keeps. */
export const HISTOGRAM_SAMPLES = 16;

/** How much older than the newest sample a sample may be before offer discards it: 5 minutes. */
const MAX_SAMPLE_AGE_NANOS = 5n * 60n * 1_000_000_000n;

/** How often, on the store's clock, a full store sweeps for old samples: once a second. */
const SWEEP_INTERVAL_NANOS = 1_000_000_000n;

const DEFAULT_MAX_SERIES = 2000;

/** The key of an instrumentation scope, as the store and the meter wrapper share it. */
export function scopeKey(name: string, version: string | undefined, schemaUrl: string | undefined): string {
  return `${name}\u0000${version ?? ""}\u0000${schemaUrl ?? ""}`;
}

interface Sample {
  readonly time: bigint;
  readonly value: number;
  readonly traceId?: string;
  readonly spanId?: string;
}

interface Series {
  /** The scope and instrument part of the series key. */
  readonly instrumentKey: string;
  readonly attributes: Attributes;
  readonly kind: ExemplarKind;
  /**
   * A histogram's latest HISTOGRAM_SAMPLES samples, oldest first, or any other instrument's
   * reservoir of FIXED_RESERVOIR_SIZE.
   */
  samples: Sample[];
  /** Measurements offered to the reservoir this cycle. */
  seen: number;
}

/** The index of the bucket value falls in: buckets are (-inf, b0], (b0, b1], ..., (bn-1, +inf). */
export function bucketIndex(boundaries: readonly number[], value: number): number {
  let lo = 0;
  let hi = boundaries.length - 1;
  let ret = boundaries.length;
  while (hi >= lo) {
    const mid = lo + Math.trunc((hi - lo) / 2);
    if ((boundaries[mid] as number) < value) lo = mid + 1;
    else {
      ret = mid;
      hi = mid - 1;
    }
  }
  return ret;
}

function toNanos(t: HrTime): bigint {
  return BigInt(Math.trunc(t[0])) * 1_000_000_000n + BigInt(Math.trunc(t[1]));
}

function nowNanos(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function sameValue(a: AttributeValue | undefined, b: AttributeValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

function isSubset(point: Attributes, series: Attributes): boolean {
  for (const k of Object.keys(point)) {
    if (!Object.hasOwn(series, k) || !sameValue(point[k], series[k])) return false;
  }
  return true;
}

function toExemplar(s: Sample, filtered: Attributes): Exemplar {
  return {
    timeUnixNano: s.time,
    value: s.value,
    ...(s.traceId === undefined ? {} : { traceId: s.traceId, spanId: s.spanId as string }),
    filteredAttributes: filtered,
  };
}

/** Samples exemplars from measurements and attaches them to collected data points. */
export class ExemplarStore {
  private readonly filter: ExemplarFilter;
  private readonly maxSeries: number;
  private readonly series = new Map<string, Series>();
  /** Series keys by scope and instrument. */
  private readonly byInstrument = new Map<string, Set<string>>();
  private warned = false;
  /** The newest sample time seen: the store's clock for discarding old samples. */
  private newest = 0n;
  private lastSweep: bigint | undefined;

  constructor(opts: ExemplarStoreOptions) {
    this.filter = opts.filter;
    this.maxSeries = opts.maxSeries ?? DEFAULT_MAX_SERIES;
  }

  /**
   * Offers one measurement. The filter decides whether it may become an exemplar.
   *
   * @internal The policy meter provider calls this; applications record through instruments.
   */
  offer(m: ExemplarMeasurement): void {
    if (this.filter === "always_off") return;
    const sc = trace.getSpanContext(m.context);
    const valid = sc !== undefined && isSpanContextValid(sc);
    if (this.filter === "trace_based" && !(valid && (sc.traceFlags & TraceFlags.SAMPLED) !== 0)) return;

    const instrumentKey = `${m.scope}\u0000${m.instrument}`;
    // The key tells attribute sets apart, so it is rendered without the token's bounds.
    const key = `${instrumentKey}\u0000${renderUnbounded(m.attributes)}`;
    const time = m.time === undefined ? nowNanos() : toNanos(m.time);
    if (time > this.newest) this.newest = time;
    const horizon = this.newest - MAX_SAMPLE_AGE_NANOS;
    let series = this.series.get(key);
    if (series === undefined && this.series.size >= this.maxSeries) this.sweep(horizon);
    if (series === undefined) {
      if (this.series.size >= this.maxSeries) {
        if (!this.warned) {
          this.warned = true;
          diag.warn(`libo11y: exemplar series limit ${this.maxSeries} reached; new series are not sampled`);
        }
        return;
      }
      series = {
        instrumentKey,
        attributes: { ...m.attributes },
        kind: m.kind,
        samples: [],
        seen: 0,
      };
      this.series.set(key, series);
      let keys = this.byInstrument.get(instrumentKey);
      if (keys === undefined) {
        keys = new Set();
        this.byInstrument.set(instrumentKey, keys);
      }
      keys.add(key);
    } else if (series.samples.some((s) => s.time < horizon)) {
      series.samples = series.samples.filter((s) => s.time >= horizon);
      series.seen = series.samples.length;
    }

    const sample: Sample = {
      time,
      value: m.value,
      ...(valid ? { traceId: sc.traceId, spanId: sc.spanId } : {}),
    };
    if (series.kind === "histogram") {
      series.samples.push(sample);
      if (series.samples.length > HISTOGRAM_SAMPLES) series.samples.shift();
      return;
    }
    series.seen++;
    if (series.samples.length < FIXED_RESERVOIR_SIZE) {
      series.samples.push(sample);
    } else {
      const j = Math.floor(Math.random() * series.seen);
      if (j < FIXED_RESERVOIR_SIZE) series.samples[j] = sample;
    }
  }

  // sweep discards every sample older than horizon and the series it empties, at most once a
  // second on the store's clock.
  private sweep(horizon: bigint): void {
    if (this.lastSweep !== undefined && this.newest - this.lastSweep < SWEEP_INTERVAL_NANOS) return;
    this.lastSweep = this.newest;
    for (const series of this.series.values()) {
      if (series.samples.some((s) => s.time < horizon)) {
        series.samples = series.samples.filter((s) => s.time >= horizon);
        series.seen = series.samples.length;
      }
    }
    this.prune();
  }

  /**
   * Returns rm with each data point's exemplars attached, consuming them. Samples newer than their
   * point's end time stay for the next cycle; samples no point claimed and no newer than the
   * collection are discarded. rm itself is not modified.
   */
  attach(rm: ResourceMetrics): ResourceMetricsWithExemplars {
    const claimed = new Set<string>();
    let cutoff = -1n;
    const scopeMetrics = rm.scopeMetrics.map((sm) => {
      const scope = scopeKey(sm.scope.name, sm.scope.version, sm.scope.schemaUrl);
      const metrics = sm.metrics.map((metric) => {
        for (const p of metric.dataPoints) {
          const end = toNanos(p.endTime);
          if (end > cutoff) cutoff = end;
        }
        return this.attachMetric(scope, metric, claimed);
      });
      return { ...sm, metrics };
    });
    if (cutoff >= 0n) {
      for (const [key, series] of this.series) {
        if (claimed.has(key)) continue;
        this.take(series, cutoff);
      }
    }
    this.prune();
    return { ...rm, scopeMetrics };
  }

  // attachMetric assigns each of the instrument's series to its best point and returns the metric
  // with exemplars on the points that got any.
  private attachMetric(scope: string, metric: MetricData, claimed: Set<string>): MetricData {
    const keys = this.byInstrument.get(`${scope}\u0000${metric.descriptor.name}`);
    if (keys === undefined || keys.size === 0) return metric;
    const points = metric.dataPoints as readonly DataPoint<unknown>[];
    const perPoint = new Map<number, Exemplar[]>();
    for (const key of keys) {
      const series = this.series.get(key);
      if (series === undefined) continue;
      let best = -1;
      let bestSize = -1;
      points.forEach((p, i) => {
        const size = Object.keys(p.attributes).length;
        if (size > bestSize && isSubset(p.attributes, series.attributes)) {
          best = i;
          bestSize = size;
        }
      });
      const point = points[best];
      if (point === undefined) continue;
      claimed.add(key);
      const samples = this.take(series, toNanos(point.endTime));
      if (samples.length === 0) continue;
      const filtered: Record<string, AttributeValue | undefined> = {};
      for (const k of Object.keys(series.attributes)) {
        if (!Object.hasOwn(point.attributes, k)) filtered[k] = series.attributes[k];
      }
      const list = perPoint.get(best) ?? [];
      for (const s of samples) list.push(toExemplar(s, filtered as Attributes));
      perPoint.set(best, list);
    }
    if (perPoint.size === 0) return metric;
    const dataPoints = points.map((p, i) => {
      const list = perPoint.get(i);
      if (list === undefined) return p;
      return { ...p, exemplars: capped(metric, p, list) };
    });
    return { ...metric, dataPoints } as MetricData;
  }

  // take removes and returns the series' samples no newer than cutoff, oldest first.
  private take(series: Series, cutoff: bigint): Sample[] {
    const out: Sample[] = [];
    const rest: Sample[] = [];
    for (const s of series.samples) (s.time <= cutoff ? out : rest).push(s);
    series.samples = rest;
    series.seen = rest.length;
    return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  }

  private prune(): void {
    for (const [key, series] of this.series) {
      if (series.samples.length > 0) continue;
      this.series.delete(key);
      const keys = this.byInstrument.get(series.instrumentKey);
      if (keys?.delete(key) && keys.size === 0) {
        this.byInstrument.delete(series.instrumentKey);
      }
    }
  }
}

// capped limits a point's exemplars: an explicit-bucket histogram keeps the latest per bucket of
// the point's own boundaries, anything else the latest FIXED_RESERVOIR_SIZE. list is oldest first.
function capped(metric: MetricData, point: DataPoint<unknown>, list: readonly Exemplar[]): Exemplar[] {
  if (metric.dataPointType === DataPointType.HISTOGRAM) {
    const boundaries = (point.value as Histogram).buckets.boundaries;
    const byBucket = new Map<number, Exemplar>();
    for (const e of list) byBucket.set(bucketIndex(boundaries, e.value), e);
    return [...byBucket.entries()].sort(([a], [b]) => a - b).map(([, e]) => e);
  }
  return list.slice(-FIXED_RESERVOIR_SIZE);
}

/**
 * Wraps a push exporter so every collection it exports carries the store's exemplars. A platform
 * builds its periodic reader over this. When store belongs to a telemetry, the wrapper also lets
 * that telemetry watch the exports, so its shutdown reports a failed one and stops the exporter.
 */
export function exemplarMetricExporter(inner: PushMetricExporter, store: ExemplarStore): PushMetricExporter {
  const attaching: Pick<PushMetricExporter, "export" | "forceFlush" | "shutdown"> = {
    export: (metrics, resultCallback) => inner.export(store.attach(metrics), resultCallback),
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
  };
  // The telemetry that owns store watches the exporter through here, since the reader that holds
  // it is the platform's: a failed export reaches the shutdown report, and shutdown stops the
  // exporter. A store no telemetry owns leaves the exporter as it is.
  const watched = metricWatchFor(store)?.watch<ResourceMetrics>(attaching) ?? attaching;
  const exporter: PushMetricExporter = {
    export: (metrics, resultCallback) => watched.export(metrics, resultCallback),
    forceFlush: () => watched.forceFlush(),
    shutdown: () => watched.shutdown(),
  };
  if (inner.selectAggregationTemporality !== undefined) {
    const select = inner.selectAggregationTemporality.bind(inner);
    exporter.selectAggregationTemporality = (t) => select(t);
  }
  if (inner.selectAggregation !== undefined) {
    const select = inner.selectAggregation.bind(inner);
    exporter.selectAggregation = (t) => select(t);
  }
  return exporter;
}
