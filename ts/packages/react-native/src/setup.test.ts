import assert from "node:assert/strict";
import { test } from "node:test";
import { O11yError } from "@libo11y/core";
import { pristineFetch } from "@libo11y/web/portable";
import { openStorageQueue } from "./storage/queue.ts";
import { fakeStorage } from "./test-support/fake-storage.ts";
import { rnHarness, settle, TRACE_NETWORK, until } from "./test-support/harness.ts";

test("nothing is recorded, stored or sent before consent; a grant sends, saving the batch first", async () => {
  const h = await rnHarness();
  assert.equal(h.telemetry.consent.state(), "pending");
  h.span("before");
  await h.telemetry.forceFlush();
  await settle();
  assert.equal(h.storage.writes(), 0, "no storage write before grant");
  assert.equal(h.transport.requests.length, 0);
  h.telemetry.consent.grant();
  h.span("after");
  await h.telemetry.forceFlush();
  await until(() => h.sent().length === 1);
  assert.ok(h.storage.writes() > 0, "persist first");
  assert.match(h.sent()[0]?.body ?? "", /"after"/);
  assert.doesNotMatch(h.sent()[0]?.body ?? "", /"before"/);
  assert.deepEqual(await h.queue().size(), { entries: 0, bytes: 0 }, "removed once sent");
  await h.telemetry.shutdown();
});

test("a batch is sent only after its put: a storage that never resolves holds the send back", async () => {
  const storage = fakeStorage();
  const h = await rnHarness({ consent: { initial: "granted" } }, { storage });
  const setItem = storage.setItem;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  storage.setItem = async (k, v) => {
    await gate;
    return setItem(k, v);
  };
  h.span("s");
  const flushed = h.telemetry.forceFlush();
  await settle();
  assert.equal(h.sent().length, 0, "not sent while the body is not saved");
  release();
  await flushed;
  await until(() => h.sent().length === 1);
  await h.telemetry.shutdown();
});

test("a relative or non-http endpoint is refused, from the options or the env", async () => {
  for (const options of [
    { endpoint: "/_o11y" },
    { tracesEndpoint: "gw.test/v1/traces" },
    { logsEndpoint: "ftp://gw.test/v1/logs" },
    { endpoint: "", env: { OTEL_EXPORTER_OTLP_ENDPOINT: "/relative" } },
    { endpoint: "", env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "nope" } },
  ]) {
    await assert.rejects(rnHarness(options), (err: unknown) => {
      assert.ok(err instanceof O11yError, JSON.stringify(options));
      assert.equal(err.code, "INVALID_OPTION");
      return true;
    });
  }
  const hermetic = await rnHarness({ hermetic: true, env: { OTEL_EXPORTER_OTLP_ENDPOINT: "/ignored" } });
  await hermetic.telemetry.shutdown();
});

test("the queue lives in the given storage with mobile bounds, which the options override", async () => {
  const h = await rnHarness();
  assert.deepEqual(h.queueOptions[0], {
    storage: h.storage,
    databaseName: "libo11y",
    maxBytes: 2_097_152,
    maxEntries: 500,
    maxAgeMillis: 86_400_000,
  });
  await h.telemetry.shutdown();
  const o = await rnHarness({ transport: { maxQueueBytes: 10, maxQueueEntries: 2, maxQueueAgeMillis: 3 } });
  assert.deepEqual(
    { ...o.queueOptions[0], storage: undefined },
    { storage: undefined, databaseName: "libo11y", maxBytes: 10, maxEntries: 2, maxAgeMillis: 3 },
  );
  await o.telemetry.shutdown();
});

test("without storage the queue is in memory", async () => {
  const h = await rnHarness({}, { memory: true });
  const s = h.queueOptions[0]?.storage;
  assert.ok(s);
  assert.notEqual(s, h.storage);
  await h.telemetry.shutdown();
});

test("the transport posts with the pristine fetch, no beacon, always online, headers and timeout", async () => {
  const h = await rnHarness({ headers: { "x-client-token": "t" }, transport: { timeoutMillis: 5000 } });
  const t = h.transportOptions[0];
  assert.ok(t);
  assert.deepEqual(t.endpoints, {
    traces: "https://gw.test/_o11y/v1/traces",
    metrics: "https://gw.test/_o11y/v1/metrics",
    logs: "https://gw.test/_o11y/v1/logs",
  });
  assert.deepEqual(t.headers, { "x-client-token": "t" });
  assert.equal(t.timeoutMillis, 5000);
  assert.equal(t.fetch, pristineFetch);
  assert.ok("sendBeacon" in t && t.sendBeacon === undefined, "no beacon on React Native");
  assert.equal(t.isOnline?.(), true);
  await h.telemetry.shutdown();
});

test("the delivery persists first, is always online and takes the backoff", async () => {
  const h = await rnHarness({
    transport: { initialBackoffMillis: 7, maxBackoffMillis: 70, timeoutMillis: 20_000 },
  });
  const d = h.deliveryOptions[0];
  assert.ok(d);
  assert.equal(d.persistFirst, true);
  assert.equal(d.isOnline?.(), true);
  assert.equal(d.queue, h.queue());
  assert.equal(d.initialBackoffMillis, 7);
  assert.equal(d.maxBackoffMillis, 70);
  assert.equal(d.leaseMillis, 60_000, "three times the timeout");
  assert.equal(d.mode?.(), "normal");
  await h.telemetry.shutdown();
});

