import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTelemetryWith, type Telemetry } from "@libo11y/core";
import { context, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, StackContextManager } from "@opentelemetry/sdk-trace";
import { testPlatform } from "../../web/src/test-support/index.ts";
import { createTracedMessaging, sendTracedTabMessage } from "./messaging.ts";
import { createFakeExtension } from "./test-support/fake-chrome.ts";

let telemetry: Telemetry;
const exporter = new InMemorySpanExporter();
const manager = new StackContextManager();

before(async () => {
  context.setGlobalContextManager(manager.enable());
  telemetry = await createTelemetryWith(
    { serviceName: "t", environment: "test", spanExporter: exporter, startupSummary: false, console: false },
    testPlatform(),
  );
});

after(async () => {
  await telemetry.shutdown();
  context.disable();
});

function rig() {
  const ext = createFakeExtension();
  const worker = ext.context({ url: "chrome-extension://fakeextensionid/worker.js" });
  const content = ext.context({ tabId: 7, url: "https://example.com/" });
  return {
    ext,
    worker,
    content,
    workerMessaging: createTracedMessaging(worker.chrome, telemetry.propagator),
    contentMessaging: createTracedMessaging(content.chrome, telemetry.propagator),
  };
}

test("a traced message carries the sender's span to the listener", async () => {
  exporter.reset();
  const { ext, workerMessaging, contentMessaging } = rig();
  const tracer = telemetry.tracerProvider.getTracer("test");
  workerMessaging.onMessage((payload, sender) => {
    const child = tracer.startSpan("child");
    const parent = trace.getSpan(context.active())?.spanContext();
    child.end();
    return { payload, parent, tab: sender.tab?.id, id: sender.id };
  });
  let root: { traceId: string; spanId: string } | undefined;
  const reply = await tracer.startActiveSpan("root", (span) => {
    root = span.spanContext();
    const p = contentMessaging.sendMessage<{
      payload: unknown;
      parent?: { traceId: string; spanId: string };
      tab?: number;
      id?: string;
    }>({ op: "x", n: [1, 2] });
    span.end();
    return p;
  });
  assert.ok(root);
  assert.deepEqual(reply.payload, { op: "x", n: [1, 2] });
  assert.equal(reply.parent?.traceId, root.traceId);
  assert.equal(reply.parent?.spanId, root.spanId);
  assert.equal(reply.tab, 7);
  assert.equal(reply.id, ext.id);

  const wire = ext.sent[0] as { libo11y: number; type: string; carrier: Record<string, string> };
  assert.equal(wire.libo11y, 1);
  assert.equal(wire.type, "traced");
  assert.match(wire.carrier.traceparent ?? "", new RegExp(`^00-${root.traceId}-${root.spanId}-01$`));

  await telemetry.forceFlush();
  const child = exporter.getFinishedSpans().find((s) => s.name === "child");
  assert.equal(child?.spanContext().traceId, root.traceId);
  assert.equal(child?.parentSpanContext?.spanId, root.spanId);
});

test("without an active span the listener runs under the root context", async () => {
  const { workerMessaging, contentMessaging } = rig();
  workerMessaging.onMessage(() => trace.getSpan(context.active()) === undefined);
  assert.equal(await contentMessaging.sendMessage(1), true);
});

test("baggage crosses through the telemetry's propagator", async () => {
  const { workerMessaging, contentMessaging } = rig();
  workerMessaging.onMessage(() => propagation.getBaggage(context.active())?.getEntry("tenant")?.value);
  const bag = propagation.createBaggage({ tenant: { value: "acme" } });
  const got = await context.with(propagation.setBaggage(ROOT_CONTEXT, bag), () =>
    contentMessaging.sendMessage("b"),
  );
  assert.equal(got, "acme");
});

test("a promise result is awaited", async () => {
  const { workerMessaging, contentMessaging } = rig();
  workerMessaging.onMessage(async (payload) => {
    await new Promise((r) => setTimeout(r, 5));
    return { echoed: payload };
  });
  assert.deepEqual(await contentMessaging.sendMessage("p"), { echoed: "p" });
});

