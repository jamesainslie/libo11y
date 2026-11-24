/**
 * Runs one setup scenario in a process of its own, so setup's globals never reach the test runner.
 * The console sink writes to stdout; the scenario's result is the last line, prefixed "RESULT ".
 *
 *   triangle  setup, then a span with a log and a histogram value inside it, then shutdown
 *   disabled  setup and a log line under OTEL_SDK_DISABLED=true, then shutdown
 *   twice     setup, a second setup, shutdown, setup again, shutdown
 */

import { setTimeout as sleep } from "node:timers/promises";
import { O11yError } from "@libo11y/core";
import { metrics, trace } from "@opentelemetry/api";
import { setup } from "../setup.ts";

const OPTIONS = { serviceName: "setup-child", environment: "test" } as const;
const result: Record<string, unknown> = {};

switch (process.argv[2]) {
  case "triangle": {
    const telemetry = await setup({ ...OPTIONS, serviceVersion: "1.2.3" });
    trace.getTracer("app").startActiveSpan("GET /items", (span) => {
      result.traceId = span.spanContext().traceId;
      telemetry.logger.info("listing items", { "app.count": 3 });
      metrics.getMeterProvider().getMeter("app").createHistogram("app.latency", { unit: "s" }).record(0.125);
      span.end();
    });
    // Core stops runtime metrics before the final collection, so let a periodic export observe them.
    await sleep(Number(process.env.SETUP_CHILD_WAIT_MILLIS ?? "0"));
    result.report = await telemetry.shutdown();
    break;
  }
  case "disabled": {
    const telemetry = await setup(OPTIONS);
    telemetry.logger.info("still on the console");
    result.report = await telemetry.shutdown();
    break;
  }
  case "twice": {
    const first = await setup(OPTIONS);
    try {
      await setup(OPTIONS);
      result.second = "ok";
    } catch (err) {
      result.second = err instanceof O11yError ? err.code : String(err);
    }
    await first.shutdown();
    const again = await setup(OPTIONS);
    result.again = (await again.shutdown()).ok;
    break;
  }
  default:
    throw new Error(`unknown scenario ${process.argv[2]}`);
}
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
