/**
 * The RUM overhead benchmark: packages/rum/browser/bench/*.bench.ts on Chromium, one worker, no
 * retries, with the same fixture server and global setup as the browser tests. It writes
 * dist/bench/overhead.json. CI runs it (the ts-bench workflow); it is a benchmark, so do not run it
 * on a shared machine. Run with `bun run bench:browser`.
 */
import { defineConfig } from "@playwright/test";

const port = Number(process.env.LIBO11Y_BROWSER_PORT ?? "47312");

export default defineConfig({
  testDir: "packages/rum/browser/bench",
  testMatch: "**/*.bench.ts",
  outputDir: "dist/playwright-bench",
  globalSetup: "./packages/web/browser/harness/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  // A stuck page or click fails in seconds, not at the test timeout.
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command: "bun packages/web/browser/harness/server.ts",
    url: `http://127.0.0.1:${port}/health`,
    env: { LIBO11Y_BROWSER_PORT: String(port) },
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
    timeout: 30_000,
  },
});
