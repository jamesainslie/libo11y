/**
 * The test extension's page, which the harness opens for CDP sessions and wake messages. It
 * sets nothing up by itself; a spec calls globalThis.__fixture in the page to run
 * setupContentScript here (an extension page) and to grant or revoke consent for the extension.
 */
import * as webext from "@libo11y/webext";

document.title = "libo11y test extension page";

let telemetry: Promise<webext.ContentScriptTelemetry> | undefined;

function setup(): Promise<webext.ContentScriptTelemetry> {
  telemetry ??= webext.setupContentScript({
    serviceName: "fixture-page",
    environment: "test",
    startupSummary: false,
    instrumentations: { fetch: false, xhr: false, documentLoad: false },
  });
  return telemetry;
}

(globalThis as { __fixture?: unknown }).__fixture = {
  setup: async () => (await setup()).consent.state(),
  grant: async () => (await setup()).consent.grant(),
  revoke: async () => {
    const h = await setup();
    await h.consent.revoke();
    return h.consent.state();
  },
  state: async () => (await setup()).consent.state(),
};
