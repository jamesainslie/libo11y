/**
 * Runs one context-manager scenario in a process of its own, so the global context manager starts
 * empty and nothing the scenario installs reaches the test runner. Prints one JSON object of named
 * observations: true when the global context manager carried a context through context.with.
 *
 *   ordered      two recorders, shut down in creation order
 *   reversed     two recorders, shut down in reverse order
 *   preexisting  a manager registered before any recorder, which the recorders must leave alone
 *   replaced     the recorder's manager replaced by another before the last recorder shuts down
 *   again        a recorder after the last one shut down installs a manager again
 *   rejected     the last recorder's telemetry shutdown rejects, which still releases the manager
 */

import { context, createContextKey, ROOT_CONTEXT } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createRecorder } from "../recorder.ts";

const PROBE = createContextKey("libo11y.test.child-probe");

function works(): boolean {
  const ctx = ROOT_CONTEXT.setValue(PROBE, true);
  return context.with(ctx, () => context.active() === ctx);
}

/** Whether manager itself is the global: only then does its own with change context.active(). */
function isGlobal(manager: AsyncLocalStorageContextManager): boolean {
  const ctx = ROOT_CONTEXT.setValue(PROBE, "mine");
  return manager.with(ctx, () => context.active() === ctx);
}

const seen: Record<string, boolean> = {};

switch (process.argv[2]) {
  case "ordered":
  case "reversed": {
    seen.before = works();
    const a = await createRecorder();
    const b = await createRecorder();
    seen.both = works();
    const [first, second] = process.argv[2] === "ordered" ? [a, b] : [b, a];
    await first.shutdown();
    seen.afterFirst = works();
    await second.shutdown();
    seen.afterLast = works();
    break;
  }
  case "preexisting": {
    const mine = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(mine);
    const a = await createRecorder();
    const b = await createRecorder();
    await a.shutdown();
    await b.shutdown();
    seen.stillGlobal = isGlobal(mine);
    seen.afterLast = works();
    break;
  }
  case "replaced": {
    const a = await createRecorder();
    context.disable();
    const other = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(other);
    await a.shutdown();
    seen.stillGlobal = isGlobal(other);
    seen.afterLast = works();
    break;
  }
  case "again": {
    const a = await createRecorder();
    await a.shutdown();
    seen.afterFirst = works();
    const b = await createRecorder();
    seen.again = works();
    await b.shutdown();
    seen.afterLast = works();
    break;
  }
  case "rejected": {
    const a = await createRecorder();
    const telemetry = a.telemetry as { shutdown: typeof a.telemetry.shutdown };
    const real = telemetry.shutdown.bind(a.telemetry);
    telemetry.shutdown = () => Promise.reject(new Error("exporter wedged"));
    seen.rejected = await a.shutdown().then(
      () => false,
      () => true,
    );
    seen.afterLast = works();
    await real();
    break;
  }
  default:
    throw new Error(`unknown scenario ${process.argv[2]}`);
}
process.stdout.write(`${JSON.stringify(seen)}\n`);
