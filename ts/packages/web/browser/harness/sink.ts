/**
 * Scaffold, frozen. The specs' client for the fixture server's OTLP sink (server.ts). Runs on Node
 * inside Playwright.
 */
import type { APIRequestContext } from "@playwright/test";

/** One recorded OTLP request. */
export interface SinkRequest {
  readonly signal: "traces" | "metrics" | "logs" | "replay";
  readonly contentType: string;
  readonly encoding: string | null;
  readonly bytes: number;
  readonly origin: string | null;
  /** The request's query parameters, such as a replay upload's service, session and segment. */
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** A scripted sink answer. */
export interface ScriptedResponse {
  readonly status: number;
  readonly retryAfter?: string;
}

/** A sink of its own for one test. */
export interface TestSink {
  /** The OTLP base URL to pass as setup's endpoint, on the page's origin (127.0.0.1). */
  readonly endpoint: string;
  /** The same sink on the cross origin (localhost). */
  readonly crossOriginEndpoint: string;
  script(responses: readonly ScriptedResponse[]): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
  received(): Promise<readonly SinkRequest[]>;
  /** Sets the remote configuration document GET <endpoint>/v1/config serves. */
  setConfig(doc: { readonly version: string; readonly config: unknown }): Promise<void>;
  /** How many config requests the sink answered. */
  configRequests(): Promise<number>;
  /** Polls received() until predicate holds or timeoutMillis passes (default 10000), then returns it. */
  waitFor(
    predicate: (requests: readonly SinkRequest[]) => boolean,
    timeoutMillis?: number,
  ): Promise<readonly SinkRequest[]>;
}

/** A fresh sink with a unique id on the fixture server at baseURL. */
export function createSink(request: APIRequestContext, baseURL: string): TestSink {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const base = new URL(`/sink/${id}/`, baseURL);
  const cross = new URL(base);
  cross.hostname = "localhost";
  const received = async (): Promise<readonly SinkRequest[]> => {
    const res = await request.get(new URL("received", base).href);
    return ((await res.json()) as { requests: SinkRequest[] }).requests;
  };
  return {
    endpoint: base.href.replace(/\/$/, ""),
    crossOriginEndpoint: cross.href.replace(/\/$/, ""),
    async script(responses) {
      await request.post(new URL("script", base).href, { data: { responses } });
    },
    async setOffline(offline) {
      await request.post(new URL("offline", base).href, { data: { offline } });
    },
    received,
    async setConfig(doc) {
      await request.post(new URL("config", base).href, { data: doc });
    },
    async configRequests() {
      const res = await request.get(new URL("received", base).href);
      return ((await res.json()) as { configRequests: number }).configRequests;
    },
    async waitFor(predicate, timeoutMillis = 10_000) {
      const deadline = Date.now() + timeoutMillis;
      for (;;) {
        const got = await received();
        if (predicate(got)) return got;
        if (Date.now() > deadline)
          throw new Error(`sink: condition not met in ${timeoutMillis} ms; got ${got.length} requests`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}
