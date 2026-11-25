/**
 * The OTLP/HTTP transport of the server exporters: one POST per export, retried while the collector
 * asks for it. It reimplements two things upstream does not export, the node transport and the
 * retrying transport of @opentelemetry/otlp-exporter-base 0.301.1, and follows them in everything a
 * collector or a diag logger sees: the request and its framing, gzip, the User-Agent, which
 * statuses and network errors are retried, the backoff, Retry-After, the time a retry is given, the
 * 4 MiB cap on a response body, and the diag messages about retries.
 *
 * It exists because upstream's cannot be stopped, and a transport that cannot be stopped keeps an
 * exiting process alive. It differs from upstream in five ways, and only these:
 *
 * 1. The timeout covers the whole attempt: connecting, sending and reading the response. Upstream
 *    arms ClientRequest.setTimeout, an idle timeout that Node applies only once the socket has
 *    connected. So a connection that never completes had no timeout at all and held the process for
 *    as long as the operating system kept trying. The other side of this change is that a response
 *    which trickles in for longer than the timeout now fails, where upstream let it run as long as
 *    bytes kept coming.
 * 2. abort() ends what is in flight: each request is destroyed, each wait between two retries is
 *    cancelled, and every later send fails at once. Upstream's shutdown() does nothing.
 * 3. shutdown() also destroys the agent, which closes its idle keep-alive sockets.
 * 4. Sends that start before the agent is built share one agent. Upstream builds one for each of
 *    them and keeps the last.
 * 5. A wait before a retry that is longer than a timer can hold is clamped to the longest a timer
 *    holds, about 24.8 days. Upstream's fires after a millisecond.
 *
 * A gzip body is also compressed in one call where upstream streams it, which can change how the
 * same bytes are split into chunks and nothing else.
 *
 * Unreferencing the socket would not do in place of destroying it: under Node a connection attempt
 * in progress keeps the event loop alive even on an unreferenced socket.
 *
 * One thing abort() cannot end under Node: a name lookup in progress. Node cannot cancel
 * getaddrinfo, so when the collector's host name does not resolve and the resolver does not answer,
 * the export fails on time but the process stays alive until the resolver gives up.
 *
 * otlp-transport.test.ts pins each of these behaviours, and fails when the upstream files this one
 * follows change, so an upgrade is checked against them again.
 */
import type { Agent, ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { gzip } from "node:zlib";
import { diag } from "@opentelemetry/api";
import {
  type ExportResponse,
  type IExporterTransport,
  OTLPExporterError,
} from "@opentelemetry/otlp-exporter-base";

/** The version of @opentelemetry/otlp-exporter-base this transport follows, for the User-Agent. */
export const OTLP_EXPORTER_VERSION = "0.301.1";

const DEFAULT_USER_AGENT = `OTel-OTLP-Exporter-JavaScript/${OTLP_EXPORTER_VERSION}`;

/** The largest response body read. A larger one fails the export, whatever its status. */
export const MAX_RESPONSE_BODY_SIZE: number = 4 * 1024 * 1024;

/** The longest delay a timer takes. Node and Bun treat anything larger as 1 ms. */
export const MAX_TIMER_MILLIS: number = 2 ** 31 - 1;

const MAX_ATTEMPTS = 5;
const INITIAL_BACKOFF = 1000;
const MAX_BACKOFF = 5000;
const BACKOFF_MULTIPLIER = 1.5;
const JITTER = 0.2;

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

const RETRYABLE_NETWORK_ERRORS: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/**
 * What the transport takes from an exporter's configuration, as upstream's convertLegacyHttpOptions
 * gives it. The configuration's other two members, timeoutMillis and concurrencyLimit, go to
 * upstream's export delegate. A test fails when upstream's configuration gains a member, so a new
 * one is never ignored without a decision.
 */
export interface HttpTransportParameters {
  readonly url: string;
  readonly headers: () => Promise<Record<string, string>>;
  readonly compression: "gzip" | "none";
  /** A prefix for the User-Agent header. */
  readonly userAgent?: string | undefined;
  /** Builds the agent for a protocol, "http:" or "https:": upstream's, which carries the certificates. */
  readonly agentFactory: (protocol: string) => Agent | Promise<Agent>;
}

/**
 * The clock, the timers and the random numbers the transport uses. A test replaces them to decide
 * when time passes and how much jitter a retry gets.
 */
export interface TransportTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** A number from 0 up to, not including, 1, drawn once for the jitter of each wait. */
  random(): number;
}

