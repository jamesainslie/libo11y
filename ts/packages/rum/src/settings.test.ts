import assert from "node:assert/strict";
import { test } from "node:test";
import { O11yError } from "@libo11y/core";
import type { RumSettings } from "./contracts/runtime.ts";
import type { RumOptions } from "./options.ts";
import { resolveSettings } from "./settings.ts";

test("defaults", () => {
  const s = resolveSettings(undefined);
  assert.equal(s.sessionSampleRate, 1);
  assert.equal(s.sessionIdleMillis, 900_000);
  assert.equal(s.sessionMaxMillis, 14_400_000);
  assert.deepEqual([...s.queryAllowList], []);
  assert.deepEqual([...s.enabled], []);
  assert.equal(s.clientToken, undefined);
  assert.equal(s.viewName(new URL("https://a.test/docs/42")), "/docs/$id");
});

test("invalid values are refused with INVALID_OPTION", () => {
  const bad: RumOptions[] = [
    { sessionSampleRate: 1.5 },
    { sessionSampleRate: -0.1 },
    { sessionSampleRate: Number.NaN },
    { sessionIdleMillis: 0 },
    { sessionMaxMillis: -1 },
    { sessionMaxMillis: Number.POSITIVE_INFINITY },
    { clientToken: "" },
    {
      collectors: [
        { name: "views", start: () => () => {} },
        { name: "views", start: () => () => {} },
      ],
    },
  ];
  for (const rum of bad) {
    assert.throws(
      () => resolveSettings(rum),
      (e: unknown) => e instanceof O11yError && e.code === "INVALID_OPTION",
      JSON.stringify(rum),
    );
  }
});

test("installed collectors are enabled", () => {
  const s = resolveSettings({ collectors: [{ name: "errors", start: () => () => {} }] });
  assert.deepEqual([...s.enabled], ["errors"]);
  assert.equal(s.collectors.length, 1);
});

test("options are taken as given", () => {
  const viewName = (): string => "/x";
  const s = resolveSettings({
    sessionSampleRate: 0,
    sessionIdleMillis: 1000,
    sessionMaxMillis: 2000,
    queryAllowList: ["page"],
    clientToken: "pub-123",
    viewName,
  });
  assert.equal(s.sessionSampleRate, 0);
  assert.equal(s.sessionIdleMillis, 1000);
  assert.equal(s.sessionMaxMillis, 2000);
  assert.deepEqual([...s.queryAllowList], ["page"]);
  assert.equal(s.clientToken, "pub-123");
  assert.equal(s.viewName, viewName);
});

test("the client token is part of the settings every collector reads", () => {
  const s: RumSettings = resolveSettings({ clientToken: "t1" });
  assert.equal(s.clientToken, "t1");
});
