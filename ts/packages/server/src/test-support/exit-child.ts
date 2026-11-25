/**
 * Sets telemetry up against the collector in OTEL_EXPORTER_OTLP_ENDPOINT, emits on every signal,
 * shuts down with the deadline in argv[2], and prints the report as a "RESULT " line. Then it does
 * nothing at all: the process has to end by itself, so anything the telemetry left behind shows as
 * a process that stays up.
 */
import { setup } from "../setup.ts";

const telemetry = await setup({ serviceName: "exit-child", environment: "test", console: false });
telemetry.logger.info("one record");
telemetry.tracerProvider.getTracer("app").startSpan("one span").end();
telemetry.meterProvider.getMeter("app").createCounter("app.jobs").add(1);
const started = performance.now();
const report = await telemetry.shutdown({ timeoutMillis: Number(process.argv[2]) });
const result = {
  shutdownMillis: Math.round(performance.now() - started),
  ok: report.ok,
  signals: report.errors.map((e) => e.signal),
};
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
