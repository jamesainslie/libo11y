/**
 * Probes the two context gaps that need a process of their own: a thenable returned after an await
 * (oven-sh/bun#34266) and an unhandledRejection listener (oven-sh/bun#40223). Prints one JSON object
 * with what each saw: "probe" when the context held, null when it was lost.
 */
import { createContextKey, ROOT_CONTEXT } from "@opentelemetry/api";
import { createContextManager } from "../context.ts";

const KEY = createContextKey("libo11y.test.probe");
const cm = createContextManager();
const ctx = ROOT_CONTEXT.setValue(KEY, "probe");
const seen: Record<string, unknown> = {};

async function thenableAfterAwait(): Promise<unknown> {
  await null;
  return {
    // biome-ignore lint/suspicious/noThenProperty: the gap is about exactly this shape.
    then(resolve: (v: number) => void) {
      seen.thenable = cm.active().getValue(KEY) ?? null;
      resolve(1);
    },
  };
}
await cm.with(ctx, () => thenableAfterAwait());

await new Promise<void>((resolve) => {
  process.once("unhandledRejection", () => {
    seen.unhandledRejection = cm.active().getValue(KEY) ?? null;
    resolve();
  });
  cm.with(ctx, () => {
    void Promise.reject(new Error("probe"));
  });
});

process.stdout.write(`${JSON.stringify(seen)}\n`);
