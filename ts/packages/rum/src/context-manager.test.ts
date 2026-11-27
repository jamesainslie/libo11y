import assert from "node:assert/strict";
import { test } from "node:test";
import { createContextManager } from "@libo11y/web";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import { rumContextManager } from "./context-manager.ts";

test("the open action is the active context only when nothing else is", () => {
  const tracer = new TracerProvider().getTracer("t");
  const action = tracer.startSpan("action click");
  const other = tracer.startSpan("other");
  let open: typeof action | undefined = action;
  const cm = rumContextManager(createContextManager(), () => open).enable();
  assert.equal(trace.getSpan(cm.active()), action);
  cm.with(trace.setSpan(ROOT_CONTEXT, other), () => assert.equal(trace.getSpan(cm.active()), other));
  open = undefined;
  assert.equal(trace.getSpan(cm.active()), undefined);
  cm.disable();
});

test("an ended action is not active", () => {
  const tracer = new TracerProvider().getTracer("t");
  const action = tracer.startSpan("action click");
  action.end();
  const cm = rumContextManager(createContextManager(), () => action).enable();
  assert.equal(trace.getSpan(cm.active()), undefined);
  cm.disable();
});

test("with, bind, enable and disable reach the inner manager", () => {
  const tracer = new TracerProvider().getTracer("t");
  const span = tracer.startSpan("s");
  const cm = rumContextManager(createContextManager(), () => undefined);
  assert.equal(cm.enable(), cm);
  const ctx = trace.setSpan(ROOT_CONTEXT, span);
  const bound = cm.bind(ctx, () => trace.getSpan(cm.active()));
  assert.equal(bound(), span);
  assert.equal(
    cm.with(ctx, (a: number) => a + 1, undefined, 1),
    2,
  );
  assert.equal(cm.disable(), cm);
});
