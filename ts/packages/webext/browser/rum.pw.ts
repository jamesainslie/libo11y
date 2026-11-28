/**
 * R3f. @libo11y/rum in a real Manifest V3 extension: an extension page and a content script share
 * one session through chrome.storage.session, the content script's spans name the host page only by
 * url.domain, and a click on the host page outside the content script's UI root records no action.
 *
 * Chromium only: Playwright cannot load MV3 extensions in Firefox or WebKit, so this suite runs in
 * the webext project with the other extension specs.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { createSink, type SinkRequest } from "../../web/browser/harness/sink.ts";
import { expect, sendFromExtensionPage, test } from "./harness/fixtures.ts";

interface RumPage {
  sessionId(): Promise<string | undefined>;
  flush(): Promise<boolean>;
}

type Attr = { key: string; value: { stringValue?: string } };

interface SpanSeen {
  readonly name: string;
  readonly service: string | undefined;
  readonly attributes: Record<string, string | undefined>;
}

function spansOf(requests: readonly SinkRequest[]): SpanSeen[] {
  return requests
    .filter((r) => r.signal === "traces")
    .flatMap((r) =>
      ((r.body as { resourceSpans?: unknown[] }).resourceSpans ?? []).flatMap((rs) => {
        const { resource, scopeSpans } = rs as {
          resource?: { attributes?: Attr[] };
          scopeSpans?: { spans?: { name: string; attributes?: Attr[] }[] }[];
        };
        const service = resource?.attributes?.find((a) => a.key === "service.name")?.value.stringValue;
        return (scopeSpans ?? []).flatMap((ss) =>
          (ss.spans ?? []).map((s) => ({
            name: s.name,
            service,
            attributes: Object.fromEntries((s.attributes ?? []).map((a) => [a.key, a.value.stringValue])),
          })),
        );
      }),
    );
}

async function openRumPage(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/rum-page.html`);
  return page;
}

async function pageSession(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (globalThis as unknown as { __rum: RumPage }).__rum.sessionId());
}

/** Opens a page on the localhost origin, where the RUM content script runs, and waits for it. */
async function openHostPage(context: BrowserContext, baseURL: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${baseURL.replace("127.0.0.1", "localhost")}/page/webext-rum-host?secret=1`);
  await expect(page.locator("html")).toHaveAttribute("data-libo11y-rum", "ready");
  return page;
}

/** Runs a command in the RUM content script, through window.postMessage. */
async function command<R>(page: Page, name: "session" | "flush"): Promise<R> {
  const reply = await page.evaluate(
    (n) =>
      new Promise<{ result?: unknown; error?: string }>((resolve) => {
        const id = Math.random().toString(36).slice(2);
        const on = (e: MessageEvent) => {
          const d = e.data as { libo11yRumReply?: string; result?: unknown; error?: string };
          if (d?.libo11yRumReply !== id) return;
          window.removeEventListener("message", on);
          resolve(d);
        };
        window.addEventListener("message", on);
        window.postMessage({ libo11yRum: n, id }, "*");
      }),
    name,
  );
  if (reply.error !== undefined) throw new Error(`content script: ${reply.error}`);
  return reply.result as R;
}

test("an extension page and a content script share one session", async ({
  context,
  extensionId,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  expect(
    await sendFromExtensionPage(context, extensionId, {
      type: "fixture-configure",
      config: { endpoint: sink.endpoint, consent: "granted" },
    }),
  ).toEqual({ ok: true });
  const panel = await openRumPage(context, extensionId);
  const id = await pageSession(panel);
  expect(id).toBeTruthy();
  const host = await openHostPage(context, baseURL ?? "");
  const { sessionId } = await command<{ sessionId?: string }>(host, "session");
  expect(sessionId).toBe(id);
});

test("the content script names the host only by url.domain and records actions only in its UI", async ({
  context,
  extensionId,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  expect(
    await sendFromExtensionPage(context, extensionId, {
      type: "fixture-configure",
      config: { endpoint: sink.endpoint, consent: "granted" },
    }),
  ).toEqual({ ok: true });
  const host = await openHostPage(context, baseURL ?? "");
  await command(host, "session");
  // A click on the host page, outside the content script's UI, then one on its own button.
  await host.evaluate(() => document.body.click());
  await host.click("#libo11y-rum-ui button");
  await host.waitForTimeout(300);
  expect(await command<{ ok: boolean }>(host, "flush")).toEqual({ ok: true });
  await sendFromExtensionPage(context, extensionId, { type: "fixture-flush" });

  const got = await sink.waitFor((rs) => {
    const names = spansOf(rs)
      .filter((s) => s.service === "fixture-rum-content")
      .map((s) => s.name);
    return names.includes("view content-script") && names.includes("action click");
  });
  const content = spansOf(got).filter((s) => s.service === "fixture-rum-content");
  const view = content.find((s) => s.name === "view content-script");
  expect(view?.attributes["url.domain"]).toBe("localhost");
  expect(view?.attributes["o11y.rum.platform"]).toBe("webext");
  const clicks = content.filter((s) => s.name === "action click");
  expect(clicks).toHaveLength(1);
  expect(clicks[0]?.attributes["o11y.rum.action.name"]).toBe("Capture");
  for (const s of content) {
    expect(s.attributes["url.full"] ?? "").not.toContain("webext-rum-host");
    expect(s.attributes["url.path"]).toBeUndefined();
  }
});
