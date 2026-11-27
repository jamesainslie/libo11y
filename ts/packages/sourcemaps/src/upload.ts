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
   * deployed. A map whose upload failed is left in place. Default false.
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
  /** The HTTP status, or 0 when the gateway could not be reached. */
  readonly status: number;
  /** Absolute path of the script whose map failed to upload. */
  readonly script: string;

  constructor(message: string, status: number, script: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UploadError";
    this.status = status;
    this.script = script;
  }
}

/** Seams for tests. */
export interface UploadDeps {
  readonly sleep: (ms: number) => Promise<void>;
}

const UPLOAD_PATH = "_o11y/v1/sourcemaps";
const MAX_ATTEMPTS = 3;
const BACKOFF_MILLIS: readonly number[] = [200, 400];

const defaultDeps: UploadDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Finds the scripts with external source maps under options.directory and uploads each map to the
 * gateway's POST /_o11y/v1/sourcemaps, gzipped. A 429, a 5xx or a network failure is retried, up
 * to three attempts in all. Once an upload fails no further upload starts, and the first failure
 * is thrown as an UploadError after the uploads in flight settle.
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
  if (options.token === "") throw new TypeError("@libo11y/sourcemaps: the upload token is empty");
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
            : new UploadError(`upload of ${file.url} failed: ${String(err)}`, 0, file.script, { cause: err });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  const done = uploaded.filter((u): u is UploadedMap => u !== undefined);
  if (options.deleteAfterUpload === true) {
    const byScript = new Map(files.map((f) => [f.script, f]));
    for (const u of done) {
      const file = byScript.get(u.script);
      if (file !== undefined) await removeMap(file);
    }
  }
  if (failure !== undefined) throw failure;
  return done;
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
      });
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        await deps.sleep(BACKOFF_MILLIS[attempt - 1] ?? 400);
        continue;
      }
      throw new UploadError(
        `upload of ${file.url} could not reach the gateway: ${String(err)}`,
        0,
        file.script,
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
      await deps.sleep(BACKOFF_MILLIS[attempt - 1] ?? 400);
      continue;
    }
    throw new UploadError(
      `upload of ${file.url} failed with ${res.status}${detail === "" ? "" : `: ${detail}`}`,
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

// removeMap deletes an uploaded map and the script's sourceMappingURL comment when it is the
// script's last line.
async function removeMap(file: SourceMapFile): Promise<void> {
  await rm(file.map, { force: true });
  const text = await readFile(file.script, "utf8");
  if (mapComment(text) === undefined) return;
  const trimmed = text.trimEnd();
  const cut = trimmed.lastIndexOf("\n");
  await writeFile(file.script, cut < 0 ? "" : `${trimmed.slice(0, cut + 1)}`);
}
