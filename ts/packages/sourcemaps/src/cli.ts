#!/usr/bin/env node
/// <reference types="node" />
/**
 * The libo11y-sourcemaps command. `libo11y-sourcemaps upload ... DIR` uploads the source maps of a
 * build to the libo11y RUM gateway, for use in a build or deploy job.
 *
 * The upload token is read only from an environment variable, never from a flag, so it never
 * appears in a process list.
 *
 * Exit status: 0 when every map uploaded, 1 when an upload failed or the directory holds no maps,
 * 2 on a usage error.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkToken, UploadError, type UploadOptions, uploadSourceMaps } from "./upload.ts";
import { VERSION } from "./version.ts";

const USAGE = `usage: libo11y-sourcemaps upload --endpoint URL --service NAME --release VERSION --url-prefix PREFIX
                          [--update-id ID] [--token-env VAR] [--concurrency N] [--delete] DIR

Uploads every source map under DIR to the RUM gateway at URL, for the app NAME at release VERSION.

  --endpoint URL       the gateway's base URL, under which it serves /_o11y/v1/
  --service NAME       the app's service.name
  --release VERSION    the release's service.version
  --url-prefix PREFIX  the URL path DIR is served at, such as /assets/, or ~/ for the site root
  --update-id ID       the over-the-air update the maps belong to (o11y.rum.app.update_id)
  --token-env VAR      the environment variable holding the upload token (default O11Y_SOURCEMAPS_TOKEN)
  --concurrency N      uploads in flight at once (default 4)
  --delete             remove each uploaded map and its sourceMappingURL comment from DIR
  --help               print this help
  --version            print the version`;

const DEFAULT_TOKEN_ENV = "O11Y_SOURCEMAPS_TOKEN";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Runs the command and returns its exit status. */
export async function run(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  out: (line: string) => void,
  err: (line: string) => void,
  upload: (options: UploadOptions) => Promise<readonly { url: string; key: string }[]> = uploadSourceMaps,
): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (e) {
    err(`libo11y-sourcemaps: ${message(e)}`);
    err(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    out(USAGE);
    return 0;
  }
  if (values.version === true) {
    out(VERSION);
    return 0;
  }
  if (positionals[0] !== "upload" || positionals.length !== 2) {
    err(USAGE);
    return 2;
  }
  const directory = positionals[1] ?? "";
  for (const flag of ["endpoint", "service", "release", "url-prefix"] as const) {
    if (values[flag] === undefined || values[flag] === "") {
      err(`libo11y-sourcemaps: --${flag} is required`);
      err(USAGE);
      return 2;
    }
  }
  const concurrency = values.concurrency === undefined ? 4 : Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    err(`libo11y-sourcemaps: --concurrency must be a positive integer, got ${values.concurrency}`);
    return 2;
  }
  try {
    new URL(values.endpoint ?? "");
  } catch {
    err(`libo11y-sourcemaps: --endpoint ${values.endpoint} is not a URL`);
    return 2;
  }
  const tokenEnv = values["token-env"] ?? DEFAULT_TOKEN_ENV;
  const token = (env[tokenEnv] ?? "").trim();
  if (token === "") {
    err(`libo11y-sourcemaps: the upload token variable ${tokenEnv} is not set`);
    return 2;
  }
  try {
    checkToken(token);
  } catch (e) {
    err(`libo11y-sourcemaps: ${tokenEnv}: ${message(e)}`);
    return 2;
  }
  const options: UploadOptions = {
    endpoint: values.endpoint ?? "",
    token,
    service: values.service ?? "",
    version: values.release ?? "",
    urlPrefix: values["url-prefix"] ?? "",
    directory,
    deleteAfterUpload: values.delete === true,
    concurrency,
    ...(values["update-id"] === undefined ? {} : { updateId: values["update-id"] }),
  };
  let uploaded: readonly { url: string; key: string }[];
  try {
    uploaded = await upload(options);
  } catch (e) {
    if (e instanceof UploadError) {
      for (const u of e.uploaded) out(`uploaded ${u.url} -> ${u.key}`);
    }
    err(`libo11y-sourcemaps: ${message(e)}`);
    return 1;
  }
  if (uploaded.length === 0) {
    err(`libo11y-sourcemaps: no source maps found under ${directory}`);
    return 1;
  }
  for (const u of uploaded) out(`uploaded ${u.url} -> ${u.key}`);
  return 0;
}

function parse(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      endpoint: { type: "string" },
      service: { type: "string" },
      release: { type: "string" },
      "url-prefix": { type: "string" },
      "update-id": { type: "string" },
      "token-env": { type: "string" },
      concurrency: { type: "string" },
      delete: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
}

// isEntry reports whether this module is the program being run. It compares the resolved script path,
// which follows the bin symlink npm installs, because import.meta.main needs Node 24.2 or later.
function isEntry(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = await run(
    process.argv.slice(2),
    process.env,
    (line) => process.stdout.write(`${line}\n`),
    (line) => process.stderr.write(`${line}\n`),
  );
}
