/**
 * R3f. The test extension's RUM page, an extension page as a side panel or popup would be. It sets
 * nothing up by itself; a spec calls globalThis.__rum in the page to run setupRumExtension with
 * context "page", read the session and flush.
 */
import { views } from "../../../../rum/src/index.ts";
import { type RumExtensionTelemetry, setupRumExtension } from "../../../../rum/src/webext.ts";

document.title = "libo11y RUM extension page";

let telemetry: Promise<RumExtensionTelemetry> | undefined;

function setup(): Promise<RumExtensionTelemetry> {
  telemetry ??= setupRumExtension({
    context: "page",
    serviceName: "fixture-rum-page",
    environment: "test",
    startupSummary: false,
    instrumentations: { fetch: false, xhr: false },
    rum: { collectors: [views()] },
  });
  return telemetry;
}

/** Resolves the session ID once the session has loaded. */
async function sessionId(): Promise<string | undefined> {
  const t = await setup();
  for (let i = 0; i < 100 && t.rum.sessionId() === undefined; i++)
    await new Promise((r) => setTimeout(r, 20));
  return t.rum.sessionId();
}

(globalThis as { __rum?: unknown }).__rum = {
  sessionId,
  flush: async () => (await (await setup()).forceFlush()).ok,
};
