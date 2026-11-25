/**
 * The OTEL_EXPORTER_OTLP_* variables upstream reads for the exporters, end to end through the
 * transport: the header variables, shared and per signal, and the TLS variables, against a loopback
 * HTTPS collector that demands a client certificate from a CA made for the test run.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { TLSSocket } from "node:tls";
import { createTelemetryWith, type SignalReport, type Telemetry } from "@libo11y/core";
import { serverPlatform } from "./platform.ts";
import { generateCertificates, type TestCertificates } from "./test-support/certs.ts";
import { clearedOtelEnv, withEnv } from "./test-support/env.ts";
import { close, listen } from "./test-support/http.ts";

const OPTIONS = {
  serviceName: "exporters-env-test",
  environment: "test",
  runtimeMetrics: false,
  console: false,
} as const;

function telemetryFor(env: Record<string, string>): Promise<Telemetry> {
  return withEnv({ ...clearedOtelEnv(), ...env }, () => createTelemetryWith(OPTIONS, serverPlatform()));
}

function emit(telemetry: Telemetry): void {
  telemetry.tracerProvider.getTracer("app").startSpan("GET /items").end();
  telemetry.logger.info("listing items");
  telemetry.meterProvider.getMeter("app").createCounter("app.jobs").add(1);
}

function failures(report: SignalReport): string[] {
  return report.errors.map(
    (e) => `${e.signal}: ${e.error instanceof Error ? e.error.message : String(e.error)}`,
  );
}

test("OTEL_EXPORTER_OTLP_HEADERS reaches every signal's request, and a signal's own variable adds to it and wins", async () => {
  const seen = new Map<string, IncomingMessage["headers"]>();
  const { server, url } = await listen((req, res) => {
    seen.set(req.url ?? "", req.headers);
    req.resume();
    req.on("end", () => {
      res.writeHead(200);
      res.end();
    });
  });
  try {
    const telemetry = await telemetryFor({
      OTEL_EXPORTER_OTLP_ENDPOINT: url,
      OTEL_EXPORTER_OTLP_HEADERS: "x-shared=1,x-both=shared,authorization=Bearer%20abc",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-traces=1,x-both=traces",
      OTEL_EXPORTER_OTLP_METRICS_HEADERS: "x-metrics=1",
    });
    emit(telemetry);
    assert.deepEqual(await telemetry.shutdown(), { ok: true, errors: [] });
    const pick = (path: string): Record<string, unknown> => {
      const h = seen.get(path) ?? {};
      return Object.fromEntries(
        ["x-shared", "x-both", "x-traces", "x-metrics", "authorization"].map((k) => [k, h[k]]),
      );
    };
    assert.deepEqual(pick("/v1/traces"), {
      "x-shared": "1",
      "x-both": "traces",
      "x-traces": "1",
      "x-metrics": undefined,
      authorization: "Bearer abc",
    });
    assert.deepEqual(pick("/v1/metrics"), {
      "x-shared": "1",
      "x-both": "shared",
      "x-traces": undefined,
      "x-metrics": "1",
      authorization: "Bearer abc",
    });
    assert.deepEqual(pick("/v1/logs"), {
      "x-shared": "1",
      "x-both": "shared",
      "x-traces": undefined,
      "x-metrics": undefined,
      authorization: "Bearer abc",
    });
    assert.equal(seen.get("/v1/logs")?.["content-type"], "application/x-protobuf");
  } finally {
    await close(server);
  }
});

/** Whether the HTTPS server of this runtime can tell which certificate a client presented. */
const CAN_READ_PEER = !("Bun" in globalThis);

let certs: TestCertificates;
let dir: string;
let paths: { ca: string; key: string; cert: string };

