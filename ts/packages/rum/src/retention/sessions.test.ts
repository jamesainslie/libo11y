import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionsIn } from "./sessions.ts";

const attr = (id: string) => ({ key: "session.id", value: { stringValue: id } });

test("sessionsIn reads every session.id in a traces or logs body", () => {
  const traces = JSON.stringify({
    resourceSpans: [
      { scopeSpans: [{ spans: [{ attributes: [attr("a")] }, { attributes: [attr("b")] }, {}] }] },
    ],
  });
  const logs = JSON.stringify({
    resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes: [attr("c")] }] }] }],
  });
  assert.deepEqual([...(sessionsIn({ signal: "traces", body: traces }) ?? [])].sort(), ["a", "b"]);
  assert.deepEqual([...(sessionsIn({ signal: "logs", body: logs }) ?? [])], ["c"]);
});

test("sessionsIn of an unreadable body is undefined", () => {
  assert.equal(sessionsIn({ signal: "logs", body: "not json" }), undefined);
});
