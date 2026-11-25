/**
 * The drift guard for otlp-transport.ts, which reimplements code upstream does not export. When
 * @opentelemetry/otlp-exporter-base changes one of the files the transport follows, or the
 * configuration it reads, a test here fails and says what to compare. The behaviour itself is
 * pinned in otlp-transport.test.ts.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { convertLegacyHttpOptions } from "@opentelemetry/otlp-exporter-base/node-http";
import { OTLP_EXPORTER_VERSION } from "./otlp-transport.ts";
import { clearedOtelEnv, withEnv } from "./test-support/env.ts";

/** The dist directory of the installed @opentelemetry/otlp-exporter-base. */
const DIST = dirname(createRequire(import.meta.url).resolve("@opentelemetry/otlp-exporter-base"));

/**
 * The upstream sources otlp-transport.ts follows, with the SHA-256 of each as shipped in
 * @opentelemetry/otlp-exporter-base 0.301.1.
 */
const FOLLOWED: Readonly<Record<string, string>> = {
  "platform/node/transport/http-transport-utils.mjs":
    "d9e9e85779384494d42c0570788b473e41b9d3842919267b5c7ae770f2e7f360",
  "platform/node/transport/http-exporter-transport.mjs":
    "b630a890e530e72195cd3370101c43400201ec0d89cefaa5044190b215343407",
  "retrying-transport.mjs": "7458c700aeba7d3fe9a550397b9b03327233693a370bc59626831653c0fcbbbb",
  "is-export-retryable.mjs": "b18447146c7900e1d1da63b34123408b78419e9cc19fcc1ed86c33e3a2193a3c",
};

test("the User-Agent names the otlp-exporter-base version that is installed", () => {
  const manifest = JSON.parse(readFileSync(join(DIST, "..", "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  assert.equal(manifest.name, "@opentelemetry/otlp-exporter-base");
  assert.equal(
    OTLP_EXPORTER_VERSION,
    manifest.version,
    "otlp-transport.ts sends upstream's User-Agent: set OTLP_EXPORTER_VERSION to the installed version",
  );
});

test("the upstream files the transport reimplements have not changed", () => {
  const changed: string[] = [];
  for (const [file, want] of Object.entries(FOLLOWED)) {
    let got: string;
    try {
      got = createHash("sha256")
        .update(readFileSync(join(DIST, file)))
        .digest("hex");
    } catch {
      got = "missing";
    }
    if (got !== want) changed.push(`${file} (now ${got})`);
  }
  assert.deepEqual(
    changed,
    [],
    "@opentelemetry/otlp-exporter-base changed a file that packages/server/src/otlp-transport.ts " +
      "reimplements. Compare the new upstream source with the transport: the request, the status and " +
      "network-error mapping, the retry loop and its diag messages. Bring the transport and " +
      "otlp-transport.test.ts into line, then record the new hashes here.",
  );
});

test("upstream's exporter configuration has exactly the members the exporters consume", async () => {
  const options = await withEnv(clearedOtelEnv(), () =>
    convertLegacyHttpOptions({}, "TRACES", "v1/traces", { "Content-Type": "application/x-protobuf" }),
  );
  // url, headers, compression, userAgent and agentFactory go to the transport. timeoutMillis and
  // concurrencyLimit go to upstream's export delegate. A member that is not in this list is one
  // nothing reads yet.
  assert.deepEqual(
    Object.keys(options).sort(),
    ["agentFactory", "compression", "concurrencyLimit", "headers", "timeoutMillis", "url", "userAgent"],
    "upstream's OTLP HTTP configuration gained or lost a member: decide what otlp-transport.ts and " +
      "exporters.ts do with it, then update this list",
  );
  assert.equal(options.url, "http://localhost:4318/v1/traces");
  assert.equal(options.timeoutMillis, 10_000);
  assert.equal(options.concurrencyLimit, 30);
  assert.equal(options.compression, "none");
  assert.equal(options.userAgent, undefined);
  assert.deepEqual(await options.headers(), { "Content-Type": "application/x-protobuf" });
  assert.equal(typeof options.agentFactory, "function");
});
