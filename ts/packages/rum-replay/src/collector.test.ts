import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { O11yError } from "@libo11y/core";
import type { RumRuntime, SessionState } from "@libo11y/rum";
import { type FakeRuntime, fakeRuntime } from "../../rum/src/test-support/fake-runtime.ts";
import { createFakeStorage } from "../../rum/src/test-support/fake-storage.ts";
import { type ReplayDeps, replay, replayWith } from "./collector.ts";
import type { SegmentEnvelope } from "./envelope.ts";
import type { Recorder, StartRecorder } from "./recorder.ts";
import type { RrwebEvent } from "./scrub.ts";
import { SEQUENCE_KEY } from "./sequence.ts";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const meta = (t: number): RrwebEvent => ({ type: 4, timestamp: t, data: { href: "/", width: 1, height: 1 } });
const full = (t: number): RrwebEvent => ({ type: 2, timestamp: t, data: { node: { type: 0, id: 1 } } });
const move = (t: number): RrwebEvent => ({ type: 3, timestamp: t, data: { source: 1, positions: [] } });

interface Upload {
  readonly url: URL;
  readonly body: SegmentEnvelope;
}

interface World {
  readonly rt: FakeRuntime;
  readonly deps: ReplayDeps;
  readonly uploads: Upload[];
  readonly storage: ReturnType<typeof createFakeStorage>;
  readonly rec: { starts: number; stops: number; emit: ((e: RrwebEvent) => void) | undefined };
  readonly warnings: string[];
  /** The fake recorder that deps.loadRecorder hands out, already loaded. */
  readonly start: StartRecorder;
}

