/**
 * WP5. The test extension's content script on http://127.0.0.1 pages. It marks the page (the
 * harness spec checks the mark), runs setupContentScript, and takes commands from the page by
 * window.postMessage, because a spec's page.evaluate runs in the page's world and the content
 * script in its own:
 *
 *   { libo11yFixture: "span", id, name, child? }  a span named name, a log inside it and, with
 *                                                  child, a traced message the worker answers
 *                                                  with a child span; then a flush.
 *                                                  { traceId, spanId, child?, flushed }
 *   { libo11yFixture: "consent", id }              { state }
 *   { libo11yFixture: "revoke", id }               revokes, then { state }
 *
 * Each answer is posted back as { libo11yFixtureReply: id, result } or { ..., error }.
 */
import * as webext from "@libo11y/webext";

document.documentElement.dataset.libo11yContent = "loaded";

const telemetry = webext.setupContentScript({
  serviceName: "fixture-content",
  environment: "test",
  startupSummary: false,
  instrumentations: { fetch: false, xhr: false },
});
telemetry.then(
  () => {
    document.documentElement.dataset.libo11yTelemetry = "ready";
  },
  (err: unknown) => {
    document.documentElement.dataset.libo11yTelemetry = `failed: ${String(err)}`;
  },
);

interface Command {
  readonly libo11yFixture: "span" | "consent" | "revoke";
  readonly id: string;
  readonly name?: string;
  readonly child?: boolean;
}

async function run(cmd: Command): Promise<unknown> {
  const h = await telemetry;
  switch (cmd.libo11yFixture) {
    case "span": {
      const tracer = h.tracerProvider.getTracer("fixture");
      const name = cmd.name ?? "content-op";
      const { ids, child } = tracer.startActiveSpan(name, (span) => {
        h.logger.info(`${name} log`);
        const sent = cmd.child === true ? h.sendMessage({ op: "child", name: `${name}-child` }) : undefined;
        span.end();
        return { ids: span.spanContext(), child: sent };
      });
      const childIds = await child;
      const report = await h.forceFlush();
      return { traceId: ids.traceId, spanId: ids.spanId, child: childIds, flushed: report.ok };
    }
    case "consent":
      return { state: h.consent.state() };
    case "revoke":
      await h.consent.revoke();
      return { state: h.consent.state() };
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const cmd = event.data as Command | undefined;
  if (typeof cmd?.libo11yFixture !== "string") return;
  run(cmd).then(
    (result) => window.postMessage({ libo11yFixtureReply: cmd.id, result }, "*"),
    (err: unknown) => window.postMessage({ libo11yFixtureReply: cmd.id, error: String(err) }, "*"),
  );
});
