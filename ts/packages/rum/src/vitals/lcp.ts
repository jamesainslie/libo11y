/**
 * LCP attribution for a candidate web-vitals did not report.
 *
 * Firefox reports every LCP candidate of one paint, smaller first, all with the same render time.
 * With reportAllChanges, web-vitals reports only a change in value, so the larger candidates of
 * that paint update the metric's entries but not its attribution, which still names the first,
 * smaller element. staleLcpAttribution rebuilds the attribution for the latest entry the way
 * web-vitals' attribution build does (web-vitals 5.3.0, attribution/onLCP).
 */

/** What RUM reads of a largest-contentful-paint entry. */
export interface LcpEntry {
  readonly element?: Element | null;
  readonly id?: string;
  readonly url?: string;
}

/** What RUM reads of a resource timing entry. */
export interface LcpResource {
  readonly requestStart: number;
  readonly startTime: number;
  readonly responseEnd: number;
}

/** A web-vitals LCP metric with attribution, as web-vitals keeps it between reports. */
export interface LcpMetric {
  readonly value: number;
  readonly entries: readonly LcpEntry[];
  readonly attribution: Readonly<Record<string, unknown>>;
}

interface NavigationTimes {
  readonly activationStart?: number;
  readonly responseStart: number;
}

/**
 * The attribution of m's latest entry, or undefined when m's attribution already describes it.
 * targetOf names an entry's element; resourceOf finds the resource timing entry for a URL.
 */
export function staleLcpAttribution(
  m: LcpMetric,
  targetOf: (entry: LcpEntry) => string | undefined,
  resourceOf: (url: string) => LcpResource | undefined,
): Record<string, unknown> | undefined {
  const entry = m.entries.at(-1);
  if (entry === undefined || entry === m.attribution.lcpEntry) return undefined;
  const { target: _t, url: _u, lcpResourceEntry: _r, ...rest } = m.attribution;
  const out: Record<string, unknown> = { ...rest, lcpEntry: entry };
  const target = targetOf(entry);
  if (target !== undefined) out.target = target;
  const resource = entry.url ? resourceOf(entry.url) : undefined;
  if (entry.url) out.url = entry.url;
  if (resource !== undefined) out.lcpResourceEntry = resource;
  const nav = m.attribution.navigationEntry as NavigationTimes | undefined;
  if (nav === undefined) {
    return {
      ...out,
      timeToFirstByte: 0,
      resourceLoadDelay: 0,
      resourceLoadDuration: 0,
      elementRenderDelay: m.value,
    };
  }
  const activationStart = nav.activationStart || 0;
  const ttfb = Math.max(0, nav.responseStart - activationStart);
  const requestStart = Math.max(
    ttfb,
    resource ? (resource.requestStart || resource.startTime) - activationStart : 0,
  );
  const responseEnd = Math.min(
    m.value,
    Math.max(requestStart, resource ? resource.responseEnd - activationStart : 0),
  );
  return {
    ...out,
    timeToFirstByte: ttfb,
    resourceLoadDelay: requestStart - ttfb,
    resourceLoadDuration: responseEnd - requestStart,
    elementRenderDelay: m.value - responseEnd,
  };
}
