import assert from "node:assert/strict";
import { test } from "node:test";
import type { SignalReport, Telemetry } from "@libo11y/core";
import { flushInBackground, reportFlush } from "./background-flush.ts";

const REPORT_KEY = Symbol.for("libo11y.report");

class CollectorError extends Error {}

/** A telemetry whose forceFlush resolves with report, and whose own reporter collects into reports. */
function telemetryWith(flush: () => Promise<SignalReport>): { t: Telemetry; reports: Error[] } {
  const reports: Error[] = [];
  const t = {
    forceFlush: flush,
    [REPORT_KEY]: (err: Error) => reports.push(err),
  } as unknown as Telemetry;
  return { t, reports };
}

const FAILED: SignalReport = {
  ok: false,
  errors: [
    {
      signal: "traces",
      error: new Error("o11y: flush traces: Not Found at https://secret.example", {
        cause: new CollectorError("Not Found at https://secret.example"),
      }),
    },
    { signal: "logs", error: new Error("o11y: flush logs: deadline exceeded") },
  ],
};

test("a report that is not ok is reported once, naming each signal and the class of its error only", () => {
  const { t, reports } = telemetryWith(async () => FAILED);
  reportFlush(t, "flush on hide", FAILED);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.message, "o11y: flush on hide failed: traces (CollectorError), logs (Error)");
  assert.doesNotMatch(reports[0]?.message ?? "", /secret/);
  assert.equal(reports[0]?.cause, FAILED);
});

test("an ok report is not reported", () => {
  const { t, reports } = telemetryWith(async () => ({ ok: true, errors: [] }));
  reportFlush(t, "flush on hide", { ok: true, errors: [] });
  assert.deepEqual(reports, []);
});

test("flushInBackground flushes and reports a failed flush through the telemetry's own reporter", async () => {
  let flushes = 0;
  const { t, reports } = telemetryWith(async () => {
    flushes++;
    return FAILED;
  });
  assert.equal(await flushInBackground(t, "react-native: flush on background"), FAILED);
  assert.equal(flushes, 1);
  assert.deepEqual(
    reports.map((r) => r.message),
    ["o11y: react-native: flush on background failed: traces (CollectorError), logs (Error)"],
  );
});

test("flushInBackground never rejects, even when the flush or the reporter throws", async () => {
  const rejecting = telemetryWith(() => Promise.reject(new Error("broken")));
  const report = await flushInBackground(rejecting.t, "flush on hide");
  assert.deepEqual(
    report.errors.map((e) => e.signal),
    ["lifecycle"],
  );
  assert.match(rejecting.reports[0]?.message ?? "", /^o11y: flush on hide failed: Error$/);

  const throwingReporter = {
    forceFlush: async () => FAILED,
    [REPORT_KEY]: () => {
      throw new Error("reporter broke");
    },
  } as unknown as Telemetry;
  await assert.doesNotReject(flushInBackground(throwingReporter, "flush on hide"));
});

test("a cause that is a list of errors, as the tracer provider rejects with, is named by its first error's class", () => {
  const { t, reports } = telemetryWith(async () => FAILED);
  reportFlush(t, "flush on hide", {
    ok: false,
    errors: [
      { signal: "traces", error: new Error("o11y: flush traces: x", { cause: [new CollectorError("x")] }) },
    ],
  });
  assert.deepEqual(
    reports.map((r) => r.message),
    ["o11y: flush on hide failed: traces (CollectorError)"],
  );
});
