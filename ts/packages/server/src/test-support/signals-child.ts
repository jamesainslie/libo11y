/**
 * A process that waits for a signal with shutdownOnSignals, prints the shutdown report, and then
 * stays alive, so the parent can check that a second signal gets the default handling.
 */
import { createTelemetryWith } from "@libo11y/core";
import { serverPlatform } from "../platform.ts";
import { shutdownOnSignals } from "../signals.ts";

const telemetry = await createTelemetryWith(
  {
    serviceName: "signals-child",
    environment: "test",
    hermetic: true,
    console: false,
    runtimeMetrics: false,
  },
  serverPlatform(),
);
const keepAlive = setInterval(() => {}, 1000);
const done = shutdownOnSignals(telemetry);
process.stdout.write("ready\n");
const report = await done;
process.stdout.write(`report ${JSON.stringify(report)}\n`);
// Stay up until the parent's second signal ends the process.
void keepAlive;
