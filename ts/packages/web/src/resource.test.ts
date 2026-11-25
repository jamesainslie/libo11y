import assert from "node:assert/strict";
import { test } from "node:test";
import { SDK_INFO } from "@opentelemetry/core";
import { detectBrowserResource, type NavigatorLike, parseResourceAttributes } from "./resource.ts";

const CHROME: NavigatorLike = {
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0.0.0 Safari/537.36",
  language: "en-GB",
  userAgentData: {
    brands: [
      { brand: "Chromium", version: "140" },
      { brand: "Not=A?Brand", version: "24" },
    ],
    mobile: false,
    platform: "Linux",
  },
};

const NO_ENV = {};

test("the detected layer has telemetry.sdk.* and the browser.* attributes", async () => {
  const { detected, fromEnv } = await detectBrowserResource({
    hermetic: false,
    userAgent: false,
    env: NO_ENV,
    navigator: CHROME,
  });
  assert.equal(detected["telemetry.sdk.name"], SDK_INFO["telemetry.sdk.name"]);
  assert.equal(detected["telemetry.sdk.language"], SDK_INFO["telemetry.sdk.language"]);
  assert.equal(detected["telemetry.sdk.version"], SDK_INFO["telemetry.sdk.version"]);
  assert.deepEqual(detected["browser.brands"], ["Chromium 140", "Not=A?Brand 24"]);
  assert.equal(detected["browser.platform"], "Linux");
  assert.equal(detected["browser.mobile"], false);
  assert.equal(detected["browser.language"], "en-GB");
  assert.deepEqual(fromEnv, {});
});

test("user_agent.original is recorded only with userAgent", async () => {
  const off = await detectBrowserResource({
    hermetic: false,
    userAgent: false,
    env: NO_ENV,
    navigator: CHROME,
  });
  assert.equal("user_agent.original" in off.detected, false);
  const on = await detectBrowserResource({
    hermetic: false,
    userAgent: true,
    env: NO_ENV,
    navigator: CHROME,
  });
  assert.equal(on.detected["user_agent.original"], CHROME.userAgent);
});

test("absent navigator fields are omitted, never empty", async () => {
  const { detected } = await detectBrowserResource({
    hermetic: false,
    userAgent: true,
    env: NO_ENV,
    navigator: { language: "", userAgentData: { brands: [] } },
  });
  for (const key of [
    "browser.brands",
    "browser.platform",
    "browser.mobile",
    "browser.language",
    "user_agent.original",
  ]) {
    assert.equal(key in detected, false, key);
  }
});

test("a navigator without userAgentData (Firefox, Safari) gives only browser.language", async () => {
  const { detected } = await detectBrowserResource({
    hermetic: false,
    userAgent: false,
    env: NO_ENV,
    navigator: { userAgent: "Mozilla/5.0 Firefox/140.0", language: "fr" },
  });
  const browser = Object.keys(detected).filter((k) => k.startsWith("browser."));
  assert.deepEqual(browser, ["browser.language"]);
});

test("nothing that identifies a user or the page is recorded", async () => {
  const { detected } = await detectBrowserResource({
    hermetic: false,
    userAgent: false,
    env: NO_ENV,
    navigator: CHROME,
  });
  const allowed = /^(telemetry\.sdk\.|browser\.(brands|platform|mobile|language)$)/;
  for (const key of Object.keys(detected)) assert.match(key, allowed);
});

test("the environment layer reads OTEL_RESOURCE_ATTRIBUTES, then OTEL_SERVICE_NAME", async () => {
  const { fromEnv } = await detectBrowserResource({
    hermetic: false,
    userAgent: false,
    env: { OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs,team=web", OTEL_SERVICE_NAME: "checkout" },
    navigator: CHROME,
  });
  assert.deepEqual(fromEnv, { "service.name": "checkout", team: "web" });
});

test("an empty OTEL_SERVICE_NAME is ignored", async () => {
  const { fromEnv } = await detectBrowserResource({
    hermetic: false,
    userAgent: false,
    env: { OTEL_RESOURCE_ATTRIBUTES: "service.name=a", OTEL_SERVICE_NAME: "" },
    navigator: CHROME,
  });
  assert.deepEqual(fromEnv, { "service.name": "a" });
});

test("hermetic leaves the environment layer empty", async () => {
  const { detected, fromEnv } = await detectBrowserResource({
    hermetic: true,
    userAgent: false,
    env: { OTEL_RESOURCE_ATTRIBUTES: "team=web", OTEL_SERVICE_NAME: "checkout" },
    navigator: CHROME,
  });
  assert.deepEqual(fromEnv, {});
  assert.equal(detected["browser.platform"], "Linux");
});

test("without a navigator only telemetry.sdk.* is detected", async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true });
  try {
    const { detected } = await detectBrowserResource({ hermetic: true, userAgent: true, env: NO_ENV });
    for (const key of Object.keys(detected)) assert.match(key, /^telemetry\.sdk\./);
  } finally {
    if (nav === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, "navigator", nav);
  }
});

test("the default navigator is globalThis.navigator", async () => {
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: CHROME, configurable: true, writable: true });
  try {
    const { detected } = await detectBrowserResource({ hermetic: true, userAgent: false, env: NO_ENV });
    assert.equal(detected["browser.language"], "en-GB");
  } finally {
    if (nav === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, "navigator", nav);
  }
});

test("parseResourceAttributes splits, trims and percent-decodes", () => {
  assert.deepEqual(parseResourceAttributes(" a = 1 , b=two%20words,c=x%2Cy%3Dz "), {
    a: "1",
    b: "two words",
    c: "x,y=z",
  });
});

test("parseResourceAttributes keeps an = inside a value and an empty value", () => {
  assert.deepEqual(parseResourceAttributes("a=b=c,d="), { a: "b=c", d: "" });
});

test("parseResourceAttributes skips malformed pairs", () => {
  assert.deepEqual(parseResourceAttributes("novalue,=nokey,bad=%E0%A4%A,ok=1,,"), { ok: "1" });
});

test("parseResourceAttributes of nothing is empty", () => {
  assert.deepEqual(parseResourceAttributes(undefined), {});
  assert.deepEqual(parseResourceAttributes(""), {});
  assert.deepEqual(parseResourceAttributes("   "), {});
});

test("parseResourceAttributes lets a later key win", () => {
  assert.deepEqual(parseResourceAttributes("a=1,a=2"), { a: "2" });
});
