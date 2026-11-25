/**
 * WP1. The transport spec's page: createHttpTransport and createDelivery over the shared fake
 * queue and an open fake gate, driven through globalThis.__transport. Every fetch and beacon the
 * transport makes is logged to sessionStorage as it is made, so the spec can still read the log
 * after the page navigated away.
 */
import type { SendMode, SendResult } from "../../src/contracts/transport.ts";
import { createFakeGate, createFakeQueue } from "../../src/test-support/index.ts";
import { createDelivery } from "../../src/transport/delivery.ts";
import { createHttpTransport } from "../../src/transport/http.ts";

/** One request the transport made. */
export interface MadeRequest {
  readonly kind: "fetch" | "beacon";
  readonly keepalive: boolean;
  /** For a beacon, whether the browser accepted it. */
  readonly accepted?: boolean;
  readonly at: number;
}

/** One attempt the delivery made, with its result. */
export interface Attempt {
  readonly at: number;
  readonly result: SendResult;
}

/** Options for one transport. */
export interface PageTransportOptions {
  readonly endpoint: string;
  readonly compression?: "gzip" | "none";
  readonly headers?: Record<string, string>;
  /**
   * Every fetch is logged and never settles, with no request on the network: it holds this
   * transport's keepalive budget without using the browser's keepalive quota.
   */
  readonly holdFetch?: boolean;
}

/** What the spec calls through page.evaluate. */
export interface TransportPage {
  /** Builds a transport, named id, posting traces to `<endpoint>/v1/traces`. */
  create(id: string, opts: PageTransportOptions): void;
  /** One attempt on transport id. */
  send(id: string, body: string, mode: SendMode): Promise<SendResult>;
  /** Builds a delivery over transport id, a fake queue and an open gate. */
  createDelivery(id: string): void;
  deliver(id: string, body: string): Promise<string>;
  queued(id: string): Promise<number>;
  attempts(id: string): readonly Attempt[];
  /** A JSON body of about n random characters, which gzip shrinks little. */
  randomBody(n: number): string;
  /** The requests logged to sessionStorage, across navigations. */
  made(): MadeRequest[];
}

const LOG = "libo11y.transport.made";

function log(entry: MadeRequest): void {
  const prior = JSON.parse(sessionStorage.getItem(LOG) ?? "[]") as MadeRequest[];
  sessionStorage.setItem(LOG, JSON.stringify([...prior, entry]));
}

const loggingFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  log({ kind: "fetch", keepalive: init?.keepalive === true, at: Date.now() });
  return fetch(input, init);
}) as typeof fetch;

const holdingFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
  log({ kind: "fetch", keepalive: init?.keepalive === true, at: Date.now() });
  return new Promise<Response>(() => {});
}) as typeof fetch;

const loggingBeacon = (url: string, data: BodyInit): boolean => {
  const accepted = navigator.sendBeacon(url, data);
  log({ kind: "beacon", keepalive: false, accepted, at: Date.now() });
  return accepted;
};

const transports = new Map<string, ReturnType<typeof createHttpTransport>>();
const deliveries = new Map<
  string,
  {
    delivery: ReturnType<typeof createDelivery>;
    queue: ReturnType<typeof createFakeQueue>;
    attempts: Attempt[];
  }
>();

function transportOf(id: string): ReturnType<typeof createHttpTransport> {
  const t = transports.get(id);
  if (t === undefined) throw new Error(`no transport ${id}`);
  return t;
}

function deliveryOf(id: string) {
  const d = deliveries.get(id);
  if (d === undefined) throw new Error(`no delivery ${id}`);
  return d;
}

const api: TransportPage = {
  create(id, opts) {
    transports.set(
      id,
      createHttpTransport({
        endpoints: { traces: `${opts.endpoint}/v1/traces`, metrics: undefined, logs: undefined },
        compression: opts.compression ?? "gzip",
        ...(opts.headers === undefined ? {} : { headers: opts.headers }),
        fetch: opts.holdFetch === true ? holdingFetch : loggingFetch,
        sendBeacon: loggingBeacon,
      }),
    );
  },
  send: (id, body, mode) => transportOf(id).send({ signal: "traces", body, mode }),
  createDelivery(id) {
    const inner = transportOf(id);
    const attempts: Attempt[] = [];
    const queue = createFakeQueue();
    const delivery = createDelivery({
      transport: {
        async send(req) {
          const at = Date.now();
          const result = await inner.send(req);
          attempts.push({ at, result });
          return result;
        },
      },
      queue,
      gate: createFakeGate(true),
    });
    deliveries.set(id, { delivery, queue, attempts });
  },
  deliver: async (id, body) => (await deliveryOf(id).delivery.deliver({ signal: "traces", body })).outcome,
  queued: async (id) => (await deliveryOf(id).queue.size()).entries,
  attempts: (id) => deliveryOf(id).attempts,
  randomBody(n) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    let s = "";
    for (const b of bytes) s += (b % 36).toString(36);
    return JSON.stringify({ resourceSpans: [], pad: s });
  },
  made: () => JSON.parse(sessionStorage.getItem(LOG) ?? "[]") as MadeRequest[],
};

(globalThis as { __transport?: TransportPage }).__transport = api;
