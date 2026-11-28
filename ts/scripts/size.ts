/**
 * Size budgets for the browser packages. ts/size-budget.json lists entries, each an ES module
 * source importing from @libo11y/* with a budget, and deltas, each a source measured against a base
 * entry, which is what installing one collector adds. A size is the minified, gzip-compressed bytes
 * of the source bundled for the browser. An entry may name external modules, such as react for an
 * adapter whose framework the app bundles anyway; they are left out of its bundle. An entry may name
 * export conditions, such as react-native for a React Native package, which Metro resolves with.
 *
 * An entry or delta may set chunks, which bundles it with code splitting, as an app's bundler
 * would, and measures one part: "initial" is the entry chunk and every chunk it imports
 * statically, what the page downloads up front, and "lazy" is every other chunk, what a dynamic
 * import() fetches later. A delta's base is always measured without splitting.
 *
 *   bun scripts/size.ts [--check] [--summary FILE] [--json FILE]
 *
 * prints a markdown table, appends it to --summary (CI passes $GITHUB_STEP_SUMMARY), writes the rows
 * to --json, and exits 1 under --check when any row is over its budget. A budget increase is a
 * reviewed diff of size-budget.json, with the measured number in the commit message.
 *
 * Only the main branch reaches Bun, through globalThis.Bun, so node --test can load this module.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The size-budget.json format. */
export interface BudgetFile {
  readonly unit: string;
  readonly entries: Readonly<
    Record<
      string,
      {
        readonly code: string;
        readonly budget: number;
        readonly external?: readonly string[];
        readonly chunks?: Chunks;
        readonly conditions?: readonly string[];
      }
    >
  >;
  readonly deltas: Readonly<
    Record<
      string,
      { readonly base: string; readonly code: string; readonly budget: number; readonly chunks?: Chunks }
    >
  >;
}

/** Which part of a code-split bundle to measure. */
export type Chunks = "initial" | "lazy";

/** One output file of a code-split build, with its compressed size. */
export interface BundleChunk {
  /** The output path, such as ./chunk-abc.js. */
  readonly path: string;
  /** "entry-point" or "chunk". */
  readonly kind: string;
  readonly code: string;
  readonly size: number;
}

/** One measured row. */
export interface BudgetRow {
  readonly name: string;
  readonly size: number;
  readonly budget: number;
  readonly over: boolean;
}

function measured(absolute: Readonly<Record<string, number>>, name: string): number {
  const v = absolute[name];
  if (v === undefined) throw new Error(`size: no measurement for ${name}`);
  return v;
}

/**
 * The rows for file, given the absolute size of every entry and of every delta's code. A delta's
 * size is its absolute size minus its base entry's.
 */
export function compareBudgets(file: BudgetFile, absolute: Readonly<Record<string, number>>): BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const [name, e] of Object.entries(file.entries)) {
    const size = measured(absolute, name);
    rows.push({ name, size, budget: e.budget, over: size > e.budget });
  }
  for (const [name, d] of Object.entries(file.deltas)) {
    if (file.entries[d.base] === undefined)
      throw new Error(`size: delta ${name} names unknown base ${d.base}`);
    const size = measured(absolute, name) - measured(absolute, d.base);
    rows.push({ name, size, budget: d.budget, over: size > d.budget });
  }
  return rows;
}

