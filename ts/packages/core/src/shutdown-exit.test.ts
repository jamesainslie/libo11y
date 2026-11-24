import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Review W2: upstream batch processors arm export timers that are not unref'd, so a hung exporter
// kept the process alive for their 30 s default after shutdown resolved. With the 5000 ms default
// export timeout, a process with hung span and log exporters exits about when shutdown's own
// 5000 ms deadline passes. The child runs on the runtime running this test, Bun or Node.
const CHILD = `
(async () => {
  const { setupWith } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "telemetry.ts")).href)});
  const { createTestPlatform } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "testing.ts")).href)});
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks");
  const hung = { export() {}, forceFlush: () => new Promise(() => {}), shutdown: () => new Promise(() => {}) };
  const platform = createTestPlatform({ contextManager: () => new AsyncLocalStorageContextManager() });
  const t = await setupWith(
    { serviceName: "svc", environment: "test", spanExporter: hung, logExporter: hung },
    platform,
  );
  t.tracerProvider.getTracer("x").startSpan("a").end();
  t.logger.info("hello");
  const report = await t.shutdown();
  console.log(JSON.stringify(report.errors.map((e) => e.signal)));
})();
`;

test("a process with hung exporters exits within about 6 s of starting shutdown", {
  timeout: 30_000,
}, async () => {
  const started = Date.now();
  const child = spawn(process.execPath, ["-e", CHILD], {
    cwd: join(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    err += d.toString();
  });
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  const elapsed = Date.now() - started;
  assert.equal(code, 0, err);
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop() ?? "[]"), ["logs", "traces"]);
  assert.ok(elapsed < 7500, `the child exited after ${elapsed} ms`);
});
