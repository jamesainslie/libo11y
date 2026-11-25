/**
 * The modules the service worker runs never touch document, window or sendBeacon, which a Manifest
 * V3 worker does not have. The browser specs prove the worker runs; this keeps it from regressing
 * quietly behind a typeof guard.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const WORKER_MODULES = [
  "worker.ts",
  "messaging.ts",
  "messaging-transport.ts",
  "consent-sync.ts",
  "protocol.ts",
  "chrome.ts",
];

// code strips comments and string literals, so only executable code is checked.
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
}

test("the worker's modules use no document, window or beacon", () => {
  for (const file of WORKER_MODULES) {
    const src = code(readFileSync(new URL(file, import.meta.url), "utf8"));
    assert.doesNotMatch(src, /\bdocument\b/, `${file} uses document`);
    assert.doesNotMatch(src, /\bwindow\b/, `${file} uses window`);
    assert.doesNotMatch(src, /\bpristineSendBeacon\b|\.sendBeacon\b/, `${file} uses sendBeacon`);
  }
});

test("the worker turns the beacon off explicitly", () => {
  const src = code(readFileSync(new URL("worker.ts", import.meta.url), "utf8"));
  assert.match(src, /sendBeacon: undefined/);
});
