/**
 * A Bun.serve app instrumented with @libo11y/server. Run it against an OTLP/HTTP collector:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *   OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=development \
 *   UPSTREAM_URL=http://localhost:8081 PORT=8080 bun main.ts
 *
 * setup reads the rest of its configuration from OTEL_* and installs the providers globally, so
 * instrumentServe and instrumentFetch need no telemetry argument. On SIGINT or SIGTERM the server
 * stops first, letting requests in flight finish, and then the telemetry flushes and shuts down,
 * so those requests' spans and metrics are exported.
 */
import { fileURLToPath } from "node:url";
import { instrumentFetch, instrumentServe, loadAppRegistry, setup, shutdownOnSignals } from "@libo11y/server";
import { createApp, route } from "./app.ts";

const telemetry = await setup({
  serviceName: "example-bun-server",
  serviceVersion: "0.0.0",
  registry: await loadAppRegistry(fileURLToPath(new URL("./o11y-registry.yaml", import.meta.url))),
});

const app = createApp({
  fetch: instrumentFetch(fetch, { peerService: "projects-api" }),
  upstream: process.env.UPSTREAM_URL ?? "http://localhost:8081",
  logger: telemetry.logger,
});
const server = Bun.serve({
  port: Number(process.env.PORT ?? "8080"),
  fetch: instrumentServe(app, { route, serverTiming: true }),
});
telemetry.logger.info("listening", { "server.port": server.port ?? 0 });

const report = await shutdownOnSignals(telemetry, { beforeShutdown: () => server.stop() });
if (!report.ok) process.exitCode = 1;
