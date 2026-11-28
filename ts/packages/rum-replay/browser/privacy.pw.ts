import { expect, type Page, test } from "@playwright/test";

interface ReplayState {
  readonly raw: string;
  readonly scrubbed: string;
  readonly types: readonly { readonly type: number; readonly source?: number }[];
}

interface ReplayWindow {
  __replay: { raw: unknown[]; scrubbed: { type: number; data?: { source?: number } }[] };
}

async function state(page: Page): Promise<ReplayState> {
  return page.evaluate(() => {
    const r = (globalThis as unknown as ReplayWindow).__replay;
    return {
      raw: JSON.stringify(r.raw),
      scrubbed: JSON.stringify(r.scrubbed),
      types: r.scrubbed.map((e) => ({
        type: e.type,
        ...(e.data?.source === undefined ? {} : { source: e.data.source }),
      })),
    };
  });
}

/** Every secret the fixture holds or creates. Each must be in the raw rrweb stream. */
const SECRETS = [
  "LeakCss",
  "LeakMaskedInPublic",
  "LeakPlaceholder",
  "LeakValue",
  "LeakData",
  "LeakHandler",
  "LeakMarkup",
  "LeakPlain",
  "LeakAlt",
  "LeakImgTitle",
  "LeakSrc",
  "LeakSrcset",
  "LeakDataUrl",
  "LeakStyle",
  "LeakAria",
  "LeakButton",
  "LeakHref",
  "LeakFrag",
  "LeakLink",
  "LeakTextarea",
  "LeakEditable",
  "LeakSvg",
  "LeakSvgTitle",
  "LeakOptValue",
  "LeakOption",
  "LeakBlocked",
  "LeakShadowMasked",
  "LeakShadowPlain",
  "LeakIframe",
  "LeakIframeMasked",
  "LeakMeta",
  "LeakMutatedText",
  "LeakMutatedTitle",
  "LeakAfterMarkup",
  "LeakAdded",
  "LeakAddedAria",
  "LeakAddedInMask",
  "LeakShadowMutated",
  "LeakShadowMaskedMutated",
  "LeakIframeMutated",
  "LeakIframeMaskedMutated",
  "LeakSrcsetMutated",
  "LeakStyleMutated",
  "LeakPassword",
  "LeakTyped",
  "LeakTextareaTyped",
  "LeakTypedEditable",
  "LeakCustom",
];

test("nothing private survives the scrubber, even with rrweb's own masking off", async ({ page }) => {
  await page.goto("/page/rum-replay-privacy");
  await page.waitForFunction(
    () => (globalThis as unknown as { __replay?: { ready: boolean } }).__replay?.ready === true,
  );
  await page.evaluate(() => (globalThis as unknown as { __replay: { mutate(): void } }).__replay.mutate());
  await page.fill("#pw", "LeakPassword");
  await page.locator("#email").pressSequentially("LeakTyped");
  await page.fill("#ta", "LeakTextareaTyped");
  await page.locator("#editor").click();
  await page.keyboard.type("LeakTypedEditable");
  await page.evaluate(() => (globalThis as unknown as { __replay: { custom(): void } }).__replay.custom());
  await expect
    .poll(async () => {
      const s = await state(page);
      return SECRETS.filter((x) => !s.raw.includes(x));
    })
    .toEqual([]);
  // Mutations are batched; give the last batch time to land in both streams.
  await page.waitForTimeout(200);
  const s = await state(page);
  expect(s.scrubbed).not.toMatch(/leak/i);
  // Text under the code's unmask selector survives, also in shadow DOM under an unmasked host.
  for (const kept of [
    "Public headline",
    "Public update",
    "Public paragraph",
    "Public added",
    "Shadow public",
  ]) {
    expect(s.scrubbed, kept).toContain(kept);
  }
  // No input, custom, plugin, canvas, font or log events.
  expect(
    s.types.filter(
      (t) => t.type >= 5 || t.source === 5 || (t.source !== undefined && t.source >= 9 && t.source <= 11),
    ),
  ).toEqual([]);
  expect(s.types.some((t) => t.type === 2)).toBe(true);
});
