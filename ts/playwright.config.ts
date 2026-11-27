/**
 * Real-browser tests for @libo11y/web and @libo11y/webext in Chromium headless, and for @libo11y/rum
 * and its adapters in Chromium, Firefox and WebKit. Specs are
 * packages/<pkg>/browser/**\/*.pw.ts, a suffix neither bun test nor the node --test glob picks up.
 * The global setup bundles the fixtures with Bun; the web server is the fixture server and OTLP
 * sink in packages/web/browser/harness/server.ts. Run with `bun run test:browser`.
 */
import { defineConfig } from "@playwright/test";

const port = Number(process.env.LIBO11Y_BROWSER_PORT ?? "47311");

export default defineConfig({
  testMatch: "**/*.pw.ts",
  outputDir: "dist/playwright",
  globalSetup: "./packages/web/browser/harness/global-setup.ts",
  fullyParallel: true,
  workers: 2,
  timeout: 30_000,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
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
  projects: [
    {
      name: "web",
      testDir: "packages/web/browser",
      use: {
        browserName: "chromium",
        // localhost is a second origin for cross-origin propagation tests; it resolves to the
        // same fixture server as 127.0.0.1.
        launchOptions: { args: ["--host-resolver-rules=MAP localhost 127.0.0.1"] },
      },
    },
    // The webext specs launch their own persistent context with the test extension loaded
    // (packages/webext/browser/harness/fixtures.ts).
    { name: "webext", testDir: "packages/webext/browser" },
    // @libo11y/rum and its adapters on every engine the browser support matrix names.
    ...(["chromium", "firefox", "webkit"] as const).map((browserName) => ({
      name: `rum-${browserName}`,
      testDir: "packages",
      testMatch: /\/rum(-[a-z-]+)?\/browser\/.*\.pw\.ts$/,
      use: { browserName },
    })),
  ],
});
