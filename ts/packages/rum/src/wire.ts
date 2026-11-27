/**
 * The wire contract with the RUM gateway: every OTLP request carries the query parameters sent_at
 * (the client's Unix time in milliseconds at send time) and client_token (the app's public token),
 * because sendBeacon cannot set headers. The gateway uses sent_at to correct client clock skew.
 */
import { type HttpTransportOptions, pristineFetch, pristineSendBeacon } from "@libo11y/web/internal";

/** url with sent_at, and client_token when there is one, appended to its query. */
export function withWireParams(url: string, clientToken: string | undefined, sentAt: number): string {
  const params = new URLSearchParams({ sent_at: String(sentAt) });
  if (clientToken !== undefined) params.set("client_token", clientToken);
  return `${url}${url.includes("?") ? "&" : "?"}${params.toString()}`;
}

/**
 * The transport options with fetch and sendBeacon wrapped, so each attempt, retries included, posts
 * to the signal URL with the wire parameters of the moment it is sent.
 */
export function gatewayTransportOptions(
  opts: HttpTransportOptions,
  clientToken: string | undefined,
  now: () => number,
): HttpTransportOptions {
  const baseFetch = opts.fetch ?? pristineFetch;
  const baseBeacon = "sendBeacon" in opts ? opts.sendBeacon : pristineSendBeacon;
  const wrap = (url: string): string => withWireParams(url, clientToken, now());
  const fetchWithParams =
    baseFetch === undefined
      ? undefined
      : (((input: string | URL | Request, init?: RequestInit) =>
          baseFetch(input instanceof Request ? input : wrap(String(input)), init)) as typeof fetch);
  return {
    ...opts,
    ...(fetchWithParams === undefined ? {} : { fetch: fetchWithParams }),
    sendBeacon: baseBeacon === undefined ? undefined : (url, data) => baseBeacon(wrap(url), data),
  };
}
