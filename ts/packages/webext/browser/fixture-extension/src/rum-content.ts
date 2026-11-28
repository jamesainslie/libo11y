/**
 * R3f. The test extension's RUM content script on http://localhost pages. It adds its own UI (a
 * host element with a button) to the page, runs setupRumExtension with context "content" and that
 * UI as uiRoot, and takes commands from the page by window.postMessage, because a spec's
 * page.evaluate runs in the page's world and the content script in its own:
 *
 *   { libo11yRum: "session", id }  { sessionId }, once the session has loaded
 *   { libo11yRum: "flush", id }    { ok }
 *
 * Each answer is posted back as { libo11yRumReply: id, result } or { ..., error }.
 */
import { actions, errors, views } from "../../../../rum/src/index.ts";
import { setupRumExtension } from "../../../../rum/src/webext.ts";

const ui = document.createElement("div");
ui.id = "libo11y-rum-ui";
const button = document.createElement("button");
button.textContent = "Capture";
button.dataset.o11y = "Capture";
ui.append(button);
document.body.append(ui);

const telemetry = setupRumExtension({
  context: "content",
  serviceName: "fixture-rum-content",
  environment: "test",
  startupSummary: false,
  instrumentations: { fetch: false, xhr: false },
  rum: { collectors: [views(), actions(), errors()] },
  content: { uiRoot: ui },
});
telemetry.then(
  () => {
    document.documentElement.dataset.libo11yRum = "ready";
  },
  (err: unknown) => {
    document.documentElement.dataset.libo11yRum = `failed: ${String(err)}`;
  },
);

interface Command {
  readonly libo11yRum: "session" | "flush";
  readonly id: string;
}

async function run(cmd: Command): Promise<unknown> {
  const t = await telemetry;
  switch (cmd.libo11yRum) {
    case "session": {
      for (let i = 0; i < 100 && t.rum.sessionId() === undefined; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      return { sessionId: t.rum.sessionId() };
    }
    case "flush":
      return { ok: (await t.forceFlush()).ok };
  }
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const cmd = event.data as Command | undefined;
  if (typeof cmd?.libo11yRum !== "string") return;
  run(cmd).then(
    (result) => window.postMessage({ libo11yRumReply: cmd.id, result }, "*"),
    (err: unknown) => window.postMessage({ libo11yRumReply: cmd.id, error: String(err) }, "*"),
  );
});
