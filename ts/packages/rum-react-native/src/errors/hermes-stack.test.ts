import assert from "node:assert/strict";
import { test } from "node:test";
import { BUNDLE_URLS, bundleUrlOf, mapHermesStack } from "./hermes-stack.ts";

const A = BUNDLE_URLS.android ?? "";
const I = BUNDLE_URLS.ios ?? "";

test("the fixed bundle URLs per platform", () => {
  assert.deepEqual(
    { ...BUNDLE_URLS },
    { ios: "app:///main.jsbundle", android: "app:///index.android.bundle" },
  );
  assert.equal(bundleUrlOf("ios"), I);
  assert.equal(bundleUrlOf("android"), A);
  assert.equal(bundleUrlOf("web"), undefined);
  assert.equal(bundleUrlOf("toString"), undefined, "only the platforms' own keys");
});

test("bytecode frames: the bundle URL, no 'address at', and the offset as a 1-based column", () => {
  const raw = [
    "TypeError: undefined is not a function",
    "    at boom (address at /data/user/0/ing.o11y.fixture/files/.expo-internal/7f3a2b:1:413)",
    "    at anonymous (address at index.android.bundle:1:90)",
    "    at p13 (address at p13.hbc:1:0)",
  ].join("\n");
  assert.equal(
    mapHermesStack(raw, A),
    [
      "TypeError: undefined is not a function",
      `    at boom (${A}:1:414)`,
      `    at anonymous (${A}:1:91)`,
      `    at p13 (${A}:1:1)`,
    ].join("\n"),
  );
});

test("an OTA bundle under the iOS documents directory and an embedded bundle in the app container", () => {
  const raw = [
    "Error: x",
    "    at a (address at /var/mobile/Containers/Data/Application/0F/Documents/.expo-internal/b1c2.hbc:1:20)",
    "    at b (address at /private/var/containers/Bundle/Application/AB/Fixture.app/main.jsbundle:1:3)",
    "    at c (address at file:///data/app/x/base.apk!/assets/index.android.bundle:1:9)",
  ].join("\n");
  assert.equal(
    mapHermesStack(raw, I),
    ["Error: x", `    at a (${I}:1:21)`, `    at b (${I}:1:4)`, `    at c (${I}:1:10)`].join("\n"),
  );
});

test("frames with source positions in the app bundle keep their numbers", () => {
  const raw = "Error: x\n    at f (/var/containers/Bundle/Application/ABC/App.app/main.jsbundle:1:2345)";
  assert.equal(mapHermesStack(raw, I), `Error: x\n    at f (${I}:1:2345)`);
});

test("development server, native and internal frames are left alone", () => {
  const raw = [
    "Error: dev",
    "    at f (http://10.0.2.2:8081/index.bundle?platform=android&dev=true:120:5)",
    "    at g (native)",
    "    at h (InternalBytecode.js:1:1234)",
    "    at i (address at InternalBytecode.js:1:1234)",
    "    at Array.map (<anonymous>)",
    "    at j (https://cdn.test/app.js:3:4)",
  ].join("\n");
  assert.equal(mapHermesStack(raw, A), raw);
});

test("a frame without a function name, async and constructor frames", () => {
  assert.equal(mapHermesStack("E\n    at address at /x/main.jsbundle:1:7", I), `E\n    at ${I}:1:8`);
  assert.equal(
    mapHermesStack(
      "E\n    at async load (address at /x/main.jsbundle:1:7)\n    at new Store (/x/main.jsbundle:1:2)",
      I,
    ),
    `E\n    at async load (${I}:1:8)\n    at new Store (${I}:1:2)`,
  );
});

test("the header and lines that are not frames are kept, also when they mention a path", () => {
  const raw =
    "Error: failed to read /x/main.jsbundle:1:2\nmore text\n    at f (address at /x/main.jsbundle:1:0)";
  assert.equal(
    mapHermesStack(raw, I),
    `Error: failed to read /x/main.jsbundle:1:2\nmore text\n    at f (${I}:1:1)`,
  );
});

test("a component stack's frames are rewritten too", () => {
  const raw = "\n    at Boom (address at /x/.expo-internal/a1:1:50)\n    at View (<anonymous>)";
  assert.equal(mapHermesStack(raw, A), `\n    at Boom (${A}:1:51)\n    at View (<anonymous>)`);
});
