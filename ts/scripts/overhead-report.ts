/**
 * Renders the RUM overhead benchmark's result (dist/bench/overhead.json, written by
 * packages/rum/browser/bench/overhead.bench.ts) as a markdown table and checks it against limits.
 *
 *   bun scripts/overhead-report.ts FILE [--summary FILE] [--max-view-ms N] [--max-interaction-ms N]
 *
 * prints the table, appends it to --summary (CI passes $GITHUB_STEP_SUMMARY), and exits 1 when a
 * measure is above its limit. The limits are a first guard against regressions, not a target.
 */
import { appendFileSync, readFileSync } from "node:fs";

/** Main-thread task time in milliseconds, summed over a run's views or interactions. */
export interface OverheadTotals {
  readonly views: number;
  readonly interactions: number;
}

/** The benchmark's result. */
export interface OverheadResult {
  /** The browser and its version. */
  readonly browser: string;
  readonly runs: number;
  /** The median over runs of the extra task time RUM adds per soft navigation. */
  readonly viewMillis: number;
  /** The median over runs of the extra task time RUM adds per click. */
  readonly interactionMillis: number;
  /** The median totals without RUM. */
  readonly baseline: OverheadTotals;
  /** The median totals with RUM. */
  readonly withRum: OverheadTotals;
}

export interface OverheadLimits {
  readonly maxViewMillis?: number;
  readonly maxInteractionMillis?: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(o: Record<string, unknown>, key: string, where: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`overhead: ${where}${key} must be a number`);
  return v;
}

function totals(o: Record<string, unknown>, key: string): OverheadTotals {
  const t = o[key];
  if (!isObject(t)) throw new Error(`overhead: ${key} must be an object`);
  return { views: num(t, "views", `${key}.`), interactions: num(t, "interactions", `${key}.`) };
}

/** The result in value, or a thrown Error naming what is wrong. */
export function parseOverhead(value: unknown): OverheadResult {
  if (!isObject(value)) throw new Error("overhead: the result must be an object");
  if (typeof value.browser !== "string") throw new Error("overhead: browser must be a string");
  return {
    browser: value.browser,
    runs: num(value, "runs", ""),
    viewMillis: num(value, "viewMillis", ""),
    interactionMillis: num(value, "interactionMillis", ""),
    baseline: totals(value, "baseline"),
    withRum: totals(value, "withRum"),
  };
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

function limit(args: readonly string[], name: string): number | undefined {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(v)) throw new Error(`overhead: ${name} must be a number`);
  return v;
}

/** The limits the command-line flags set. */
export function parseLimits(args: readonly string[]): OverheadLimits {
  const view = limit(args, "--max-view-ms");
  const interaction = limit(args, "--max-interaction-ms");
  return {
    ...(view === undefined ? {} : { maxViewMillis: view }),
    ...(interaction === undefined ? {} : { maxInteractionMillis: interaction }),
  };
}

/** The result as a markdown table, and every measure above its limit. */
export function reportOverhead(
  result: OverheadResult,
  limits: OverheadLimits,
): { markdown: string; over: string[] } {
  const rows: [string, number, number | undefined][] = [
    ["per view", result.viewMillis, limits.maxViewMillis],
    ["per interaction", result.interactionMillis, limits.maxInteractionMillis],
  ];
  const over: string[] = [];
  const lines = [
    `RUM overhead on ${result.browser}, median of ${result.runs} runs (main-thread task time).`,
    "",
    "| Measure | Overhead (ms) | Limit (ms) | Status |",
    "|---|---|---|---|",
  ];
  for (const [name, ms, max] of rows) {
    const isOver = max !== undefined && ms > max;
    if (isOver) over.push(`${name} ${ms.toFixed(2)} ms > ${max.toFixed(2)} ms`);
    lines.push(
      `| ${name} | ${ms.toFixed(2)} | ${max === undefined ? "-" : max.toFixed(2)} | ${isOver ? "over" : "ok"} |`,
    );
  }
  return { markdown: `${lines.join("\n")}\n`, over };
}

function main(args: readonly string[]): number {
  const file = args[0];
  if (file === undefined || file.startsWith("--")) {
    console.error(
      "usage: overhead-report.ts FILE [--summary FILE] [--max-view-ms N] [--max-interaction-ms N]",
    );
    return 2;
  }
  const result = parseOverhead(JSON.parse(readFileSync(file, "utf8")));
  const { markdown, over } = reportOverhead(result, parseLimits(args));
  process.stdout.write(markdown);
  const summary = flag(args, "--summary");
  if (summary !== undefined) appendFileSync(summary, `### RUM overhead\n\n${markdown}\n`);
  if (over.length > 0) {
    console.error(`overhead: above the limit: ${over.join(", ")}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
