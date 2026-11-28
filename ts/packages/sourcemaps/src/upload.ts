import { readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { findSourceMaps, mapComment, type SourceMapFile } from "./find.ts";

/** Options for uploadSourceMaps. */
export interface UploadOptions {
  /** The gateway's base URL, under which it serves /_o11y/v1/, such as "https://app.example.com". */
  readonly endpoint: string;
  /** The app's upload token, sent as a bearer token. */
  readonly token: string;
  /** The app's service.name. */
  readonly service: string;
  /** The release's service.version. */
  readonly version: string;
  /** The over-the-air update the maps belong to, o11y.rum.app.update_id, when there is one. */
  readonly updateId?: string;
  /** The URL path the directory is served at, such as "/assets/", or "~/" for the site root. */
  readonly urlPrefix: string;
  /** The build output directory to search. */
  readonly directory: string;
  /**
   * Removes each uploaded map and the sourceMappingURL comment of its script, so the maps are not
   * deployed. A map is left in place when the upload of any script it describes failed or did not
   * run. Default false.
   */
  readonly deleteAfterUpload?: boolean;
  /** The uploads in flight at once. Default 4. */
  readonly concurrency?: number;
  /** The fetch to use. Default globalThis.fetch. */
  readonly fetch?: typeof fetch;
}

/** A map the gateway stored. */
export interface UploadedMap {
  /** Absolute path of the script the map describes. */
  readonly script: string;
  /** The URL path the map was uploaded for. */
  readonly url: string;
  /** The object key the gateway stored the map under. */
  readonly key: string;
}

/** An upload the gateway refused, or that could not reach it. */
export class UploadError extends Error {
  /** The HTTP status, or 0 when the gateway could not be reached or the map could not be read. */
  readonly status: number;
  /** Absolute path of the script whose map failed to upload. */
  readonly script: string;
  /** The maps that did upload before the failure stopped the run. */
  readonly uploaded: readonly UploadedMap[];

  constructor(
    message: string,
    status: number,
    script: string,
    uploaded: readonly UploadedMap[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "UploadError";
    this.status = status;
    this.script = script;
    this.uploaded = uploaded;
  }
}

/** Seams for tests. */
export interface UploadDeps {
  readonly sleep: (ms: number) => Promise<void>;
  /** How long one attempt may take. Default 120000. */
  readonly timeoutMillis?: number;
}

const UPLOAD_PATH = "_o11y/v1/sourcemaps";
const MAX_ATTEMPTS = 3;
const BACKOFF_MILLIS: readonly number[] = [200, 400];
const MAX_RETRY_AFTER_MILLIS = 10_000;
const DEFAULT_TIMEOUT_MILLIS = 120_000;
// An HTTP header value can carry only visible ASCII without surprises. A token with anything else,
// such as a line break pasted into a CI secret, would make fetch throw an error quoting it.
const TOKEN = /^[\x21-\x7e]+$/;

const defaultDeps: UploadDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Finds the scripts with external source maps under options.directory and uploads each map to the
 * gateway's POST /_o11y/v1/sourcemaps, gzipped. A 429, a 5xx, a timeout or a network failure is
 * retried, up to three attempts in all, waiting for the response's Retry-After (at most ten
 * seconds) when it has one. Once an upload fails no further upload starts, and the first failure
 * is thrown as an UploadError, listing the maps that did upload, after the uploads in flight
 * settle.
 */
export function uploadSourceMaps(options: UploadOptions): Promise<UploadedMap[]> {
  return uploadSourceMapsWith(options, defaultDeps);
}

/** uploadSourceMaps with its seams, for tests. */
export async function uploadSourceMapsWith(options: UploadOptions, deps: UploadDeps): Promise<UploadedMap[]> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`@libo11y/sourcemaps: concurrency must be a positive integer, got ${concurrency}`);
  }
  checkToken(options.token);
  const base = endpointURL(options.endpoint);
  const doFetch = options.fetch ?? globalThis.fetch;
  const files = await findSourceMaps(options.directory, options.urlPrefix);
  const uploaded: (UploadedMap | undefined)[] = new Array(files.length);
  let failure: UploadError | undefined;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < files.length) {
      const i = next++;
      const file = files[i];
      if (file === undefined) continue;
      try {
        uploaded[i] = await uploadOne(base, options, file, doFetch, deps);
      } catch (err) {
        failure ??=
          err instanceof UploadError
            ? err
            : new UploadError(
                `reading ${file.map} failed: ${redact(describe(err), options.token)}`,
                0,
                file.script,
                [],
                { cause: err },
              );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  const done = uploaded.filter((u): u is UploadedMap => u !== undefined);
  if (options.deleteAfterUpload === true) await removeUploaded(files, uploaded);
  if (failure !== undefined) {
    throw new UploadError(failure.message, failure.status, failure.script, done, { cause: failure.cause });
  }
  return done;
}

/** Throws when token is empty or holds a character an HTTP header cannot carry. It never echoes it. */
export function checkToken(token: string): void {
  if (token === "") throw new TypeError("@libo11y/sourcemaps: the upload token is empty");
  if (!TOKEN.test(token)) {
    throw new TypeError(
      "@libo11y/sourcemaps: the upload token holds white space or characters an HTTP header cannot carry",
    );
  }
}

function endpointURL(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new TypeError(`@libo11y/sourcemaps: endpoint ${JSON.stringify(endpoint)} is not a URL`);
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL(UPLOAD_PATH, url);
}

// describe renders an error with its cause, where fetch keeps the reason a request failed, such as
// ECONNREFUSED or a certificate error.
function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause: unknown = err.cause;
  if (cause instanceof Error) return `${err.message}: ${cause.message}`;
  if (cause !== undefined && cause !== null) return `${err.message}: ${String(cause)}`;
  return err.message;
}

