/**
 * Scaffold, frozen. Bundles each packages/web/browser/fixtures/*.ts into dist/bundles/<name>.js for
 * the browser, so a work package adds a fixture by adding a file, never by editing this script. The
 * fixture server serves /page/<name> as an HTML page that loads /bundles/<name>.js.
 */
import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const browserDir = resolve(import.meta.dirname, "..");
const fixtures = join(browserDir, "fixtures");
const out = join(browserDir, "dist", "bundles");

rmSync(out, { recursive: true, force: true });
const entrypoints = readdirSync(fixtures)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(fixtures, f));

const result = await Bun.build({
  entrypoints,
  outdir: out,
  target: "browser",
  format: "esm",
  sourcemap: "inline",
  splitting: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
