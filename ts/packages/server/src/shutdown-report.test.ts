/**
 * Site review: the shutdown report against a collector that fails. Upstream's batch log processor
 * and periodic metric reader keep a failed export to themselves, so shutdown used to resolve ok
 * while the last logs and metrics were lost. Each signal is checked on its own against a loopback
 * server that answers an error status, one that refuses the connection, one that accepts the
 * connection and never answers, and one that accepts the export.
 */
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createTcpServer, type Socket, type Server as TcpServer } from "node:net";
import { test } from "node:test";
import { createTelemetryWith, type SignalReport, type Telemetry } from "@libo11y/core";
import { serverPlatform } from "./platform.ts";
import { clearedOtelEnv, withEnv } from "./test-support/env.ts";
import { close, listen } from "./test-support/http.ts";

type Signal = "traces" | "metrics" | "logs";
const SIGNALS: readonly Signal[] = ["traces", "metrics", "logs"];

const OPTIONS = {
  serviceName: "shutdown-report-test",
  environment: "test",
  runtimeMetrics: false,
  console: false,
} as const;

/** A telemetry that exports only signal, to url. */
function telemetryFor(signal: Signal, url: string, env: Record<string, string> = {}): Promise<Telemetry> {
  const others = Object.fromEntries(
    SIGNALS.filter((s) => s !== signal).map((s) => [`OTEL_${s.toUpperCase()}_EXPORTER`, "none"]),
  );
  return withEnv({ ...clearedOtelEnv(), OTEL_EXPORTER_OTLP_ENDPOINT: url, ...others, ...env }, () =>
    createTelemetryWith(OPTIONS, serverPlatform()),
  );
}

function emit(telemetry: Telemetry): void {
  telemetry.tracerProvider.getTracer("app").startSpan("GET /items").end();
  telemetry.logger.info("listing items");
  telemetry.meterProvider.getMeter("app").createCounter("app.jobs").add(1);
}

function answering(status: number): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status);
      res.end();
    });
  };
}

function failures(report: SignalReport): [string, string][] {
  return report.errors.map((e) => [e.signal, e.error instanceof Error ? e.error.message : String(e.error)]);
}