// redact removes the token from a message, whatever a runtime put in its error.
function redact(message: string, token: string): string {
  return token === "" ? message : message.split(token).join("[token]");
}

// retryDelay is the wait before attempt+1: the response's Retry-After in seconds, capped, or the
// backoff for the attempt.
function retryDelay(attempt: number, retryAfter: string | null): number {
  const backoff = BACKOFF_MILLIS[attempt - 1] ?? 400;
  if (retryAfter === null || !/^\d+$/.test(retryAfter.trim())) return backoff;
  return Math.min(Number(retryAfter.trim()) * 1000, MAX_RETRY_AFTER_MILLIS);
}

async function uploadOne(
  base: URL,
  options: UploadOptions,
  file: SourceMapFile,
  doFetch: typeof fetch,
  deps: UploadDeps,
): Promise<UploadedMap> {
  const url = new URL(base);
  url.searchParams.set("service", options.service);
  url.searchParams.set("version", options.version);
  if (options.updateId !== undefined && options.updateId !== "") {
    url.searchParams.set("update_id", options.updateId);
  }
  url.searchParams.set("url", file.url);
  const body = gzipSync(await readFile(file.map));
  const timeoutMillis = deps.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.token}`,
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
        body,
        signal: AbortSignal.timeout(timeoutMillis),
      });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await deps.sleep(retryDelay(attempt, null));
        continue;
      }
      const reason =
        err instanceof Error && err.name === "TimeoutError"
          ? `timed out after ${timeoutMillis} ms`
          : redact(describe(err), options.token);
      throw new UploadError(
        `upload of ${file.url} could not reach the gateway: ${reason}`,
        0,
        file.script,
        [],
        {
          cause: err,
        },
      );
    }
    if (res.ok) {
      const key = await keyOf(res);
      return { script: file.script, url: file.url, key };
    }
    const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      await deps.sleep(retryDelay(attempt, res.headers.get("retry-after")));
      continue;
    }
    throw new UploadError(
      `upload of ${file.url} failed with ${res.status}${detail === "" ? "" : `: ${redact(detail, options.token)}`}`,
      res.status,
      file.script,
    );
  }
}

async function keyOf(res: Response): Promise<string> {
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed === "object" && parsed !== null && "key" in parsed && typeof parsed.key === "string") {
      return parsed.key;
    }
  } catch {
    // A success without a JSON body still stored the map.
  }
  return "";
}

// removeUploaded strips the sourceMappingURL comment of every uploaded script, and deletes each map
// once every script it describes has uploaded.
async function removeUploaded(
  files: readonly SourceMapFile[],
  uploaded: readonly (UploadedMap | undefined)[],
): Promise<void> {
  const pending = new Map<string, number>();
  for (const [i, f] of files.entries()) {
    if (uploaded[i] === undefined) pending.set(f.map, (pending.get(f.map) ?? 0) + 1);
  }
  const removed = new Set<string>();
  for (const [i, f] of files.entries()) {
    if (uploaded[i] === undefined) continue;
    await stripComment(f.script);
    if (!pending.has(f.map) && !removed.has(f.map)) {
      removed.add(f.map);
      await rm(f.map, { force: true });
    }
  }
}

// stripComment removes a script's sourceMappingURL comment when it is the last line. It works on
// latin1 text, which maps every byte to one character, so a script that is not UTF-8 keeps its
// bytes.
async function stripComment(script: string): Promise<void> {
  const text = await readFile(script, "latin1");
  if (mapComment(text) === undefined) return;
  const trimmed = text.trimEnd();
  const cut = trimmed.lastIndexOf("\n");
  await writeFile(script, cut < 0 ? "" : trimmed.slice(0, cut + 1), "latin1");
}