function world(o: { kept?: boolean; sampled?: boolean; session?: string } = {}): World {
  const rt = fakeRuntime();
  (rt as { telemetry: unknown }).telemetry = { resource: { attributes: { "service.name": "shop" } } };
  const state: SessionState = {
    id: o.session ?? SESSION,
    startedAt: 0,
    lastActivityAt: 0,
    sampled: o.sampled ?? true,
    ...((o.sampled ?? true) ? { retained: "head_sampled" as const } : {}),
  };
  rt.setSessionState(state);
  rt.setKept(o.kept ?? o.sampled ?? true);
  const uploads: Upload[] = [];
  const storage = createFakeStorage();
  const rec: World["rec"] = { starts: 0, stops: 0, emit: undefined };
  let t = 1_700_000_000_000;
  const warnings: string[] = [];
  const start: StartRecorder = (_policy, onEvent) => {
    rec.starts++;
    rec.emit = onEvent;
    onEvent(meta(t++));
    onEvent(full(t++));
    const r: Recorder = {
      checkout: () => {
        onEvent(meta(t++));
        onEvent(full(t++));
      },
      stop: () => {
        rec.stops++;
        rec.emit = undefined;
      },
    };
    return r;
  };
  const deps: ReplayDeps = {
    loadRecorder: () => start,
    fetch: (async (url: string, init: RequestInit) => {
      uploads.push({
        url: new URL(url),
        body: JSON.parse(gunzipSync(init.body as Uint8Array).toString("utf8")) as SegmentEnvelope,
      });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch,
    locks: {
      request: async <T>(_name: string, cb: () => Promise<T> | T): Promise<T> => cb(),
    },
    storage,
    timers: rt.fakeEnv().clock.timers,
    now: () => t,
    compression: true,
    contentScript: false,
    location: "https://app.test/page",
    validSelector: (s) => !s.includes("!"),
    recordingId: () => "rec-0f8fad5b",
    warn: (m) => warnings.push(m),
  };
  return { rt, deps, uploads, storage, rec, warnings, start };
}

async function settle(w: World): Promise<void> {
  // CompressionStream runs on real tasks, so this waits on timers.
  for (let i = 0; i < 30; i++) {
    w.rt.fakeEnv().clock.advance(0);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Records one incremental event and cuts the segment at a hide. */
function segment(w: World): void {
  w.rec.emit?.(move(1_700_000_000_100));
  // After a cut, the event asks for a checkout, which runs on a timer.
  w.rt.fakeEnv().clock.advance(0);
  w.rt.hide();
}

test("a kept, head-sampled session uploads its first segment after a hide", async () => {
  const w = world();
  const stop = replayWith(w.deps).start(w.rt);
  assert.equal(w.rec.starts, 1);
  segment(w);
  await settle(w);
  assert.equal(w.uploads.length, 1);
  const u = w.uploads[0];
  assert.ok(u);
  assert.equal(u.url.origin + u.url.pathname, "https://app.test/_o11y/v1/replay");
  assert.equal(u.url.searchParams.get("service"), "shop");
  assert.equal(u.url.searchParams.get("session"), SESSION);
  assert.equal(u.url.searchParams.get("segment"), "0");
  assert.equal(u.body.recording, "rec-0f8fad5b");
  assert.deepEqual(
    u.body.events.map((e) => e.type),
    [4, 2, 3],
  );
  assert.deepEqual(
    u.body.views.map((v) => v.id),
    ["v0"],
  );
  stop();
});

test("the replay endpoint counts as RUM's own traffic while the collector runs", () => {
  const w = world();
  const stop = replayWith(w.deps).start(w.rt);
  assert.deepEqual([...w.rt.ignoredUrls], ["https://app.test/_o11y/v1/replay"]);
  stop();
  assert.deepEqual([...w.rt.ignoredUrls], []);
});

test("an unkept session with onRetain off never starts the recorder", async () => {
  const w = world({ sampled: false });
  const stop = replayWith(w.deps).start(w.rt);
  assert.equal(w.rec.starts, 0);
  stop();
});

test("with onRetain, an unkept session records into memory and uploads the lead-up once kept", async () => {
  const w = world({ sampled: false });
  const stop = replayWith(w.deps, { onRetain: true }).start(w.rt);
  assert.equal(w.rec.starts, 1);
  for (let i = 0; i < 3; i++) segment(w);
  w.rec.emit?.(move(1_700_000_000_200));
  await settle(w);
  assert.equal(w.uploads.length, 0, "nothing goes out while the session is not kept");
  w.rt.setKept(true);
  w.rt.sessionEvent({ type: "kept", session: w.rt.session.current() as SessionState, local: true });
  await settle(w);
  assert.equal(w.uploads.length, 3, "the last two closed segments and the open one");
  assert.deepEqual(
    w.uploads.map((u) => u.url.searchParams.get("segment")),
    ["0", "1", "2"],
  );
  segment(w);
  await settle(w);
  assert.equal(w.uploads.length, 4, "then segments go out as they close");
  stop();
});

test("an unkept session that ends drops its lead-up", async () => {
  const w = world({ sampled: false });
  const stop = replayWith(w.deps, { onRetain: true }).start(w.rt);
  segment(w);
  w.rt.sessionEvent({ type: "end", session: w.rt.session.current() as SessionState, local: true });
  w.rt.setKept(true);
  w.rt.sessionEvent({ type: "kept", session: w.rt.session.current() as SessionState, local: true });
  await settle(w);
  assert.equal(w.uploads.length, 0);
  stop();
});

test("revoking consent stops the recorder, sends nothing more and removes the segment counter", async () => {
  const w = world();
  const stop = replayWith(w.deps).start(w.rt);
  segment(w);
  await settle(w);
  assert.equal(w.uploads.length, 1);
  assert.notEqual(w.storage.getItem(SEQUENCE_KEY), null);
  w.rec.emit?.(move(1_700_000_000_300));
  w.rt.gate.open = false;
  stop();
  await settle(w);
  assert.equal(w.rec.stops, 1);
  assert.equal(w.uploads.length, 1);
  assert.equal(w.storage.getItem(SEQUENCE_KEY), null);
});

test("a stop while consent holds (shutdown, kill switch) keeps the shared counter for other tabs", () => {
  const w = world();
  const stop = replayWith(w.deps).start(w.rt);
  w.storage.setItem(SEQUENCE_KEY, JSON.stringify({ session: SESSION, next: 3 }));
  stop();
  assert.notEqual(w.storage.getItem(SEQUENCE_KEY), null);
});

test("a remote document with replay enabled false keeps the recorder off", () => {
  const w = world();
  w.rt.document = { version: "c1", replay: { enabled: false } };
  const stop = replayWith(w.deps).start(w.rt);
  assert.equal(w.rec.starts, 0);
  stop();
});

test("remote configuration adds mask and block selectors and can only remove unmask ones", () => {
  const w = world();
  let policy: Parameters<StartRecorder>[0] | undefined;
  const deps: ReplayDeps = {
    ...w.deps,
    loadRecorder: () => (p, e, err) => {
      policy = p;
      return w.start(p, e, err);
    },
  };
  w.rt.document = {
    version: "c1",
    replay: { mask: [".m"], block: [".b", "bad!"], unmask: [".x", ".public"] },
  };
  const stop = replayWith(deps, { privacy: { unmask: [".public", ".open"] } }).start(w.rt);
  assert.ok(policy);
  assert.deepEqual(policy.unmask, [".public"]);
  assert.equal(policy.mask.at(-1), ".m");
  assert.equal(policy.block.at(-1), ".b");
  assert.equal(policy.block.includes("bad!"), false);
  stop();
});

test("an error event after the first upload carries o11y.rum.replay.segment", async () => {
  const w = world();
  const stop = replayWith(w.deps).start(w.rt);
  w.rt.emit("o11y.rum.error", { "o11y.rum.error.type": "Before" });
  segment(w);
  await settle(w);
  w.rt.emit("o11y.rum.error", { "o11y.rum.error.type": "TypeError" });
  w.rt.emit("o11y.rum.frustration", { "o11y.rum.frustration.type": "dead" });
  w.rt.emit("o11y.rum.view.summary", {});
  assert.deepEqual(
    w.rt.events.map((e) => [e.name, e.attrs["o11y.rum.replay.segment"]]),
    [
      ["o11y.rum.error", undefined],
      ["o11y.rum.error", 0],
      ["o11y.rum.frustration", 0],
      ["o11y.rum.view.summary", undefined],
    ],
  );
  stop();
  w.rt.emit("o11y.rum.error", { "o11y.rum.error.type": "After" });
  assert.equal(w.rt.events.at(-1)?.attrs["o11y.rum.replay.segment"], undefined);
});

test("a new session cuts the open segment for the old one and starts a new recording", async () => {
  const w = world();
  const stop = replayWith(w.deps).start(w.rt);
  w.rec.emit?.(move(1_700_000_000_400));
  const previous = w.rt.session.current() as SessionState;
  const next: SessionState = { ...previous, id: OTHER };
  w.rt.setSessionState(next);
  w.rt.sessionEvent({ type: "start", session: next, previous, local: true });
  assert.equal(w.rec.stops, 1);
  assert.equal(w.rec.starts, 2);
  segment(w);
  await settle(w);
  assert.deepEqual(
    w.uploads.map((u) => [u.url.searchParams.get("session"), u.url.searchParams.get("segment")]),
    [
      [SESSION, "0"],
      [OTHER, "0"],
    ],
  );
  stop();
});

test("request spans started during a segment are listed in it", async () => {
  const w = world();
  const stop = replayWith(w.deps).start(w.rt);
  const span = { spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }) };
  for (const hook of w.rt.requestHooks) hook(span as never, { method: "GET", url: "/x" } as never);
  segment(w);
  await settle(w);
  assert.deepEqual(
    w.uploads[0]?.body.requests.map((r) => [r.trace_id, r.span_id]),
    [["a".repeat(32), "b".repeat(16)]],
  );
  stop();
  assert.equal(w.rt.requestHooks.size, 0);
});

test("replay refuses a content script, a page without Web Locks or CompressionStream, and no service", () => {
  for (const [what, change] of [
    ["content script", (w: World) => ({ ...w.deps, contentScript: true })],
    ["no locks", (w: World) => ({ ...w.deps, locks: undefined })],
    ["no compression", (w: World) => ({ ...w.deps, compression: false })],
    [
      "no service",
      (w: World) => {
        (w.rt as { telemetry: unknown }).telemetry = { resource: { attributes: {} } };
        return w.deps;
      },
    ],
  ] as const) {
    const w = world();
    const stop = replayWith(change(w)).start(w.rt);
    assert.equal(w.rec.starts, 0, what);
    assert.equal(w.warnings.length, 1, what);
    stop();
  }
  const w = world();
  (w.rt as { scope?: RumRuntime["scope"] }).scope = { fixedView: true };
  replayWith(w.deps).start(w.rt)();
  assert.equal(w.rec.starts, 0, "a scoped runtime is a content script");
});

test("replay validates its options when it is called", () => {
  for (const bad of [
    { sampleRate: 2 },
    { sampleRate: -0.1 },
    { privacy: { unmask: [""] } },
    { limits: { sampleRate: [0.5, 1] as const }, sampleRate: 0.2 },
    { url: "" },
  ]) {
    assert.throws(
      () => replay(bad),
      (e: unknown) => e instanceof O11yError && e.code === "INVALID_OPTION",
      JSON.stringify(bad),
    );
  }
  assert.equal(replay().name, "replay");
});

/** A loader whose import the test settles by hand. */
function manualLoader(w: World): {
  readonly deps: ReplayDeps;
  readonly loads: () => number;
  resolve(): void;
  reject(err: unknown): void;
} {
  let loads = 0;
  let settle: { resolve(s: StartRecorder): void; reject(err: unknown): void } | undefined;
  let loaded: StartRecorder | undefined;
  let pending: Promise<StartRecorder> | undefined;
  return {
    deps: {
      ...w.deps,
      loadRecorder: () => {
        if (loaded !== undefined) return loaded;
        if (pending === undefined) {
          loads++;
          pending = new Promise<StartRecorder>((resolve, reject) => {
            settle = { resolve, reject };
          }).then((s) => {
            loaded = s;
            return s;
          });
        }
        return pending;
      },
    },
    loads: () => loads,
    resolve: () => settle?.resolve(w.start),
    reject: (err) => settle?.reject(err),
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("nothing is recorded until rrweb has loaded, then the session records", async () => {
  const w = world();
  const l = manualLoader(w);
  const stop = replayWith(l.deps).start(w.rt);
  assert.equal(l.loads(), 1, "a session that will record loads rrweb");
  assert.equal(w.rec.starts, 0, "nothing records before the load");
  l.resolve();
  await tick();
  assert.equal(w.rec.starts, 1);
  segment(w);
  await settle(w);
  assert.equal(w.uploads.length, 1);
  stop();
});

test("a session that will not record never loads rrweb", () => {
  for (const [what, setup, options] of [
    ["unkept, onRetain off", (w: World) => w, {}],
    [
      "remote kill switch",
      (w: World) => {
        w.rt.document = { version: "c1", replay: { enabled: false } };
        return w;
      },
      {},
    ],
    ["sampled out", (w: World) => w, { sampleRate: 0 }],
  ] as const) {
    const w = setup(world({ sampled: what !== "unkept, onRetain off" }));
    const l = manualLoader(w);
    const stop = replayWith(l.deps, options).start(w.rt);
    assert.equal(l.loads(), 0, what);
    stop();
  }
});

test("a stop while rrweb loads leaves the recorder off", async () => {
  const w = world();
  const l = manualLoader(w);
  const stop = replayWith(l.deps).start(w.rt);
  stop();
  l.resolve();
  await tick();
  assert.equal(w.rec.starts, 0);
});

test("a new session while rrweb loads records only the new session", async () => {
  const w = world();
  const l = manualLoader(w);
  const stop = replayWith(l.deps).start(w.rt);
  const previous = w.rt.session.current() as SessionState;
  const next: SessionState = { ...previous, id: OTHER };
  w.rt.setSessionState(next);
  w.rt.sessionEvent({ type: "start", session: next, previous, local: true });
  l.resolve();
  await tick();
  assert.equal(w.rec.starts, 1);
  assert.equal(l.loads(), 1);
  segment(w);
  await settle(w);
  assert.deepEqual(
    w.uploads.map((u) => u.url.searchParams.get("session")),
    [OTHER],
  );
  stop();
});

test("a session kept while rrweb loads uploads as it records", async () => {
  const w = world({ sampled: false });
  const l = manualLoader(w);
  const stop = replayWith(l.deps, { onRetain: true }).start(w.rt);
  w.rt.setKept(true);
  w.rt.sessionEvent({ type: "kept", session: w.rt.session.current() as SessionState, local: true });
  l.resolve();
  await tick();
  assert.equal(w.rec.starts, 1);
  segment(w);
  await settle(w);
  assert.equal(w.uploads.length, 1);
  stop();
});

test("a failed load turns replay off for the page without throwing or retrying", async () => {
  const w = world();
  const l = manualLoader(w);
  const collector = replayWith(l.deps);
  const stop = collector.start(w.rt);
  l.reject(new Error("chunk failed"));
  await tick();
  assert.equal(w.rec.starts, 0);
  assert.equal(w.warnings.length, 1);
  assert.match(w.warnings[0] ?? "", /replay is off: the recorder did not load: Error: chunk failed/);
  const previous = w.rt.session.current() as SessionState;
  const next: SessionState = { ...previous, id: OTHER };
  w.rt.setSessionState(next);
  w.rt.sessionEvent({ type: "start", session: next, previous, local: true });
  stop();
  collector.start(w.rt)();
  await tick();
  assert.equal(l.loads(), 1, "the import is never retried");
  assert.equal(w.rec.starts, 0);
  assert.equal(w.warnings.length, 1, "it warns once");
});