const REAL_TIMERS: TransportTimers = {
  random: () => Math.random(),
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A transport whose work in flight can be ended. */
export interface AbortableTransport extends IExporterTransport {
  /**
   * Ends every send in flight with a failure, and makes every later send fail at once. Nothing the
   * transport started keeps the process alive afterwards, except a name lookup Node cannot cancel.
   * Idempotent.
   */
  abort(): void;
}

type Requester = (
  url: URL,
  options: RequestOptions,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

interface Io {
  readonly agent: Agent;
  readonly request: Requester;
}

function aborted(): ExportResponse {
  return { status: "failure", error: new Error("the export was aborted at shutdown") };
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function retryableNetworkError(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_NETWORK_ERRORS.has(code);
}

/**
 * The Retry-After header as upstream reads it: a number of seconds, or an HTTP date measured from
 * now. Zero or fewer seconds is -1, a date in the past or one that does not parse is 0, and both
 * mean at once.
 */
export function retryAfterMillis(header: string | undefined, now: number): number | undefined {
  if (header === undefined) return undefined;
  const seconds = Number.parseInt(header, 10);
  if (Number.isInteger(seconds)) return seconds > 0 ? seconds * 1000 : -1;
  const delay = new Date(header).getTime() - now;
  if (delay >= 0) return delay;
  return 0;
}

// jitter is upstream's: a fifth either way, from a random number in [0, 1).
function jitter(random: number): number {
  return random * (2 * JITTER) - JITTER;
}

class HttpTransport implements AbortableTransport {
  private readonly params: HttpTransportParameters;
  private readonly timers: TransportTimers;
  private readonly url: URL;
  private io: Promise<Io> | undefined;
  private stopped = false;
  /** Ends each attempt in flight with the response given. */
  private readonly inFlight = new Set<(response: ExportResponse) => void>();
  /** Ends each wait between two retries: true when the time passed, false when it was cut short. */
  private readonly waiting = new Set<(passed: boolean) => void>();

  constructor(params: HttpTransportParameters, timers: TransportTimers) {
    this.params = params;
    this.timers = timers;
    this.url = new URL(params.url);
  }

  // send is upstream's RetryingTransport.send, statement for statement, with the wait between two
  // attempts made cancellable. A retry is given the time that was left when it was scheduled, as
  // upstream gives it, so it can end later than the timeout by the length of the wait.
  async send(data: Uint8Array, timeoutMillis: number): Promise<ExportResponse> {
    let attempts = MAX_ATTEMPTS;
    let nextBackoff = INITIAL_BACKOFF;
    const deadline = this.timers.now() + timeoutMillis;
    let result = await this.attempt(data, timeoutMillis);
    while (result.status === "retryable" && attempts > 0) {
      attempts--;
      const backoff = Math.max(Math.min(nextBackoff * (1 + jitter(this.timers.random())), MAX_BACKOFF), 0);
      nextBackoff = nextBackoff * BACKOFF_MULTIPLIER;
      const retryInMillis = result.retryInMillis ?? backoff;
      const remainingTimeoutMillis = deadline - this.timers.now();
      if (retryInMillis > remainingTimeoutMillis) {
        diag.info(
          `Export retry time ${Math.round(retryInMillis)}ms exceeds remaining timeout ${Math.round(
            remainingTimeoutMillis,
          )}ms, not retrying further.`,
        );
        return result;
      }
      diag.verbose(`Scheduling export retry in ${Math.round(retryInMillis)}ms`);
      if (!(await this.wait(retryInMillis))) return aborted();
      result = await this.attempt(data, remainingTimeoutMillis);
    }
    if (result.status === "success") {
      diag.verbose(`Export succeeded after ${MAX_ATTEMPTS - attempts} retry attempts.`);
    } else if (result.status === "retryable") {
      diag.info(`Export failed after maximum retry attempts (${MAX_ATTEMPTS}).`);
    } else {
      diag.info(`Export failed with non-retryable error: ${result.error}`);
    }
    return result;
  }

  abort(): void {
    this.stopped = true;
    for (const end of [...this.inFlight]) end(aborted());
    for (const wake of [...this.waiting]) wake(false);
  }

  shutdown(): void {
    this.abort();
    // The idle keep-alive sockets go too. The agent was never built if nothing was ever sent.
    void this.io?.then(
      ({ agent }) => agent.destroy(),
      () => {},
    );
  }

  // arm sets a timer, clamped to what a timer can wait: a longer delay would fire after 1 ms.
  private arm(fn: () => void, ms: number): unknown {
    return this.timers.setTimeout(fn, Math.min(Math.max(ms, 0), MAX_TIMER_MILLIS));
  }

  // load builds the agent and loads the request function once. Sends that start together share
  // one agent. A failure is not kept: the next send tries again, as upstream's does. The http
  // modules are imported only here, as upstream does, so an HTTP instrumentation loaded later can
  // still patch them.
  private load(): Promise<Io> {
    if (this.io === undefined) {
      const loading = (async (): Promise<Io> => {
        const protocol = this.url.protocol;
        const [agent, mod] = await Promise.all([
          this.params.agentFactory(protocol),
          protocol === "http:" ? import("node:http") : import("node:https"),
        ]);
        return { agent, request: mod.request as Requester };
      })();
      this.io = loading;
      loading.catch(() => {
        if (this.io === loading) this.io = undefined;
      });
    }
    return this.io;
  }

  // wait resolves true after ms, or false as soon as the transport is aborted.
  private wait(ms: number): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      const wake = (passed: boolean): void => {
        this.timers.clearTimeout(timer);
        this.waiting.delete(wake);
        resolve(passed);
      };
      const timer = this.arm(() => wake(true), ms);
      this.waiting.add(wake);
    });
  }

  // attempt makes one request and resolves with what became of it. It rejects only when the agent
  // or the headers cannot be built, as upstream's does, and upstream's export delegate reports
  // that rejection as a failed export.
  private async attempt(data: Uint8Array, timeoutMillis: number): Promise<ExportResponse> {
    if (this.stopped) return aborted();
    const io = await this.load();
    const headers: Record<string, string> = { ...(await this.params.headers()) };
    if (this.stopped) return aborted();
    const userAgent = this.params.userAgent;
    headers["User-Agent"] = userAgent ? `${userAgent} ${DEFAULT_USER_AGENT}` : DEFAULT_USER_AGENT;
    const gzipped = this.params.compression === "gzip";
    if (gzipped) headers["Content-Encoding"] = "gzip";

    return new Promise<ExportResponse>((resolve) => {
      let settled = false;
      let timer: unknown;
      let req: ClientRequest | undefined;
      const settle = (response: ExportResponse): void => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        this.inFlight.delete(end);
        resolve(response);
      };
      // end settles the attempt and then destroys the request, whose own error is then ignored.
      const end = (response: ExportResponse): void => {
        settle(response);
        req?.destroy();
      };
      this.inFlight.add(end);
      // The timeout runs from here, so it also bounds a connection that never completes.
      timer = this.arm(
        () => end({ status: "retryable", error: new Error("Request timed out") }),
        timeoutMillis,
      );
      try {
        req = io.request(this.url, { method: "POST", headers, agent: io.agent }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BODY_SIZE) {
              settle({
                status: "failure",
                error: new Error(
                  `OTLP export response body exceeded size limit of ${MAX_RESPONSE_BODY_SIZE} bytes`,
                ),
              });
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          const retryAfter = (): { retryInMillis?: number } => {
            const retryInMillis = retryAfterMillis(res.headers["retry-after"], this.timers.now());
            return retryInMillis === undefined ? {} : { retryInMillis };
          };
          res.on("end", () => {
            const status = res.statusCode;
            if (status && status <= 299) {
              settle({ status: "success", data: Buffer.concat(chunks) });
            } else if (status && RETRYABLE_STATUSES.has(status)) {
              settle({ status: "retryable", ...retryAfter() });
            } else {
              settle({
                status: "failure",
                error: new OTLPExporterError(res.statusMessage, status, Buffer.concat(chunks).toString()),
              });
            }
          });
          // A response that breaks off after its status line: upstream counts a 2xx as delivered,
          // retries a retryable status, and fails anything else.
          res.on("error", (error) => {
            const status = res.statusCode;
            if (status && status <= 299) {
              settle({ status: "success" });
            } else if (status && RETRYABLE_STATUSES.has(status)) {
              settle({ status: "retryable", error, ...retryAfter() });
            } else {
              settle({ status: "failure", error });
            }
          });
        });
        req.on("error", (error) => {
          settle(
            retryableNetworkError(error) ? { status: "retryable", error } : { status: "failure", error },
          );
        });
        // The body is written and then ended, as upstream's stream is. Node frames that as chunked,
        // where ending with the data in one call would send a Content-Length. Bun buffers a request
        // body whichever way it is written and sends a Content-Length. For a body that is not
        // compressed, upstream's transport sends the same under Bun. For a gzip body it does not:
        // upstream pipes a gzip stream, which Bun frames as chunked, and this transport compresses
        // the body first, so Bun sends its length. A collector reads either.
        const body = req;
        const sendBody = (bytes: Uint8Array): void => {
          body.write(bytes);
          body.end();
        };
        if (gzipped) {
          gzip(data, (error, compressed) => {
            if (settled) return;
            if (error !== null) end({ status: "failure", error });
            else sendBody(compressed);
          });
        } else {
          sendBody(data);
        }
      } catch (err) {
        end({ status: "failure", error: asError(err) });
      }
    });
  }
}

/**
 * Creates the transport for one exporter. Nothing is connected or loaded until the first send.
 * timers is for tests, which decide when time passes.
 */
export function createHttpTransport(
  params: HttpTransportParameters,
  timers: TransportTimers = REAL_TIMERS,
): AbortableTransport {
  return new HttpTransport(params, timers);
}