test("the resource names react_native, the OS and the device class; the env has mobile defaults the options override", async () => {
  const h = await rnHarness({ consent: { initial: "granted" }, env: { OTEL_BLRP_SCHEDULE_DELAY: "500" } });
  const attrs = h.telemetry.resource.attributes;
  assert.equal(attrs["o11y.rum.platform"], "react_native");
  assert.equal(attrs["os.name"], "android");
  assert.equal(attrs["o11y.rum.device.class"], "mobile");
  assert.equal(attrs["service.name"], "app");
  assert.equal(h.platform.value?.name, "react-native");
  assert.equal(h.platform.env?.OTEL_BSP_SCHEDULE_DELAY, "10000");
  assert.equal(h.platform.env?.OTEL_BLRP_SCHEDULE_DELAY, "500");
  assert.equal(h.platform.env?.OTEL_EXPORTER_OTLP_PROTOCOL, "http/json");
  await h.telemetry.shutdown();
});

test("going to the background flushes, and coming back drains the queue", async () => {
  const h = await rnHarness({
    consent: { initial: "granted" },
    transport: { initialBackoffMillis: 1, maxBackoffMillis: 1 },
  });
  h.span("one");
  h.env.setAppState("background");
  await until(() => h.sent().length === 1);
  h.env.setAppState("active");
  h.transport.script({ kind: "retry", reason: "503", retryAfterMillis: 0 });
  h.span("two");
  h.env.setAppState("inactive");
  await until(() => h.sent().length === 2);
  await settle();
  assert.deepEqual((await h.queue().size()).entries, 1, "the failed batch waits in the queue");
  // The delivery's own retry timer never fires in the harness: only the foreground drain sends.
  await new Promise((r) => setTimeout(r, 10));
  h.env.setAppState("active");
  await until(() => h.sent().length === 3);
  assert.match(h.sent()[2]?.body ?? "", /"two"/);
  await h.telemetry.shutdown();
});

test("setup drains what an earlier launch left in the queue, once consent is granted", async () => {
  const storage = fakeStorage();
  const earlier = await openStorageQueue({ storage, databaseName: "libo11y" });
  await earlier.put({ signal: "logs", body: '{"left":"behind"}' });
  earlier.close();
  const h = await rnHarness({ consent: { initial: "granted" } }, { storage });
  await until(() => h.sent("logs").length === 1);
  assert.equal(h.sent("logs")[0]?.body, '{"left":"behind"}');
  await h.telemetry.shutdown();
});

test("revoke empties the persistent queue", async () => {
  const h = await rnHarness({ consent: { initial: "granted" } });
  h.transport.script({ kind: "retry", reason: "503" });
  h.span("s");
  await h.telemetry.forceFlush();
  await until(() => h.sent().length === 1);
  await settle();
  assert.equal((await h.queue().size()).entries, 1);
  await h.telemetry.consent.revoke();
  assert.deepEqual(await h.queue().size(), { entries: 0, bytes: 0 });
  assert.equal([...h.storage.map.keys()].filter((k) => k.startsWith("libo11y/libo11y/")).length, 0);
  await h.telemetry.shutdown();
});

test("revoking while pending sends nothing and deletes what an earlier launch left", async () => {
  const storage = fakeStorage();
  const earlier = await openStorageQueue({ storage, databaseName: "libo11y" });
  await earlier.put({ signal: "logs", body: "left" });
  earlier.close();
  const h = await rnHarness({}, { storage });
  await settle();
  assert.equal(h.transport.requests.length, 0);
  await h.telemetry.consent.revoke();
  assert.equal(h.transport.requests.length, 0);
  assert.deepEqual([...storage.map.keys()], [], "the denied user's earlier batches are gone");
  await h.telemetry.shutdown();
});

test("without the global install there is no network patch and traceFetch is the identity", async () => {
  const h = await rnHarness();
  assert.equal(h.network.installs.length, 0);
  const f = (async () => new Response("x")) as typeof fetch;
  assert.equal(h.telemetry.traceFetch(f), f);
  await h.telemetry.shutdown();
});

test("the global install patches the network with propagateTo, ignoring the OTLP endpoints, and shutdown undoes it all", async () => {
  const h = await rnHarness(
    {
      instrumentations: { propagateTo: ["https://api.test"], ignoreUrls: [/health/], xhr: false },
    },
    { install: true },
  );
  try {
    const n = h.network.installs[0];
    assert.ok(n);
    assert.equal(n.telemetry, h.telemetry);
    assert.deepEqual(n.propagateTo, ["https://api.test"]);
    assert.deepEqual(n.ignoreUrls, [
      /health/,
      "https://gw.test/_o11y/v1/traces",
      "https://gw.test/_o11y/v1/metrics",
      "https://gw.test/_o11y/v1/logs",
    ]);
    assert.equal(n.xhr, false);
    assert.equal(n.fetch, true);
    const f = (async () => new Response("x")) as typeof fetch;
    assert.equal((h.telemetry.traceFetch(f) as unknown as Record<symbol, unknown>)[TRACE_NETWORK], f);
    assert.equal(h.env.listeners(), 1, "the lifecycle listens to AppState");
  } finally {
    await h.telemetry.shutdown();
  }
  assert.equal(h.network.uninstalls, 1);
  assert.equal(h.env.listeners(), 0, "shutdown removed the lifecycle subscription");
  assert.deepEqual(await h.queue().size(), { entries: 0, bytes: 0 }, "the queue is closed");
});

test("a failure while setting up shuts down what was built and closes the queue", async () => {
  let closed = false;
  await assert.rejects(
    rnHarness(
      { consent: { initial: "granted" } },
      {
        deps: {
          openQueue: async (q) => {
            const queue = await openStorageQueue(q);
            return {
              ...queue,
              close() {
                closed = true;
                queue.close();
              },
            };
          },
          createExporterSet: () => {
            throw new Error("boom");
          },
        },
      },
    ),
    /boom/,
  );
  assert.equal(closed, true);
});
