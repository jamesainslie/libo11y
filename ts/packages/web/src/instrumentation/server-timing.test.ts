/**
 * Reading the traceparent a server sent in Server-Timing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TraceFlags } from "@opentelemetry/api";
import { remoteParentFromTraceparent, traceparentFromServerTiming } from "./server-timing.ts";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const VALID = `00-${TRACE}-${SPAN}-01`;

test("a valid traceparent entry is returned", () => {
  assert.equal(traceparentFromServerTiming([{ name: "traceparent", description: VALID }]), VALID);
  const unsampled = `00-${TRACE}-${SPAN}-00`;
  assert.equal(traceparentFromServerTiming([{ name: "traceparent", description: unsampled }]), unsampled);
});

test("entries with other names are skipped", () => {
  assert.equal(
    traceparentFromServerTiming([
      { name: "db", description: VALID },
      { name: "traceparent", description: VALID },
    ]),
    VALID,
  );
  assert.equal(traceparentFromServerTiming([{ name: "db", description: VALID }]), undefined);
  assert.equal(traceparentFromServerTiming([]), undefined);
});

test("a version other than 00 is refused", () => {
  for (const version of ["01", "ff", "0"]) {
    const tp = `${version}-${TRACE}-${SPAN}-01`;
    assert.equal(traceparentFromServerTiming([{ name: "traceparent", description: tp }]), undefined, tp);
  }
});

test("all-zero trace or span ids are refused", () => {
  for (const tp of [`00-${"0".repeat(32)}-${SPAN}-01`, `00-${TRACE}-${"0".repeat(16)}-01`]) {
    assert.equal(traceparentFromServerTiming([{ name: "traceparent", description: tp }]), undefined, tp);
  }
});

test("upper-case hex is refused", () => {
  const tp = `00-${TRACE.toUpperCase()}-${SPAN}-01`;
  assert.equal(traceparentFromServerTiming([{ name: "traceparent", description: tp }]), undefined);
  assert.equal(
    traceparentFromServerTiming([{ name: "traceparent", description: `00-${TRACE}-${SPAN}-0A` }]),
    undefined,
  );
});

test("a missing or malformed description is refused", () => {
  for (const description of [
    "",
    "traceparent",
    `00-${TRACE}-${SPAN}`,
    `00-${TRACE}-${SPAN}-01-extra`,
    ` ${VALID}`,
  ]) {
    assert.equal(traceparentFromServerTiming([{ name: "traceparent", description }]), undefined, description);
  }
});

test("the first valid traceparent entry wins", () => {
  const second = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
  assert.equal(
    traceparentFromServerTiming([
      { name: "traceparent", description: "garbage" },
      { name: "traceparent", description: second },
      { name: "traceparent", description: VALID },
    ]),
    second,
  );
});

test("remoteParentFromTraceparent gives the remote span context of a valid traceparent", () => {
  assert.deepEqual(remoteParentFromTraceparent(VALID), {
    traceId: TRACE,
    spanId: SPAN,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  });
  assert.equal(remoteParentFromTraceparent(`00-${TRACE}-${SPAN}-00`)?.traceFlags, TraceFlags.NONE);
  assert.equal(remoteParentFromTraceparent("nope"), undefined);
});
