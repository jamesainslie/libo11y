import { expect, type Page, test } from "@playwright/test";

interface Named {
  readonly name: string | null;
  readonly selector: string;
  readonly target: string;
  readonly resolves: boolean;
}

async function naming(page: Page, html: string, selector: string): Promise<Named> {
  await page.goto("/page/rum-naming");
  await page.waitForFunction(() => "__naming" in globalThis);
  return page.evaluate(
    ([h, s]) => (globalThis as unknown as { __naming(h: string, s: string): Named }).__naming(h, s),
    [html, selector] as const,
  );
}

test("data-o11y on an ancestor names the action", async ({ page }) => {
  const got = await naming(
    page,
    `<div data-o11y="Sign"><button><span id="in">Sign here</span></button></div>`,
    "#in",
  );
  expect(got.target).toBe("button");
  expect(got.name).toBe("Sign");
});

test("aria-label names a button", async ({ page }) => {
  expect((await naming(page, `<button aria-label="Close dialog">x</button>`, "button")).name).toBe(
    "Close dialog",
  );
});

test("a button with only visible text has no name", async ({ page }) => {
  expect((await naming(page, `<button>Delete Alice's account</button>`, "button")).name).toBeNull();
});

test("data-o11y-mask blocks names", async ({ page }) => {
  const got = await naming(page, `<div data-o11y-mask><button aria-label="Alice">x</button></div>`, "button");
  expect(got.name).toBeNull();
});

test("an ID-like id is not used as a selector", async ({ page }) => {
  const got = await naming(page, `<main><button id="user-12345">x</button></main>`, "button");
  expect(got.selector).not.toContain("12345");
  expect(got.resolves).toBe(true);
});

test("a stable id is the selector", async ({ page }) => {
  expect((await naming(page, `<button id="save">x</button>`, "button")).selector).toBe("#save");
});

test("nth-of-type tells siblings apart", async ({ page }) => {
  const got = await naming(page, `<main><button>a</button><button class="b">b</button></main>`, ".b");
  expect(got.selector).toContain(":nth-of-type(2)");
  expect(got.resolves).toBe(true);
});

test("a click on an svg inside a button targets the button", async ({ page }) => {
  const got = await naming(page, `<button aria-label="Menu"><svg><path id="p"></path></svg></button>`, "#p");
  expect(got.target).toBe("button");
  expect(got.name).toBe("Menu");
});

test("a long name is cut to 64 characters", async ({ page }) => {
  const got = await naming(page, `<button data-o11y="${"x".repeat(100)}">x</button>`, "button");
  expect(got.name?.length).toBe(64);
});
