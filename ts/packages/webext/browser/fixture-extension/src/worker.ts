/**
 * WP5. The test extension's service worker. It counts its wakes in IndexedDB (the harness spec
 * checks that survives a stop) and runs setupWorker with the configuration a spec stored under
 * "fixture.config", on every wake, so a fresh worker after a stop picks up where the last left.
 *
 * Messages it answers, besides the libo11y protocol setupWorker handles:
 *   { type: "wake" }                         { wakes }
 *   { type: "fixture-configure", config }    stores config, sets up, { ok } or { error }
 *   { type: "fixture-flush" }                forceFlush, { ok }
 *   { type: "fixture-queue" }                { entries } in the libo11y IndexedDB queue
 *   { type: "fixture-consent" }              { state }
 * and the traced payload { op: "child", name } by starting and ending a span named name in the
 * sender's context, answering its { traceId, spanId }.
 */
import * as webext from "@libo11y/webext";

declare const chrome: webext.ChromeLike;

/** What a spec stores under "fixture.config". */
interface FixtureConfig {
  readonly endpoint: string;
  readonly consent?: webext.ConsentState;
}

const CONFIG_KEY = "fixture.config";

function wakes(): Promise<number> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("harness", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("wakes");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("wakes", "readwrite");
      const store = tx.objectStore("wakes");
      const get = store.get("count");
      get.onsuccess = () => {
        const count = ((get.result as number | undefined) ?? 0) + 1;
        store.put(count, "count");
        tx.oncomplete = () => resolve(count);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

// queueEntries counts the libo11y queue's entries, 0 when it does not exist yet.
function queueEntries(): Promise<number> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("libo11y");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("otlp-batches")) {
        db.close();
        resolve(0);
        return;
      }
      const count = db.transaction("otlp-batches", "readonly").objectStore("otlp-batches").count();
      count.onsuccess = () => {
        db.close();
        resolve(count.result);
      };
      count.onerror = () => reject(count.error);
    };
  });
}

const state = { exports: Object.keys(webext).sort(), wakes: wakes() };
(globalThis as { __harness?: unknown }).__harness = state;

let telemetry: Promise<webext.WorkerTelemetry> | undefined;

function start(config: FixtureConfig): Promise<webext.WorkerTelemetry> {
  telemetry ??= webext
    .setupWorker({
      serviceName: "fixture-worker",
      environment: "test",
      startupSummary: false,
      endpoint: config.endpoint,
      consent: { initial: config.consent ?? "granted" },
      transport: { initialBackoffMillis: 200, maxBackoffMillis: 500, timeoutMillis: 3000 },
    })
    .then((handle) => {
      handle.onMessage((payload) => {
        const p = payload as { op?: string; name?: string };
        if (p.op !== "child") return undefined;
        const span = handle.tracerProvider.getTracer("fixture").startSpan(p.name ?? "worker-child");
        span.end();
        const { traceId, spanId } = span.spanContext();
        return { traceId, spanId };
      });
      return handle;
    });
  return telemetry;
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  const m = message as { type?: string; config?: FixtureConfig };
  const answer = (work: Promise<unknown>): true => {
    work.then(reply, (err: unknown) => reply({ error: errorText(err) }));
    return true;
  };
  switch (m.type) {
    case "wake":
      return answer(state.wakes.then((n) => ({ wakes: n })));
    case "fixture-configure": {
      const config = m.config;
      if (config === undefined) return answer(Promise.reject(new Error("no config")));
      return answer(
        (async () => {
          await chrome.storage?.local.set({ [CONFIG_KEY]: config });
          await start(config);
          return { ok: true };
        })(),
      );
    }
    case "fixture-flush":
      return answer(
        (async () => {
          const report = await (await (telemetry ?? Promise.reject(new Error("not set up")))).forceFlush();
          return { ok: report.ok };
        })(),
      );
    case "fixture-queue":
      return answer(queueEntries().then((entries) => ({ entries })));
    case "fixture-consent":
      return answer(
        (async () => ({
          state: (await (telemetry ?? Promise.reject(new Error("not set up")))).consent.state(),
        }))(),
      );
    default:
      return undefined;
  }
});

// Every wake: set up again with the stored configuration, which also drains the persisted queue.
void chrome.storage?.local.get(CONFIG_KEY).then((items) => {
  const config = items[CONFIG_KEY] as FixtureConfig | undefined;
  if (config !== undefined) void start(config).catch(() => {});
});
