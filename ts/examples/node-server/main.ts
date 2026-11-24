/**
 * A node:http server instrumented with @libo11y/server through a Request and Response adapter. Run
 * it against an OTLP/HTTP collector, under Node 24 or Bun:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=development \
 *   UPSTREAM_URL=http://localhost:8081 PORT=8080 node main.ts
 *
 * setup reads the rest of its configuration from OTEL_* and installs the providers globally, so
 * instrumentServe and instrumentFetch need no telemetry argument. SIGINT or SIGTERM flushes and
 * shuts the telemetry down, then the server closes.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { instrumentFetch, instrumentServe, loadAppRegistry, setup, shutdownOnSignals } from "@libo11y/server";
import { toNodeListener } from "./adapter.ts";
import { createApp, route } from "./app.ts";

const telemetry = await setup({
  serviceName: "example-node-server",
  serviceVersion: "0.0.0",
  registry: await loadAppRegistry(fileURLToPath(new URL("./o11y-registry.yaml", import.meta.url))),
});

const app = createApp({
  fetch: instrumentFetch(fetch, { peerService: "projects-api" }),
  upstream: process.env.UPSTREAM_URL ?? "http://localhost:8081",
  logger: telemetry.logger,
});
const server = createServer(toNodeListener(instrumentServe(app, { route, serverTiming: true })));
await new Promise<void>((resolve) => server.listen(Number(process.env.PORT ?? "8080"), resolve));
telemetry.logger.info("listening", { "server.port": (server.address() as AddressInfo).port });

const report = await shutdownOnSignals(telemetry);
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
if (!report.ok) process.exitCode = 1;
