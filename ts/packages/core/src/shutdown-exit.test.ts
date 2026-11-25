import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// Review W2: upstream batch processors arm export timers that are not unref'd, so a hung exporter
// kept the process alive for their 30 s default after shutdown resolved. With the 5000 ms default
// export timeout, a process with hung span and log exporters exits about when shutdown's own
// 5000 ms deadline passes. The child runs on the runtime running this test, Bun or Node.
//
// Site review: those timers still outlived a shorter shutdown deadline. Shutdown now fails the
// exports still in flight when it settles, which clears the timers, so the process exits when
// shutdown resolves whatever the export timeout is.
function childScript(shutdownOptions: string, env = "{}"): string {
  return `
(async () => {
  const { setupWith } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "telemetry.ts")).href)});
  const { createTestPlatform } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "testing.ts")).href)});
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks");
  const hung = { export() {}, forceFlush: () => new Promise(() => {}), shutdown: () => new Promise(() => {}) };
  const platform = createTestPlatform({
    contextManager: () => new AsyncLocalStorageContextManager(),
    env: () => (${env}),
  });
  const t = await setupWith(
    { serviceName: "svc", environment: "test", spanExporter: hung, logExporter: hung },
    platform,
  );
  t.tracerProvider.getTracer("x").startSpan("a").end();
  t.logger.info("hello");
  const report = await t.shutdown(${shutdownOptions});
  console.log(JSON.stringify(report.errors.map((e) => e.signal)));
})();
`;
}

interface ChildRun {
  readonly code: number | null;
  readonly signals: unknown;
  readonly stderr: string;
  /** From the spawn to the exit. */
  readonly totalMillis: number;
  /** From the line the child prints when shutdown resolves to the exit. */
  readonly afterShutdownMillis: number;
}

// run spawns the child and kills it killAfterMillis after shutdown resolved, should it still be up.
function run(script: string, killAfterMillis: number): Promise<ChildRun> {
  const started = Date.now();
  const child = spawn(process.execPath, ["-e", script], {
    cwd: join(import.meta.dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let stderr = "";
  let resolvedAt: number | undefined;
  let killer: ReturnType<typeof setTimeout> | undefined;
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
    if (resolvedAt === undefined && out.includes("\n")) {
      resolvedAt = Date.now();
      killer = setTimeout(() => child.kill("SIGKILL"), killAfterMillis);
    }
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      clearTimeout(killer);
      const now = Date.now();
      resolve({
        code,
        signals: JSON.parse(out.trim().split("\n").pop() || "null"),
        stderr,
        totalMillis: now - started,
        afterShutdownMillis: now - (resolvedAt ?? started),
      });
    });
  });
}

test("a process with hung exporters exits within about 6 s of starting shutdown", {
  timeout: 30_000,
}, async () => {
  const child = await run(childScript(""), 20_000);
  assert.equal(child.code, 0, child.stderr);
  assert.deepEqual(child.signals, ["logs", "traces"]);
  // Shutdown resolves at its 5 s deadline, and the export timers end at the 5 s default export
  // timeout. Upstream's default is 30 s, which is what held the process before. 9 s fails for that
  // and leaves a loaded machine 4 s for the child to start and exit.
  assert.ok(child.totalMillis < 9000, `the child exited after ${child.totalMillis} ms`);
});

test("a process with hung exporters exits when a short shutdown deadline has passed, not at the export timeout", {
  timeout: 90_000,
}, async () => {
  // The export timeout is a minute. Left armed, the processors' timers hold the process for all
  // of it after the 300 ms deadline. The child gets a third of that to exit, which no teardown
  // needs and no leak fits in, so the check does not depend on how busy the machine is.
  const child = await run(
    childScript(
      "{ timeoutMillis: 300 }",
      '{ OTEL_BSP_EXPORT_TIMEOUT: "60000", OTEL_BLRP_EXPORT_TIMEOUT: "60000" }',
    ),
    20_000,
  );
  assert.deepEqual(child.signals, ["logs", "traces"]);
  // Killed by the test, the child has no exit code.
  assert.equal(
    child.code,
    0,
    `the child was still alive ${child.afterShutdownMillis} ms after shutdown resolved\n${child.stderr}`,
  );
});
