/**
 * Bundles the fixtures under browser/fixtures in packages/rum and every packages/rum-<adapter>
 * into the web fixture server's bundle directory as <package dir>-<name>.js, so /page/rum-core
 * serves packages/rum/browser/fixtures/core.ts and /page/rum-react-boundary serves
 * packages/rum-react/browser/fixtures/boundary.ts. Runs after the web build, which empties that
 * directory.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const packages = resolve(import.meta.dirname, "..", "..", "..");
const out = join(packages, "web", "browser", "dist", "bundles");
for (const dir of readdirSync(packages).filter((d) => d === "rum" || d.startsWith("rum-"))) {
  const fixtures = join(packages, dir, "browser", "fixtures");
  if (!existsSync(fixtures)) continue;
  const entrypoints = readdirSync(fixtures)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(fixtures, f));
  const result = await Bun.build({
    entrypoints,
    outdir: out,
    naming: `${dir}-[name].[ext]`,
    target: "browser",
    format: "esm",
    sourcemap: "inline",
    splitting: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
