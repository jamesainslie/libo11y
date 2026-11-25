/**
 * WP3. Imported first by setup-page.ts, before @libo11y/web, so the transport's pristine fetch and
 * sendBeacon are these wrappers: each export attempt is recorded in globalThis.__sends with how it
 * was sent, which the sink cannot see. Every call still goes through.
 */

/** One recorded send. */
export interface RecordedSend {
  readonly url: string;
  readonly via: "fetch" | "keepalive" | "beacon";
}

const sends: RecordedSend[] = [];
(globalThis as { __sends?: RecordedSend[] }).__sends = sends;

const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes("/sink/")) sends.push({ url, via: init?.keepalive === true ? "keepalive" : "fetch" });
  return realFetch(input, init);
}) as typeof fetch;

const realBeacon = navigator.sendBeacon.bind(navigator);
navigator.sendBeacon = (url: string | URL, data?: BodyInit | null): boolean => {
  sends.push({ url: String(url), via: "beacon" });
  return realBeacon(url, data);
};
