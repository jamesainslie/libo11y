/**
 * WP5. @libo11y/webext in a real extension: content script records reach the sink through the
 * worker, trace context crosses runtime messages, a batch persisted before the worker stops is sent
 * by the next wake (also when the stop cut off its send and left it leased), and consent is one
 * state for the whole extension.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { BrowserContext, Page } from "@playwright/test";
import { createSink, type SinkRequest } from "../../web/browser/harness/sink.ts";
import { expect, sendFromExtensionPage, stopServiceWorker, test } from "./harness/fixtures.ts";

// The extension API, inside page.evaluate callbacks that run in the extension page.
declare const chrome: {
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
};

interface FixtureConfig {
  readonly endpoint: string;
  readonly consent?: "pending" | "granted" | "denied";
  readonly timeoutMillis?: number;
}

/** A port Chromium refuses to connect to (ERR_UNSAFE_PORT), so every export fails at once. */
const UNREACHABLE = "http://127.0.0.1:9";

/** A collector that takes every request and never answers it, so each attempt stays on the wire. */
interface HangingCollector {
  readonly endpoint: string;
  /** The paths of the requests received so far, in arrival order. */
  readonly paths: string[];
  close(): Promise<void>;
}

async function hangingCollector(): Promise<HangingCollector> {
  const paths: string[] = [];
  const server = createServer((req) => {
    paths.push(req.url ?? "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

interface StoredEntry {
  readonly signal: string;
  readonly leaseUntil: number;
}

/**
 * The entries of the worker's IndexedDB queue and the browser's clock, read from an extension page,
 * which shares the worker's origin and does not wake it.
 */
async function storedEntries(
  context: BrowserContext,
  extensionId: string,
): Promise<{ now: number; entries: StoredEntry[] }> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/page.html`);
    return await page.evaluate(
      () =>
        new Promise<{ now: number; entries: StoredEntry[] }>((resolve, reject) => {
          const open = indexedDB.open("libo11y");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            const all = db.transaction("otlp-batches", "readonly").objectStore("otlp-batches").getAll();
            all.onsuccess = () => {
              db.close();
              const rows = all.result as StoredEntry[];
              resolve({
                now: Date.now(),
                entries: rows.map((e) => ({ signal: e.signal, leaseUntil: e.leaseUntil })),
              });
            };
            all.onerror = () => {
              db.close();
              reject(all.error);
            };
          };
        }),
    );
  } finally {
    await page.close();
  }
}

interface SpanSeen {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly service: string | undefined;
}

type Attr = { key: string; value: { stringValue?: string } };

function serviceOf(resource: { attributes?: Attr[] } | undefined): string | undefined {
  return resource?.attributes?.find((a) => a.key === "service.name")?.value.stringValue;
}

function spansOf(requests: readonly SinkRequest[]): SpanSeen[] {
  return requests
    .filter((r) => r.signal === "traces")
    .flatMap((r) =>
      ((r.body as { resourceSpans?: unknown[] }).resourceSpans ?? []).flatMap((rs) => {
        const { resource, scopeSpans } = rs as {
          resource?: { attributes?: Attr[] };
          scopeSpans?: {
            spans?: { name: string; traceId: string; spanId: string; parentSpanId?: string }[];
          }[];
        };
        return (scopeSpans ?? []).flatMap((ss) =>
          (ss.spans ?? []).map((s) => ({
            name: s.name,
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId ?? "",
            service: serviceOf(resource),
          })),
        );
      }),
    );
}

function logTextOf(requests: readonly SinkRequest[]): string {
  return requests
    .filter((r) => r.signal === "logs")
    .map((r) => JSON.stringify(r.body))
    .join("\n");
}

async function configure(context: BrowserContext, extensionId: string, config: FixtureConfig): Promise<void> {
  expect(await sendFromExtensionPage(context, extensionId, { type: "fixture-configure", config })).toEqual({
    ok: true,
  });
}

/** Stores a configuration for the next wake without waking the worker. */
async function storeConfig(
  context: BrowserContext,
  extensionId: string,
  config: FixtureConfig,
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/page.html`);
    await page.evaluate((c) => chrome.storage.local.set({ "fixture.config": c }), config);
  } finally {
    await page.close();
  }
}

async function workerQueueEntries(context: BrowserContext, extensionId: string): Promise<number> {
  const reply = (await sendFromExtensionPage(context, extensionId, { type: "fixture-queue" })) as {
    entries: number;
  };
  return reply.entries;
}

async function openContentPage(context: BrowserContext, baseURL: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${baseURL}/page/webext-content`);
  await expect(page.locator("html")).toHaveAttribute("data-libo11y-telemetry", "ready");
  return page;
}

/** Runs a fixture command in the content script, through window.postMessage. */
async function command<R>(page: Page, cmd: Record<string, unknown>): Promise<R> {
  const reply = await page.evaluate(
    (c) =>
      new Promise<{ result?: unknown; error?: string }>((resolve) => {
        const id = Math.random().toString(36).slice(2);
        const on = (e: MessageEvent) => {
          const d = e.data as { libo11yFixtureReply?: string; result?: unknown; error?: string };
          if (d?.libo11yFixtureReply !== id) return;
          window.removeEventListener("message", on);
          resolve(d);
        };
        window.addEventListener("message", on);
        window.postMessage({ ...c, id }, "*");
      }),
    cmd,
  );
  if (reply.error !== undefined) throw new Error(`content script: ${reply.error}`);
  return reply.result as R;
}

interface SpanResult {
  readonly traceId: string;
  readonly spanId: string;
  readonly child?: { traceId: string; spanId: string };
  readonly flushed: boolean;
}

test("a content script's span and log reach the sink through the worker, and its context crosses", async ({
  context,
  extensionId,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await configure(context, extensionId, { endpoint: sink.endpoint, consent: "granted" });
  const page = await openContentPage(context, baseURL ?? "");

  const op = await command<SpanResult>(page, { libo11yFixture: "span", name: "content-op", child: true });
  expect(op.flushed).toBe(true);
  expect(op.child?.traceId).toBe(op.traceId);

  const got = await sink.waitFor((rs) => {
    const names = spansOf(rs).map((s) => s.name);
    return (
      names.includes("content-op") &&
      names.includes("content-op-child") &&
      /content-op log/.test(logTextOf(rs))
    );
  });
  const spans = spansOf(got);
  const parent = spans.find((s) => s.name === "content-op");
  const child = spans.find((s) => s.name === "content-op-child");
  expect(parent).toMatchObject({ traceId: op.traceId, spanId: op.spanId, service: "fixture-content" });
  expect(child).toMatchObject({ traceId: op.traceId, parentSpanId: op.spanId, service: "fixture-worker" });
  // Every batch left from the worker, on the extension's origin.
  for (const r of got) expect(r.origin).toBe(`chrome-extension://${extensionId}`);
  expect(logTextOf(got)).toContain(op.traceId);
});

