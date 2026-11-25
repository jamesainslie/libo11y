/**
 * Site review: once shutdown has resolved, the telemetry holds nothing that keeps the process
 * alive. A child process on this runtime sets up against a collector that cannot be reached, shuts
 * down with a short deadline, and has to exit by itself.
 *
 * Two collectors stand in for the unreachable one, both on loopback and both held bound by this
 * test, so no other test can take their port. One accepts the connection and never answers, which
 * leaves a request in flight. The other answers 503 and asks for the retry half a minute later,
 * which leaves the exporter waiting between two attempts.
 *
 * Nothing here measures a short time. The child's export timeouts are a minute, so anything it
 * leaves behind holds it for a minute, and it is given a third of that to exit: far more than a
 * loaded machine needs to tear a process down, far less than a leak would take.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { clearedOtelEnv } from "./test-support/env.ts";

const CHILD = fileURLToPath(new URL("./test-support/exit-child.ts", import.meta.url));

/** How long anything the child leaves behind would keep it alive. */
const HOLD_MILLIS = 60_000;

/** How long after shutdown resolves the child may take to exit. */
const EXIT_MARGIN_MILLIS = 20_000;

interface ChildRun {
  readonly code: number | null;
  readonly result: { shutdownMillis: number; ok: boolean; signals: string[] } | undefined;
  readonly stderr: string;
  /** From the RESULT line, printed when shutdown resolved, to the exit. */
  readonly afterShutdownMillis: number;
}

// run spawns the child and kills it when the margin has passed after shutdown resolved.
function run(endpoint: string, timeoutMillis: number): Promise<ChildRun> {
  const env = {
    ...process.env,
    ...clearedOtelEnv(),
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_TIMEOUT: String(HOLD_MILLIS),
    OTEL_BSP_EXPORT_TIMEOUT: String(HOLD_MILLIS),
    OTEL_BLRP_EXPORT_TIMEOUT: String(HOLD_MILLIS),
    OTEL_METRIC_EXPORT_TIMEOUT: String(HOLD_MILLIS),
  };
  const child = spawn(process.execPath, [CHILD, String(timeoutMillis)], {
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let stderr = "";
  let resolvedAt: number | undefined;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = setTimeout(() => child.kill("SIGKILL"), HOLD_MILLIS);
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
    if (resolvedAt === undefined && /^RESULT .*\n/m.test(out)) {
      resolvedAt = performance.now();
      killer = setTimeout(() => child.kill("SIGKILL"), EXIT_MARGIN_MILLIS);
    }
  });
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      clearTimeout(killer);
      clearTimeout(giveUp);
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      resolve({
        code,
        result: line === undefined ? undefined : JSON.parse(line.slice("RESULT ".length)),
        stderr,
        afterShutdownMillis: Math.round(performance.now() - (resolvedAt ?? performance.now())),
      });
    });
  });
}

function assertExitedByItself(child: ChildRun): void {
  assert.ok(child.result !== undefined, `the child printed no result\n${child.stderr}`);
  assert.equal(child.result.ok, false);
  assert.deepEqual(child.result.signals, ["logs", "metrics", "traces"]);
  assert.ok(
    child.result.shutdownMillis < EXIT_MARGIN_MILLIS,
    `shutdown took ${child.result.shutdownMillis} ms of a short deadline`,
  );
  // Killed by the test, the child has no exit code.
  assert.equal(
    child.code,
    0,
    `the child was still alive ${child.afterShutdownMillis} ms after shutdown resolved\n${child.stderr}`,
  );
}

/** Listens on a loopback port and hands each connection to onConnection. */
async function held(
  onConnection: (socket: Socket) => void,
): Promise<{ url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test("a process exits by itself after shutdown when the collector accepts connections and never answers", {
  timeout: 90_000,
}, async () => {
  const hole = await held(() => {});
  try {
    assertExitedByItself(await run(hole.url, 300));
  } finally {
    await hole.close();
  }
});

test("a process exits by itself after shutdown when the collector has asked it to retry later", {
  timeout: 90_000,
}, async () => {
  // The wait before the retry is longer than the margin, so a wait that is not cancelled shows.
  const busy = await held((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nRetry-After: 30\r\nContent-Length: 0\r\n\r\n");
    });
  });
  try {
    assertExitedByItself(await run(busy.url, 300));
  } finally {
    await busy.close();
  }
});
