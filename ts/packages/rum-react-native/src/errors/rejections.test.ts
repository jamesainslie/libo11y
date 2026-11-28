import assert from "node:assert/strict";
import { test } from "node:test";
import type { PromiseRejectionTrackerOptions } from "@libo11y/react-native/internal";
import { installRejectionTracker } from "./rejections.ts";

test("without HermesInternal or its tracker, nothing installs", () => {
  assert.equal(
    installRejectionTracker(undefined, () => {}),
    false,
  );
  assert.equal(
    installRejectionTracker({}, () => {}),
    false,
  );
});

test("enables the tracker for all rejections and passes each unhandled reason on", () => {
  let options: PromiseRejectionTrackerOptions | undefined;
  const reasons: unknown[] = [];
  const ok = installRejectionTracker(
    {
      enablePromiseRejectionTracker: (o) => {
        options = o;
      },
    },
    (r) => reasons.push(r),
  );
  assert.equal(ok, true);
  assert.equal(options?.allRejections, true);
  options?.onUnhandled?.(3, "why");
  options?.onHandled?.(3);
  assert.deepEqual(reasons, ["why"]);
});

test("a tracker that throws when enabled counts as not installed", () => {
  assert.equal(
    installRejectionTracker(
      {
        enablePromiseRejectionTracker: () => {
          throw new Error("no");
        },
      },
      () => {},
    ),
    false,
  );
});