test("a batch persisted before the worker stops is sent by the next wake", async ({
  context,
  extensionId,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await configure(context, extensionId, { endpoint: UNREACHABLE, consent: "granted" });
  const page = await openContentPage(context, baseURL ?? "");
  const op = await command<SpanResult>(page, { libo11yFixture: "span", name: "persisted" });
  expect(op.flushed).toBe(true);
  // The worker answered only once the batch was in its IndexedDB queue.
  expect(await workerQueueEntries(context, extensionId)).toBeGreaterThan(0);

  // Stored before the stop, so a wake the open content page causes also finds the sink. The
  // running worker keeps the configuration it set up with.
  await storeConfig(context, extensionId, { endpoint: sink.endpoint, consent: "granted" });
  await stopServiceWorker(context, extensionId);
  expect(await sendFromExtensionPage(context, extensionId, { type: "wake" })).toEqual({ wakes: 2 });

  const got = await sink.waitFor((rs) => spansOf(rs).some((s) => s.name === "persisted"));
  expect(spansOf(got).find((s) => s.name === "persisted")).toMatchObject({
    traceId: op.traceId,
    spanId: op.spanId,
    service: "fixture-content",
  });
  await expect.poll(() => workerQueueEntries(context, extensionId)).toBe(0);
});

test("a batch whose send the stop cut off is sent by the next wake, without waiting out its lease", async ({
  context,
  extensionId,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  const collector = await hangingCollector();
  try {
    // A 20 s timeout gives a 60 s lease, and keeps the attempt on the wire until the stop.
    await configure(context, extensionId, {
      endpoint: collector.endpoint,
      consent: "granted",
      timeoutMillis: 20_000,
    });
    const page = await openContentPage(context, baseURL ?? "");
    const op = await command<SpanResult>(page, { libo11yFixture: "span", name: "cut-off" });
    expect(op.flushed).toBe(true);
    // The drain sends one entry at a time, so the first batch on the wire holds up the rest.
    await expect.poll(() => collector.paths.length).toBeGreaterThan(0);
    const onTheWire = /^\/v1\/(traces|logs|metrics)$/.exec(collector.paths[0] ?? "")?.[1];

    // The next wake finds the sink; storing it first means no wake can start on the collector.
    await storeConfig(context, extensionId, { endpoint: sink.endpoint, consent: "granted" });
    await stopServiceWorker(context, extensionId);
    const { now, entries } = await storedEntries(context, extensionId);
    const cut = entries.find((e) => e.signal === onTheWire);
    expect(cut?.leaseUntil ?? 0, `the ${onTheWire} batch the stop cut off is still leased`).toBeGreaterThan(
      now + 30_000,
    );

    expect(await sendFromExtensionPage(context, extensionId, { type: "wake" })).toEqual({ wakes: 2 });
    const got = await sink.waitFor(
      (rs) => spansOf(rs).some((s) => s.name === "cut-off") && /cut-off log/.test(logTextOf(rs)),
    );
    expect(spansOf(got).find((s) => s.name === "cut-off")).toMatchObject({
      traceId: op.traceId,
      spanId: op.spanId,
    });
    await expect.poll(() => workerQueueEntries(context, extensionId)).toBe(0);
  } finally {
    await collector.close();
  }
});

test("a grant in the extension page enables the content script", async ({
  context,
  extensionId,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await configure(context, extensionId, { endpoint: sink.endpoint, consent: "pending" });
  const page = await openContentPage(context, baseURL ?? "");
  expect(await command<{ state: string }>(page, { libo11yFixture: "consent" })).toEqual({ state: "pending" });
  await command<SpanResult>(page, { libo11yFixture: "span", name: "before-grant" });

  const extPage = await context.newPage();
  await extPage.goto(`chrome-extension://${extensionId}/page.html`);
  expect(
    await extPage.evaluate(() =>
      (globalThis as unknown as { __fixture: { grant(): Promise<string> } }).__fixture.grant(),
    ),
  ).toBe("granted");

  await expect
    .poll(async () => (await command<{ state: string }>(page, { libo11yFixture: "consent" })).state)
    .toBe("granted");
  expect(await sendFromExtensionPage(context, extensionId, { type: "fixture-consent" })).toEqual({
    state: "granted",
  });
  await command<SpanResult>(page, { libo11yFixture: "span", name: "after-grant" });

  const got = await sink.waitFor((rs) => spansOf(rs).some((s) => s.name === "after-grant"));
  expect(spansOf(got).map((s) => s.name)).not.toContain("before-grant");
});

test("a revoke in a content script clears the worker's queue", async ({
  context,
  extensionId,
  request,
  baseURL,
}) => {
  const sink = createSink(request, baseURL ?? "");
  await configure(context, extensionId, { endpoint: UNREACHABLE, consent: "granted" });
  const page = await openContentPage(context, baseURL ?? "");
  await command<SpanResult>(page, { libo11yFixture: "span", name: "revoked-backlog" });
  expect(await workerQueueEntries(context, extensionId)).toBeGreaterThan(0);

  expect(await command<{ state: string }>(page, { libo11yFixture: "revoke" })).toEqual({ state: "denied" });
  await expect.poll(() => workerQueueEntries(context, extensionId)).toBe(0);
  expect(await sendFromExtensionPage(context, extensionId, { type: "fixture-consent" })).toEqual({
    state: "denied",
  });

  // A fresh worker pointed at the sink keeps the stored denial and has nothing left to send.
  await stopServiceWorker(context, extensionId);
  await storeConfig(context, extensionId, { endpoint: sink.endpoint, consent: "granted" });
  await sendFromExtensionPage(context, extensionId, { type: "wake" });
  await expect
    .poll(
      async () => (await sendFromExtensionPage(context, extensionId, { type: "fixture-consent" })) as unknown,
    )
    .toEqual({ state: "denied" });
  await page.waitForTimeout(1500);
  expect(spansOf(await sink.received()).map((s) => s.name)).not.toContain("revoked-backlog");
});
