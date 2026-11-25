/**
 * WP2. The persistent queue over Chromium's IndexedDB: openQueue picks IndexedDB, entries survive
 * a reload, and two pages of one origin claim disjoint entries.
 */
import { expect, type Page, test } from "@playwright/test";
import type { QueuePage } from "./fixtures/queue-page.ts";

type Q = { __queue?: QueuePage };

async function load(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("/page/queue-page");
  await page.waitForFunction(() => (globalThis as Q).__queue !== undefined);
  expect(errors).toEqual([]);
}

test("openQueue gives the IndexedDB queue in Chromium", async ({ page }) => {
  await load(page);
  const kind = await page.evaluate(() => (globalThis as Q).__queue?.open("libo11y"));
  expect(kind).toBe("indexeddb");
});

test("a real IndexedDB queue survives a reload", async ({ page }) => {
  await load(page);
  await page.evaluate(async () => {
    const q = (globalThis as Q).__queue as QueuePage;
    await q.openIndexedDb("reload");
    await q.put({ signal: "traces", body: '{"resourceSpans":[]}' });
    await q.put({ signal: "logs", body: '{"resourceLogs":[]}', notBefore: Date.now() + 60_000 });
  });
  await page.reload();
  await page.waitForFunction(() => (globalThis as Q).__queue !== undefined);
  const after = await page.evaluate(async () => {
    const q = (globalThis as Q).__queue as QueuePage;
    await q.openIndexedDb("reload");
    return { size: await q.size(), claimed: (await q.claim(10, 1000)).map((e) => e.signal) };
  });
  expect(after.size.entries).toBe(2);
  expect(after.claimed).toEqual(["traces"]);
});

test("two pages of one origin claim disjoint entries", async ({ context }) => {
  const a = await context.newPage();
  const b = await context.newPage();
  await Promise.all([load(a), load(b)]);
  await a.evaluate(async () => {
    const q = (globalThis as Q).__queue as QueuePage;
    await q.openIndexedDb("tabs");
    for (let i = 0; i < 40; i++) await q.put({ signal: "metrics", body: `{"n":${i}}` });
  });
  await b.evaluate(() => (globalThis as Q).__queue?.openIndexedDb("tabs"));
  const claim = (p: Page) =>
    p.evaluate(async () => {
      const q = (globalThis as Q).__queue as QueuePage;
      const ids: string[] = [];
      for (let round = 0; round < 10; round++) {
        for (const e of await q.claim(3, 60_000)) ids.push(e.id);
      }
      return ids;
    });
  const [fromA, fromB] = await Promise.all([claim(a), claim(b)]);
  const all = [...fromA, ...fromB];
  expect(all.length).toBe(40);
  expect(new Set(all).size).toBe(40);
  expect(fromA.length).toBeGreaterThan(0);
  expect(fromB.length).toBeGreaterThan(0);
});
