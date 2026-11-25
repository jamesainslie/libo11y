/**
 * Scaffold, frozen. Builds the unpacked test extension into dist/extension: each
 * fixture-extension/src/*.ts bundled for the browser as <name>.js, and every file of
 * fixture-extension/static (manifest.json, pages) copied as is. A work package adds a script or a
 * page by adding a file.
 */
import { cpSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const browserDir = resolve(import.meta.dirname, "..");
const src = join(browserDir, "fixture-extension", "src");
const out = join(browserDir, "dist", "extension");

rmSync(out, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: readdirSync(src)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(src, f)),
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
cpSync(join(browserDir, "fixture-extension", "static"), out, { recursive: true });
