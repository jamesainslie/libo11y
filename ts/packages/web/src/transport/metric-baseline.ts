/**
 * The consent boundary for cumulative metrics. The SDK keeps every cumulative series' running total
 * and has no reset, so after a revocation the totals recorded before it would still be exported.
 * A collection exported while the consent gate is closed becomes the baseline, and every later
 * cumulative collection is exported as its difference from that baseline.
 */
import type { HrTime } from "@opentelemetry/api";
import { hrTime } from "@opentelemetry/core";
import {
  AggregationTemporality,
  type DataPoint,
  DataPointType,
  type ExponentialHistogram,
  type Histogram,
  type MetricData,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";

/** A collection exported into the closed gate, and when. */
export interface MetricBaseline {
  /** The boundary: no point exported after it starts earlier. */
  readonly at: HrTime;
  readonly points: ReadonlyMap<string, DataPoint<unknown>>;
}

function attributesKey(attrs: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.keys(attrs)
      .sort()
      .map((k) => [k, attrs[k]]),
  );
}

function pointKey(scope: string, metric: MetricData, point: DataPoint<unknown>): string {
  return `${scope}\u0000${metric.descriptor.name}\u0000${metric.dataPointType}\u0000${attributesKey(point.attributes)}`;
}

function scopeOf(sm: ResourceMetrics["scopeMetrics"][number]): string {
  return `${sm.scope.name}\u0000${sm.scope.version ?? ""}\u0000${sm.scope.schemaUrl ?? ""}`;
}

/** The baseline a collection exported into the closed gate sets. */
export function baselineOf(rm: ResourceMetrics, at: HrTime = hrTime()): MetricBaseline {
  const points = new Map<string, DataPoint<unknown>>();
  for (const sm of rm.scopeMetrics) {
    const scope = scopeOf(sm);
    for (const metric of sm.metrics) {
      for (const p of metric.dataPoints as readonly DataPoint<unknown>[])
        points.set(pointKey(scope, metric, p), p);
    }
  }
  return { at, points };
}

function later(a: HrTime, b: HrTime): HrTime {
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]) ? a : b;
}

// subtractCounts subtracts base from counts index by index.
function subtractCounts(counts: readonly number[], base: readonly number[]): number[] {
  return counts.map((c, i) => c - (base[i] ?? 0));
}

// downscale merges the buckets of an exponential histogram side to a smaller scale, by shift.
function downscale(side: ExponentialHistogram["positive"], shift: number): ExponentialHistogram["positive"] {
  if (shift === 0 || side.bucketCounts.length === 0) return side;
  const offset = side.offset >> shift;
  const counts: number[] = [];
  side.bucketCounts.forEach((c, i) => {
    const j = ((side.offset + i) >> shift) - offset;
    counts[j] = (counts[j] ?? 0) + c;
  });
  return { offset, bucketCounts: Array.from(counts, (c) => c ?? 0) };
}

// subtractSide subtracts base from side, both at one scale, keeping side's layout.
function subtractSide(
  side: ExponentialHistogram["positive"],
  base: ExponentialHistogram["positive"],
): ExponentialHistogram["positive"] | undefined {
  const counts = side.bucketCounts.map((c, i) => c - (base.bucketCounts[side.offset + i - base.offset] ?? 0));
  // A baseline bucket outside the current layout means the series is not the one in the baseline.
  for (const [i, c] of base.bucketCounts.entries()) {
    const j = base.offset + i - side.offset;
    if (c > 0 && (j < 0 || j >= side.bucketCounts.length)) return undefined;
  }
  return counts.some((c) => c < 0) ? undefined : { offset: side.offset, bucketCounts: counts };
}

// minus is point's change since base, or undefined when it has none or none can be known.
function minus(
  metric: MetricData,
  point: DataPoint<unknown>,
  base: DataPoint<unknown>,
): DataPoint<unknown> | undefined {
  switch (metric.dataPointType) {
    case DataPointType.SUM: {
      const value = (point.value as number) - (base.value as number);
      return value === 0 ? undefined : { ...point, value };
    }
    case DataPointType.GAUGE:
      // A gauge reading equal to the baseline's cannot be told apart from the one before it.
      return point.value === base.value ? undefined : point;
    case DataPointType.HISTOGRAM: {
      const cur = point.value as Histogram;
      const old = base.value as Histogram;
      const count = cur.count - old.count;
      if (count <= 0 || cur.buckets.counts.length !== old.buckets.counts.length) return undefined;
      const value: Histogram = {
        buckets: {
          boundaries: cur.buckets.boundaries,
          counts: subtractCounts(cur.buckets.counts, old.buckets.counts),
        },
        count,
        ...(cur.sum === undefined || old.sum === undefined ? {} : { sum: cur.sum - old.sum }),
      };
      return { ...point, value };
    }
    case DataPointType.EXPONENTIAL_HISTOGRAM: {
      const cur = point.value as ExponentialHistogram;
      const old = base.value as ExponentialHistogram;
      const count = cur.count - old.count;
      const shift = old.scale - cur.scale;
      if (count <= 0 || shift < 0) return undefined;
      const positive = subtractSide(cur.positive, downscale(old.positive, shift));
      const negative = subtractSide(cur.negative, downscale(old.negative, shift));
      if (positive === undefined || negative === undefined) return undefined;
      const value: ExponentialHistogram = {
        count,
        scale: cur.scale,
        zeroCount: cur.zeroCount - old.zeroCount,
        positive,
        negative,
        ...(cur.sum === undefined || old.sum === undefined ? {} : { sum: cur.sum - old.sum }),
      };
      return { ...point, value };
    }
  }
}

// sincePoint is point as exported after the boundary: its change since the baseline, starting no
// earlier than the boundary, or undefined when nothing was recorded since.
function sincePoint(
  metric: MetricData,
  point: DataPoint<unknown>,
  key: string,
  baseline: MetricBaseline,
): DataPoint<unknown> | undefined {
  const base = baseline.points.get(key);
  const changed = base === undefined ? point : minus(metric, point, base);
  if (changed === undefined) return undefined;
  return { ...changed, startTime: later(changed.startTime, baseline.at) };
}

/**
 * rm as exported after a consent boundary: each cumulative point is its change since baseline,
 * with a start time no earlier than the boundary. A point with no change is left out, and so are
 * the metrics and scopes left with none. Histograms lose min and max, which a difference cannot
 * give. A gauge point is left out while it reads what the baseline read, and is otherwise kept as
 * it is. Delta points pass through unchanged. Undefined when nothing is left to export.
 */
export function sinceBaseline(rm: ResourceMetrics, baseline: MetricBaseline): ResourceMetrics | undefined {
  const scopeMetrics: ResourceMetrics["scopeMetrics"] = [];
  for (const sm of rm.scopeMetrics) {
    const scope = scopeOf(sm);
    const metrics: MetricData[] = [];
    for (const metric of sm.metrics) {
      if (metric.aggregationTemporality !== AggregationTemporality.CUMULATIVE) {
        metrics.push(metric);
        continue;
      }
      const dataPoints: DataPoint<unknown>[] = [];
      for (const p of metric.dataPoints as readonly DataPoint<unknown>[]) {
        const since = sincePoint(metric, p, pointKey(scope, metric, p), baseline);
        if (since !== undefined) dataPoints.push(since);
      }
      if (dataPoints.length > 0) metrics.push({ ...metric, dataPoints } as MetricData);
    }
    if (metrics.length > 0) scopeMetrics.push({ ...sm, metrics });
  }
  return scopeMetrics.length === 0 ? undefined : { ...rm, scopeMetrics };
}