before(async () => {
  certs = generateCertificates();
  dir = await mkdtemp(join(tmpdir(), "libo11y-tls-"));
  paths = { ca: join(dir, "ca.pem"), key: join(dir, "client.key"), cert: join(dir, "client.pem") };
  await writeFile(paths.ca, certs.ca);
  await writeFile(paths.key, certs.client.key, { mode: 0o600 });
  await writeFile(paths.cert, certs.client.cert);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The common name of the certificate the client presented, where the runtime can tell. */
function peerName(socket: TLSSocket): string | undefined {
  // Bun's node:https server has no getPeerCertificate.
  if (typeof socket.getPeerCertificate !== "function") return undefined;
  const name: unknown = socket.getPeerCertificate()?.subject?.CN;
  return typeof name === "string" ? name : undefined;
}

/** A loopback HTTPS collector that demands a client certificate signed by the test CA. */
async function tlsCollector(): Promise<{
  url: string;
  /** The path and the client certificate's common name of each request served. */
  served: { path: string; client: string | undefined }[];
  close(): Promise<void>;
}> {
  const served: { path: string; client: string | undefined }[] = [];
  const server: HttpsServer = createHttpsServer(
    {
      key: certs.server.key,
      cert: certs.server.cert,
      ca: [certs.ca],
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      req.resume();
      req.on("end", () => {
        served.push({ path: req.url ?? "", client: peerName(req.socket as TLSSocket) });
        res.writeHead(200);
        res.end();
      });
    },
  );
  // A handshake the server refuses is the client's to report: the server only has to survive it.
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `https://127.0.0.1:${port}`,
    served,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

for (const [label, vars] of [
  [
    "the shared variables",
    (): Record<string, string> => ({
      OTEL_EXPORTER_OTLP_CERTIFICATE: paths.ca,
      OTEL_EXPORTER_OTLP_CLIENT_KEY: paths.key,
      OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: paths.cert,
    }),
  ],
  [
    "each signal's own variables",
    (): Record<string, string> =>
      Object.fromEntries(
        ["TRACES", "METRICS", "LOGS"].flatMap((signal) => [
          [`OTEL_EXPORTER_OTLP_${signal}_CERTIFICATE`, paths.ca],
          [`OTEL_EXPORTER_OTLP_${signal}_CLIENT_KEY`, paths.key],
          [`OTEL_EXPORTER_OTLP_${signal}_CLIENT_CERTIFICATE`, paths.cert],
        ]),
      ),
  ],
] as const) {
  test(`TLS: with ${label} every signal is exported over mutual TLS`, async () => {
    const collector = await tlsCollector();
    try {
      const telemetry = await telemetryFor({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.url, ...vars() });
      emit(telemetry);
      const report = await telemetry.shutdown();
      assert.deepEqual(failures(report), []);
      assert.deepEqual(collector.served.map((s) => s.path).sort(), ["/v1/logs", "/v1/metrics", "/v1/traces"]);
      for (const s of collector.served) {
        assert.equal(s.client, CAN_READ_PEER ? certs.clientName : undefined, s.path);
      }
    } finally {
      await collector.close();
    }
  });
}

test("TLS control: without the CA variable the collector's certificate is not trusted, and nothing is sent", async () => {
  const collector = await tlsCollector();
  try {
    const telemetry = await telemetryFor({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      OTEL_EXPORTER_OTLP_CLIENT_KEY: paths.key,
      OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: paths.cert,
      OTEL_EXPORTER_OTLP_TIMEOUT: "500",
    });
    emit(telemetry);
    const report = await telemetry.shutdown();
    assert.deepEqual(
      report.errors.map((e) => e.signal),
      ["logs", "metrics", "traces"],
      failures(report).join("\n"),
    );
    assert.deepEqual(collector.served, []);
  } finally {
    await collector.close();
  }
});

test("TLS control: without the client certificate the collector refuses the connection, and nothing is sent", async () => {
  const collector = await tlsCollector();
  try {
    const telemetry = await telemetryFor({
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      OTEL_EXPORTER_OTLP_CERTIFICATE: paths.ca,
      OTEL_EXPORTER_OTLP_TIMEOUT: "500",
    });
    emit(telemetry);
    const report = await telemetry.shutdown();
    assert.deepEqual(
      report.errors.map((e) => e.signal),
      ["logs", "metrics", "traces"],
      failures(report).join("\n"),
    );
    assert.deepEqual(collector.served, []);
  } finally {
    await collector.close();
  }
});