/** The rows as a markdown table. */
export function formatTable(rows: readonly BudgetRow[]): string {
  const lines = ["| Bundle | Bytes (min+gzip) | Budget | Status |", "|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.name} | ${r.size} | ${r.budget} | ${r.over ? "over" : "ok"} |`);
  return `${lines.join("\n")}\n`;
}

interface BunBuildOutput {
  readonly path: string;
  readonly kind: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface BunLike {
  build(opts: unknown): Promise<{ success: boolean; logs: unknown[]; outputs: BunBuildOutput[] }>;
  gzipSync(data: Uint8Array): Uint8Array;
}

const workspace = resolve(import.meta.dirname, "..");

/** Resolves @libo11y/<pkg>[/<sub>] to the workspace package's export, as the published package would. */
function workspaceResolver(): unknown {
  return {
    name: "libo11y-workspace",
    setup(build: {
      onResolve(o: { filter: RegExp }, cb: (args: { path: string }) => { path: string } | undefined): void;
    }) {
      build.onResolve({ filter: /^@libo11y\/[a-z-]+(\/[a-z-]+)?$/ }, (args) => {
        const [, pkg, sub] = /^@libo11y\/([a-z-]+)(?:\/([a-z-]+))?$/.exec(args.path) ?? [];
        if (pkg === undefined) return undefined;
        const dir = join(workspace, "packages", pkg);
        const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          exports: Record<string, string>;
        };
        const target = manifest.exports[sub === undefined ? "." : `./${sub}`];
        if (target === undefined) throw new Error(`size: ${args.path} is not exported`);
        return { path: join(dir, target) };
      });
    },
  };
}

/** A static import of a sibling chunk: import"./x.js" or import{...}from"./x.js", never import("./x.js"). */
const STATIC_IMPORT = /\bimport\s*(?:[^"'();]*?\bfrom\s*)?["']\.\/([^"']+)["']/g;

/**
 * The compressed bytes of a code-split build: initial is the entry chunk and every chunk it reaches
 * through static imports; lazy is every other chunk, reached only through a dynamic import().
 */
export function splitSizes(chunks: readonly BundleChunk[]): {
  readonly initial: number;
  readonly lazy: number;
} {
  const entries = chunks.filter((c) => c.kind === "entry-point");
  const entry = entries[0];
  if (entry === undefined || entries.length !== 1)
    throw new Error("size: a split build needs exactly one entry");
  const byName = new Map(chunks.map((c) => [c.path.replace(/^\.\//, ""), c]));
  const initial = new Set<BundleChunk>();
  const visit = (c: BundleChunk): void => {
    if (initial.has(c)) return;
    initial.add(c);
    for (const m of c.code.matchAll(STATIC_IMPORT)) {
      const next = byName.get(m[1] ?? "");
      if (next !== undefined) visit(next);
    }
  };
  visit(entry);
  let a = 0;
  let b = 0;
  for (const c of chunks) {
    if (initial.has(c)) a += c.size;
    else b += c.size;
  }
  return { initial: a, lazy: b };
}

/** The Bun.build options for one measured source file. */
export function buildOptions(
  file: string,
  external: readonly string[] | undefined,
  conditions?: readonly string[],
  splitting = false,
): Record<string, unknown> {
  return {
    entrypoints: [file],
    target: "browser",
    format: "esm",
    minify: true,
    splitting,
    plugins: [workspaceResolver()],
    ...(external === undefined ? {} : { external: [...external] }),
    ...(conditions === undefined ? {} : { conditions: [...conditions] }),
  };
}

async function measure(
  bun: BunLike,
  dir: string,
  name: string,
  code: string,
  external?: readonly string[],
  conditions?: readonly string[],
  chunks?: Chunks,
): Promise<number> {
  const file = join(dir, `${name.replace(/[^a-z0-9]+/gi, "-")}.ts`);
  writeFileSync(file, code);
  const result = await bun.build(buildOptions(file, external, conditions, chunks !== undefined));
  const output = result.outputs[0];
  if (!result.success || output === undefined) {
    for (const log of result.logs) console.error(log);
    throw new Error(`size: bundling ${name} failed`);
  }
  if (chunks === undefined) return bun.gzipSync(new Uint8Array(await output.arrayBuffer())).byteLength;
  const files: BundleChunk[] = [];
  for (const o of result.outputs) {
    const bytes = new Uint8Array(await o.arrayBuffer());
    files.push({
      path: o.path,
      kind: o.kind,
      code: new TextDecoder().decode(bytes),
      size: bun.gzipSync(bytes).byteLength,
    });
  }
  return splitSizes(files)[chunks];
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

async function main(args: readonly string[]): Promise<number> {
  const bun = (globalThis as { Bun?: BunLike }).Bun;
  if (bun === undefined) throw new Error("size: run with bun");
  const file = JSON.parse(readFileSync(join(workspace, "size-budget.json"), "utf8")) as BudgetFile;
  const dir = join(workspace, "dist", "size");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const absolute: Record<string, number> = {};
  for (const [name, e] of Object.entries(file.entries))
    absolute[name] = await measure(bun, dir, name, e.code, e.external, e.conditions, e.chunks);
  for (const [name, d] of Object.entries(file.deltas))
    absolute[name] = await measure(bun, dir, name, d.code, undefined, undefined, d.chunks);
  const rows = compareBudgets(file, absolute);
  const table = formatTable(rows);
  process.stdout.write(table);
  const summary = flag(args, "--summary");
  if (summary !== undefined) appendFileSync(summary, `### Size budgets\n\n${table}\n`);
  const json = flag(args, "--json");
  if (json !== undefined) writeFileSync(json, `${JSON.stringify(rows, null, 2)}\n`);
  const over = rows.filter((r) => r.over);
  if (args.includes("--check") && over.length > 0) {
    console.error(`size: over budget: ${over.map((r) => `${r.name} (${r.size} > ${r.budget})`).join(", ")}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