test("a listener's throw or rejection comes back as a rejection", async () => {
  const { workerMessaging, contentMessaging } = rig();
  const remove = workerMessaging.onMessage(() => {
    throw new Error("boom");
  });
  await assert.rejects(contentMessaging.sendMessage(1), { message: "boom" });
  remove();
  workerMessaging.onMessage(() => Promise.reject(new Error("later boom")));
  await assert.rejects(contentMessaging.sendMessage(1), { message: "later boom" });
});

test("sendMessage rejects when nobody answers", async () => {
  const { contentMessaging } = rig();
  await assert.rejects(contentMessaging.sendMessage(1));
});

test("sendMessage rejects when another listener answered with something else", async () => {
  const { worker, contentMessaging } = rig();
  worker.chrome.runtime.onMessage.addListener((_m, _s, reply) => {
    reply({ not: "traced" });
    return undefined;
  });
  await assert.rejects(contentMessaging.sendMessage(1), /reply/);
});

test("non-libo11y messages are left to other listeners", async () => {
  const { worker, content, workerMessaging } = rig();
  let calls = 0;
  workerMessaging.onMessage(() => {
    calls++;
    return "traced";
  });
  worker.chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if ((m as { type?: string }).type !== "wake") return undefined;
    setTimeout(() => reply({ wakes: 3 }), 5);
    return true;
  });
  assert.deepEqual(await content.chrome.runtime.sendMessage({ type: "wake" }), { wakes: 3 });
  assert.deepEqual(
    await content.chrome.runtime
      .sendMessage({ libo11y: 1, type: "export", signal: "logs", body: "{}" })
      .catch(() => "rejected"),
    "rejected",
  );
  assert.equal(calls, 0);
});

test("onMessage returns a function that removes the listener", () => {
  const { worker, workerMessaging } = rig();
  const remove = workerMessaging.onMessage(() => 1);
  assert.equal(worker.listeners().length, 1);
  remove();
  assert.equal(worker.listeners().length, 0);
});

test("sendTracedTabMessage reaches the tab with the context", async () => {
  const { content, worker } = rig();
  const contentMessaging = createTracedMessaging(content.chrome, telemetry.propagator);
  contentMessaging.onMessage((payload) => ({
    payload,
    traceId: trace.getSpan(context.active())?.spanContext().traceId,
  }));
  const tracer = telemetry.tracerProvider.getTracer("test");
  let traceId = "";
  const reply = await tracer.startActiveSpan("to-tab", (span) => {
    traceId = span.spanContext().traceId;
    const p = sendTracedTabMessage<{ payload: unknown; traceId?: string }>(
      worker.chrome,
      telemetry.propagator,
      7,
      "hi",
    );
    span.end();
    return p;
  });
  assert.deepEqual(reply, { payload: "hi", traceId });
  await assert.rejects(sendTracedTabMessage(worker.chrome, telemetry.propagator, 8, "nobody"));
});

test("sendTracedTabMessage rejects where tabs is unavailable", async () => {
  const { content } = rig();
  await assert.rejects(sendTracedTabMessage(content.chrome, telemetry.propagator, 7, 1), /tabs/);
});

test("an extension API that throws synchronously gives a rejection, not a throw", async () => {
  // Chrome throws "Extension context invalidated." synchronously in a content script whose
  // extension was reloaded or updated, and throws on a bad tabId before sending anything.
  const { worker } = rig();
  const invalidated = new Error("Extension context invalidated.");
  const broken = {
    ...worker.chrome,
    runtime: {
      ...worker.chrome.runtime,
      sendMessage: (): Promise<unknown> => {
        throw invalidated;
      },
    },
    tabs: {
      sendMessage: (): Promise<unknown> => {
        throw new TypeError("No matching signature.");
      },
    },
  };
  const messaging = createTracedMessaging(broken, telemetry.propagator);
  let sent: Promise<unknown> | undefined;
  assert.doesNotThrow(() => {
    sent = messaging.sendMessage(1);
  });
  await assert.rejects(sent as Promise<unknown>, invalidated);
  let tab: Promise<unknown> | undefined;
  assert.doesNotThrow(() => {
    tab = sendTracedTabMessage(broken, telemetry.propagator, 7, 1);
  });
  await assert.rejects(tab as Promise<unknown>, TypeError);
});
