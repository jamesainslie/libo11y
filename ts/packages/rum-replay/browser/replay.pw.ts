/**
 * replay() end to end in a real browser: RUM with views(), errors() and replay() uploads scrubbed,
 * self-contained segments to the harness sink, only with consent, and what arrives keeps every
 * privacy rule, also when replayed with @rrweb/replay.
 */
import { expect, type Page, test } from "@playwright/test";
import { logRecords } from "../../rum/browser/harness/page.ts";
import { createSink, type SinkRequest, type TestSink } from "../../web/browser/harness/sink.ts";

interface Envelope {
  readonly format: number;
  readonly recording: string;
  readonly start: number;
  readonly end: number;
  readonly views: readonly { readonly id: string; readonly name: string }[];
  readonly events: readonly { readonly type: number; readonly data?: { readonly source?: number } }[];
}

interface FixtureWindow {
  __rumStart(o: unknown): Promise<void>;
  __rum: { sessionId(): string | undefined };
  __violations: string[];
}

async function start(
  page: Page,
  sink: TestSink,
  o: { consent?: "pending" | "granted"; csp?: "strict" } = {},
): Promise<void> {
  await page.goto(`/page/rum-replay-replay${o.csp === undefined ? "" : `?csp=${o.csp}`}`);
  await page.waitForFunction(() => "__rumStart" in globalThis);
  await page.evaluate((opts) => (globalThis as unknown as FixtureWindow).__rumStart(opts), {
    endpoint: sink.endpoint,
    consent: o.consent ?? "granted",
  });
}

/** Hides the page as a navigation away would, which cuts the open segment and flushes RUM. */
async function hide(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
}

const uploads = (requests: readonly SinkRequest[]): SinkRequest[] =>
  requests.filter((r) => r.signal === "replay");

/** Interacts with every private element: types into the inputs, the textarea and the editor. */
async function interact(page: Page): Promise<void> {
  await page.locator("#email").pressSequentially("typedS3cret");
  await page.fill("#notes", "draftS3cret");
  await page.locator("#editor").click();
  await page.keyboard.type("editorS3cret");
  await page.evaluate(() => {
    const name = document.getElementById("name");
    if (name !== null) name.textContent = "John Roe";
  });
  // rrweb batches mutations; let the batch land before the cut.
  await page.waitForTimeout(200);
}

/** Waits until rrweb has loaded and recorded the first full snapshot: the lazy load is asynchronous. */
async function recording(page: Page): Promise<void> {
  // The recorder is imported when the session starts; give it a moment, then interact.
  await page.waitForTimeout(300);
}

test("a consented session uploads self-contained segments, and errors point at them", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink);
  await recording(page);
  await interact(page);
  await hide(page);
  const got = await sink.waitFor((rs) => uploads(rs).length >= 1);
  const up = uploads(got)[0];
  expect(up).toBeDefined();
  if (up === undefined) return;
  const sessionId = await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.sessionId());
  expect(up.contentType).toBe("application/json");
  expect(up.encoding).toBe("gzip");
  expect(up.query.segment).toBe("0");
  expect(up.query.service).toBe("rum-replay-fixture");
  expect(up.query.session).toBe(sessionId);
  expect(Number(up.query.sent_at)).toBeGreaterThan(0);
  const env = up.body as Envelope;
  expect(env.format).toBe(1);
  expect(env.recording).toMatch(/^[0-9a-f-]{36}$/);
  expect(env.events.slice(0, 2).map((e) => e.type)).toEqual([4, 2]);
  expect(env.views.length).toBeGreaterThan(0);
  expect(env.end).toBeGreaterThanOrEqual(env.start);

  // An error after the first segment was numbered carries its number.
  await page.locator("#boom").click();
  await hide(page);
  const withError = await sink.waitFor((rs) => logRecords(rs).some((l) => l.eventName === "o11y.rum.error"));
  const error = logRecords(withError).find((l) => l.eventName === "o11y.rum.error");
  expect(error?.attributes["o11y.rum.replay.segment"]).toBe(0);
});

test("pending consent records and uploads nothing", async ({ page, request, baseURL }) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink, { consent: "pending" });
  await recording(page);
  await interact(page);
  await hide(page);
  await page.waitForTimeout(2000);
  expect(uploads(await sink.received())).toEqual([]);
});

test("nothing private reaches the gateway, and the replayed page shows only masked text", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink);
  await recording(page);
  await interact(page);
  await hide(page);
  const got = await sink.waitFor((rs) => uploads(rs).length >= 1);
  const envelopes = uploads(got).map((r) => r.body as Envelope);
  const text = JSON.stringify(envelopes);
  expect(text).toContain("Public heading");
  for (const secret of [
    "Jane Doe",
    "John Roe",
    "masked inside",
    "jane@x.test",
    "typedS3cret",
    "draftS3cret",
    "editorS3cret",
    "draft",
    "typed",
    "blocked text",
    "s3cr3t",
  ]) {
    expect(text, secret).not.toContain(secret);
  }
  expect(text).toContain("/asset/a.png?page=1");
  const events = envelopes.flatMap((e) => e.events);
  expect(events.filter((e) => e.type === 3 && e.data?.source === 5)).toEqual([]);
  expect(events.filter((e) => e.type >= 5)).toEqual([]);

  // The first segment alone replays: it starts with its own full snapshot.
  const first = envelopes[0];
  expect(first).toBeDefined();
  const player = await page.context().newPage();
  await player.goto("/page/rum-replay-player");
  await player.waitForFunction(() => "__play" in globalThis);
  const played = await player.evaluate(
    (evs) =>
      (globalThis as unknown as { __play(e: unknown): Promise<Record<string, string | null>> }).__play(evs),
    first?.events ?? [],
  );
  expect(played.heading).toBe("Public heading");
  expect(played.name).toMatch(/^\*+ \*+$/);
  expect(played.masked).toMatch(/^\*+ \*+$/);
  expect(played.email ?? "").not.toContain("jane");
  await player.close();
});

test("a recorded session raises no violation of a strict CSP with Trusted Types", async ({
  page,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await start(page, sink, { csp: "strict" });
  await recording(page);
  await interact(page);
  await hide(page);
  await sink.waitFor((rs) => uploads(rs).length >= 1);
  expect(await page.evaluate(() => (globalThis as unknown as FixtureWindow).__violations)).toEqual([]);
});
