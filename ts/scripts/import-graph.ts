/**
 * The value-import graph of a TypeScript module, for the boundary tests of the internal entries
 * @libo11y/web/portable and @libo11y/rum/core: which relative modules and which packages a bundler
 * that does not tree-shake, such as Metro, would pull in. Type-only imports and re-exports are
 * skipped, because erasable syntax removes them. A statement must start a line or follow a
 * semicolon, as Biome formats them, so an import written in a comment or a string is not followed.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// An import or export with a from clause, or a bare side-effect import, at a line start or after
// a semicolon. The clause before from is a default name, a brace list (which may span lines and
// hold comments, braces in them included), a namespace, or a default and one of those.
const LIST = String.raw`\{(?:[^}/]|//[^\n]*|/\*[\s\S]*?\*/|/)*\}`;
const CLAUSE = String.raw`(?:[\w$]+\s*,\s*)?(?:${LIST}|\*(?:\s+as\s+[\w$]+)?)|[\w$]+`;
const SPEC = `["']([^"']+)["']`;
const STATEMENT = new RegExp(
  String.raw`(?:^|;)[ \t]*(?:(import|export)[ \t]+(type[ \t]+)?(?:${CLAUSE})\s*from\s*${SPEC}|import[ \t]*${SPEC})`,
  "gm",
);
/** A run-time import() or require() in code, outside a comment line. */
const DYNAMIC = /^(?![ \t]*(?:\/\/|\/?\*))[^\n]*(?<![\w$.])(?:import|require)\s*\(/m;

/**
 * The globals a browser has and React Native on Hermes may lack, which the boundary tests remove
 * before they evaluate an entry.
 */
export const BROWSER_GLOBALS: readonly string[] = [
  "document",
  "window",
  "navigator",
  "indexedDB",
  "localStorage",
  "sessionStorage",
  "location",
  "crypto",
  "isSecureContext",
  "DOMException",
  "CompressionStream",
  "BroadcastChannel",
  "PerformanceObserver",
  "MutationObserver",
  "addEventListener",
  "removeEventListener",
];

/**
 * files: every relative module reached through value imports, the entry included, as absolute
 * paths. packages: every bare specifier reached. dynamic: the reached modules with a run-time
 * import() or require(), which this graph cannot follow and a boundary should refuse.
 */
export function valueImports(entry: string): {
  readonly files: ReadonlySet<string>;
  readonly packages: ReadonlySet<string>;
  readonly dynamic: ReadonlySet<string>;
} {
  const files = new Set<string>();
  const packages = new Set<string>();
  const dynamic = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, "utf8");
    if (DYNAMIC.test(text)) dynamic.add(file);
    for (const m of text.matchAll(STATEMENT)) {
      if (m[2] !== undefined) continue;
      const spec = m[3] ?? m[4];
      if (spec === undefined) continue;
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  };
  visit(resolve(entry));
  return { files, packages, dynamic };
}
