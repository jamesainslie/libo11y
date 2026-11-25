/**
 * WP4. The fetch and XHR instrumentation in a real page. Query: ?consent=pending|granted (default
 * granted) and any number of ?propagateTo=<origin>. Exposes window.__inst once set up.
 */
import { installFetchInstrumentation } from "../../src/instrumentation/fetch.ts";
import { installXhrInstrumentation } from "../../src/instrumentation/xhr.ts";
import { type SpanJson, spanJson, startTelemetry } from "./instrumentation-common.ts";

interface Echo {
  readonly method: string;
  readonly headers: Record<string, string>;
}

const originalFetch = globalThis.fetch;
const { open: originalOpen, send: originalSend } = XMLHttpRequest.prototype;

const { telemetry, exporter, consent } = await startTelemetry();
const propagateTo = new URLSearchParams(location.search).getAll("propagateTo");
const uninstallFetch = installFetchInstrumentation({ telemetry, propagateTo });
const uninstallXhr = installXhrInstrumentation({ telemetry, propagateTo });

function xhrEcho(url: string, async: boolean): Promise<Echo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, async);
    xhr.addEventListener("loadend", () => {
      if (xhr.status === 0) reject(new Error("xhr failed"));
      else resolve(JSON.parse(xhr.responseText) as Echo);
    });
    xhr.send();
  });
}

const api = {
  fetchEcho: async (url: string): Promise<Echo> => (await fetch(url)).json() as Promise<Echo>,
  xhrEcho: (url: string): Promise<Echo> => xhrEcho(url, true),
  xhrEchoSync: (url: string): Promise<Echo> => xhrEcho(url, false),
  /** POSTs a Request built in a same-origin iframe, which fails instanceof Request in this realm. */
  fetchFrameRequest: async (url: string): Promise<Echo & { body: string }> => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      const FrameRequest = (frame.contentWindow as unknown as { Request: typeof Request }).Request;
      const req = new FrameRequest(url, { method: "POST", headers: { "x-app": "1" }, body: "payload" });
      return (await (await fetch(req)).json()) as Echo & { body: string };
    } finally {
      frame.remove();
    }
  },
  /** Fetches a data: URL and reads it back. */
  fetchData: async (): Promise<string> => (await fetch("data:text/plain,secret%20payload")).text(),
  grant: () => consent.grant(),
  /** The finished spans, after a flush, since the simple processor exports in a microtask. */
  spans: async (): Promise<SpanJson[]> => {
    await telemetry.forceFlush();
    return exporter.getFinishedSpans().map(spanJson);
  },
  /** Uninstalls both and reports whether everything patched was restored. */
  uninstall: () => {
    uninstallFetch();
    uninstallXhr();
    return {
      fetch: globalThis.fetch === originalFetch,
      open: XMLHttpRequest.prototype.open === originalOpen,
      send: XMLHttpRequest.prototype.send === originalSend,
    };
  },
};
(globalThis as { __inst?: typeof api }).__inst = api;
