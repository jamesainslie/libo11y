/**
 * The breadcrumb ring (decision P18): the last actions, view changes and requests, which every
 * o11y.rum.error carries as o11y.rum.error.breadcrumbs, one per line, oldest first.
 */

/** The default number of breadcrumbs kept. */
export const BREADCRUMBS_MAX = 20;

export interface Breadcrumbs {
  /** at is performance.now() when it happened. */
  add(kind: string, label: string, at: number): void;
  /** The entries, oldest first, as "<kind> <label> -<age>ms" relative to now. */
  snapshot(now: number): string[];
  clear(): void;
}

/** One line per breadcrumb, so a line break in a label is a space. */
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, " ");

export function createBreadcrumbs(max: number = BREADCRUMBS_MAX): Breadcrumbs {
  const ring: { kind: string; label: string; at: number }[] = [];
  return {
    add(kind, label, at) {
      ring.push({ kind: oneLine(kind), label: oneLine(label), at });
      if (ring.length > max) ring.shift();
    },
    snapshot: (now) => ring.map((c) => `${c.kind} ${c.label} -${Math.max(0, Math.round(now - c.at))}ms`),
    clear() {
      ring.length = 0;
    },
  };
}