/** A TCP server that accepts connections and never answers them. */
function blackHole(): Promise<{ server: TcpServer; url: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

/**
 * A TCP server that drops every connection. It stands in for a collector that is down: the port
 * stays bound by this test, where a port assumed closed could be taken by another test meanwhile.
 */
function dropping(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createTcpServer((socket) => {
    socket.on("error", () => {});
    socket.destroy();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

for (const signal of SIGNALS) {
  for (const [status, text] of [
    [404, "Not Found"],
    [500, "Internal Server Error"],
  ] as const) {
    test(`${signal}: a collector that answers ${status} is in the shutdown report`, async () => {
      const { server, url } = await listen(answering(status));
      try {
        const telemetry = await telemetryFor(signal, url);
        emit(telemetry);
        const report = await telemetry.shutdown();
        assert.equal(report.ok, false);
        assert.deepEqual(failures(report), [[signal, `o11y: shutdown ${signal}: ${text}`]]);
      } finally {
        await close(server);
      }
    });
  }

  test(`${signal}: a collector that drops the connection is in the shutdown report`, async () => {
    const down = await dropping();
    try {
      // The export timeout leaves no room for a retry, so the network error is the export's result.
      const telemetry = await telemetryFor(signal, down.url, { OTEL_EXPORTER_OTLP_TIMEOUT: "300" });
      emit(telemetry);
      const report = await telemetry.shutdown();
      assert.equal(report.ok, false);
      assert.equal(report.errors.length, 1, JSON.stringify(failures(report)));
      assert.equal(report.errors[0]?.signal, signal);
      // The network error is the usual text. On a machine too busy to see the reset inside the
      // export timeout, the timeout is. Either way the signal is reported as lost, which is the
      // point here: otlp-transport.test.ts pins the error itself.
      assert.match(
        failures(report)[0]?.[1] ?? "",
        /^o11y: shutdown \w+: .*(socket hang up|ECONNRESET|closed|timed out|deadline exceeded)/i,
      );
    } finally {
      await down.close();
    }
  });

  test(`${signal}: a collector that never answers is in the shutdown report once the export times out`, async () => {
    const hole = await blackHole();
    try {
      const telemetry = await telemetryFor(signal, hole.url, { OTEL_EXPORTER_OTLP_TIMEOUT: "200" });
      emit(telemetry);
      // The export's own timeout ends it, well inside the 5000 ms shutdown deadline, which would
      // have read "deadline exceeded".
      const report = await telemetry.shutdown();
      assert.deepEqual(failures(report), [[signal, `o11y: shutdown ${signal}: Request timed out`]]);
    } finally {
      await hole.close();
    }
  });

  test(`${signal}: a collector that accepts the export leaves the report ok`, async () => {
    let requests = 0;
    const { server, url } = await listen((req, res) => {
      requests++;
      answering(200)(req, res);
    });
    try {
      const telemetry = await telemetryFor(signal, url);
      emit(telemetry);
      assert.deepEqual(await telemetry.shutdown(), { ok: true, errors: [] });
      assert.equal(requests, 1);
    } finally {
      await close(server);
    }
  });
}

test("forceFlush reports a failed export for each signal, and the telemetry keeps working", async () => {
  let status = 503;
  const { server, url } = await listen((req, res) => answering(status)(req, res));
  try {
    const telemetry = await withEnv(
      { ...clearedOtelEnv(), OTEL_EXPORTER_OTLP_ENDPOINT: url, OTEL_EXPORTER_OTLP_TIMEOUT: "300" },
      () => createTelemetryWith(OPTIONS, serverPlatform()),
    );
    emit(telemetry);
    const failed = await telemetry.forceFlush();
    assert.deepEqual(
      failed.errors.map((e) => e.signal),
      ["logs", "metrics", "traces"],
    );
    status = 200;
    emit(telemetry);
    assert.deepEqual(await telemetry.forceFlush(), { ok: true, errors: [] });
    assert.deepEqual(await telemetry.shutdown(), { ok: true, errors: [] });
  } finally {
    await close(server);
  }
});

// Second review, C2. Upstream's span processor sends its batches together and rejects at the first
// that fails. Shutdown used to stop the exporter right then, which destroyed the requests of the
// sibling batches a healthy collector was about to accept.
test("traces: one rejected batch does not abort the sibling batches still in flight", async () => {
  const events: string[] = [];
  let aborted = 0;
  const { server, url } = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      // The span names travel as plain text in the protobuf body, so they tell the batches apart.
      const rejected = Buffer.concat(chunks).includes("batch-two");
      // Every response is late. The rejection comes well before the two acceptances.
      setTimeout(
        () => {
          res.writeHead(rejected ? 400 : 200);
          res.end(() => events.push(rejected ? "400" : "200"));
        },
        rejected ? 30 : 300,
      );
    });
    res.on("close", () => {
      if (!res.writableFinished) aborted++;
    });
  });
  try {
    const telemetry = await telemetryFor("traces", url);
    const tracer = telemetry.tracerProvider.getTracer("app");
    // Three batches at the default batch size of 512. The first leaves as soon as it is full. The
    // other two are flushed together at shutdown, and the one that fails is one of those.
    for (const name of ["batch-one", "batch-two", "batch-three"]) {
      for (let i = 0; i < 512; i++) tracer.startSpan(name).end();
    }
    const report = await telemetry.shutdown();
    events.push("shutdown resolved");
    // Every response had been written before shutdown resolved. The order of the three is the
    // collector's, and is not what is checked.
    assert.equal(events.at(-1), "shutdown resolved");
    assert.deepEqual(events.slice(0, -1).sort(), ["200", "200", "400"]);
    assert.equal(aborted, 0, "no request was destroyed under the collector");
    assert.deepEqual(failures(report), [["traces", "o11y: shutdown traces: Bad Request"]]);
  } finally {
    await close(server);
  }
});
