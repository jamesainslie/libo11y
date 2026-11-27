/**
 * Scaffold, frozen. Bundles every browser fixture with Bun before the Playwright run: the web
 * pages (packages/web/browser/harness/build.ts), the test extension
 * (packages/webext/browser/harness/build.ts) and the RUM pages, which join the web bundles
 * (packages/rum/browser/harness/build.ts). Playwright itself runs on Node.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export default function globalSetup(): void {
  const root = resolve(import.meta.dirname, "../../../..");
  for (const script of [
    "packages/web/browser/harness/build.ts",
    "packages/webext/browser/harness/build.ts",
    "packages/rum/browser/harness/build.ts",
  ]) {
    execFileSync("bun", [script], { cwd: root, stdio: "inherit" });
  }
}
