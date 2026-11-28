/**
 * Session replay end to end through a real o11yrum-gateway built from the checkout: a browser
 * session records with replay(), its RUM signals and segments go to the gateway, the gateway
 * scrubs and stores the segments, and a player backend reads them back through the read API with
 * a bearer token and replays them with @rrweb/replay. Then the session is erased and the read API
 * returns nothing. It runs only when O11YRUM_GATEWAY_BIN names the gateway binary
 * (`make rum-e2e`), so the browser suites need no Go toolchain.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type OtlpSink, startOtlpSink } from "../../test/src/sink.ts";

const BIN = process.env.O11YRUM_GATEWAY_BIN ?? "";
const SERVICE = "rum-replay-fixture";
const READ_TOKEN = "player-backend-0123456789abcdef";

test.skip(BIN === "", "set O11YRUM_GATEWAY_BIN (make rum-e2e) to run the gateway journey");

interface Gateway {
  /** The public listener's base URL. */
  readonly base: string;
  /** The read API listener's base URL. */
  readonly read: string;
  readonly sink: OtlpSink;
  stop(): Promise<void>;
}

/** Starts a gateway that records replay for the fixture app on origin, with unmaskedText as set. */
async function startGateway(origin: string, unmaskedText: boolean): Promise<Gateway> {
  const sink = await startOtlpSink();
  const dir = mkdtempSync(join(tmpdir(), "o11yrum-replay-e2e-"));
  writeFileSync(join(dir, "read-tokens"), `# the player backend\n${READ_TOKEN}\n`);
  writeFileSync(
    join(dir, "gateway.yaml"),
    [
      "listen: 127.0.0.1:0",
      "environment: test",
      "edge: {rate_limit_per_minute: 1000}",
      "object_store: {filesystem: {root: store}}",
      "replay: {read_listen: 127.0.0.1:0, read_token_file: read-tokens}",
      "apps:",
      `  - service_name: ${SERVICE}`,
      `    origins: ["${origin}"]`,
      `    replay: {enabled: true, unmasked_text: ${unmaskedText}}`,
      `sinks: {otlp: {endpoint: "${sink.url}", compression: none}}`,
      "",
    ].join("\n"),
  );
  const child = spawn(BIN, ["-config", join(dir, "gateway.yaml")], {
    env: {
      ...process.env,
      OTEL_TRACES_EXPORTER: "none",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;
    }
    await sink.close();
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const [base, read] = await addresses(child);
    return { base: `http://${base}`, read: `http://${read}`, sink, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/** Resolves the public and read API addresses from the gateway's "listening on" lines. */
function addresses(child: ChildProcess): Promise<[string, string]> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`the gateway did not start:\n${output}`)), 10_000);
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const base = /o11yrum-gateway: listening on (\S+)/.exec(output)?.[1];
      const read = /o11yrum-gateway: replay read API listening on (\S+)/.exec(output)?.[1];
      if (base !== undefined && read !== undefined) {
        clearTimeout(timer);
        resolve([base, read]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the gateway exited with ${code}:\n${output}`));
    });
  });
}

interface FixtureWindow {
  __rumStart(o: unknown): Promise<void>;
  __rum: { sessionId(): string | undefined };
}

interface SegmentMeta {
  readonly segment: number;
  readonly session: string;
  readonly service: string;
  readonly event_count: number;
}

interface StoredSegment {
  readonly segment: number;
  readonly session: string;
  readonly service: string;
  readonly events: readonly unknown[];
}

interface Played {
  readonly heading: string | null;
  readonly name: string | null;
  readonly masked: string | null;
  readonly email: string | null;
}

/** Records a session that sends everything to gw, interacts with every private element, and hides
 * the page so the open segment uploads. Returns the session ID. */
async function recordSession(page: Page, gw: Gateway): Promise<string> {
  await page.goto("/page/rum-replay-replay");
  await page.waitForFunction(() => "__rumStart" in globalThis);
  await page.evaluate(
    (endpoint) => (globalThis as unknown as FixtureWindow).__rumStart({ endpoint }),
    `${gw.base}/_o11y`,
  );
  // The recorder loads lazily when the session starts.
  await page.waitForTimeout(300);
  await page.locator("#email").pressSequentially("typedS3cret");
  await page.fill("#notes", "draftS3cret");
  await page.evaluate(() => {
    const name = document.getElementById("name");
    if (name !== null) name.textContent = "John Roe";
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  const session = await page.evaluate(() => (globalThis as unknown as FixtureWindow).__rum.sessionId());
  expect(session).toMatch(/^[0-9a-f-]{36}$/);
  return session ?? "";
}

function readAPI(gw: Gateway, path: string, method = "GET"): Promise<Response> {
  return fetch(`${gw.read}/v1/replay/${SERVICE}/sessions/${path}`, {
    method,
    headers: { authorization: `Bearer ${READ_TOKEN}` },
  });
}

/** Polls the read API's list route until it lists at least one segment. */
async function listSegments(gw: Gateway, session: string): Promise<SegmentMeta[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const res = await readAPI(gw, session);
    if (res.status === 200) {
      const body = (await res.json()) as { segments: SegmentMeta[] };
      if (body.segments.length > 0) return body.segments;
    } else {
      await res.body?.cancel();
    }
    if (Date.now() > deadline) throw new Error(`no segment listed within 10 s (last status ${res.status})`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Replays events with @rrweb/replay on the player fixture page and returns what it shows. */
async function play(page: Page, events: readonly unknown[]): Promise<Played> {
  const player = await page.context().newPage();
  await player.goto("/page/rum-replay-player");
  await player.waitForFunction(() => "__play" in globalThis);
  const played = await player.evaluate(
    (evs) => (globalThis as unknown as { __play(e: unknown): Promise<Played> }).__play(evs),
    events,
  );
  await player.close();
  return played;
}

type AttrValue = { stringValue?: string; intValue?: string | number };
interface LogsRequest {
  readonly resourceLogs?: readonly {
    readonly scopeLogs?: readonly {
      readonly logRecords?: readonly {
        readonly attributes?: readonly { readonly key: string; readonly value: AttrValue }[];
      }[];
    }[];
  }[];
}

/** Waits for the sink to hold an o11y.rum.error record and returns its attributes. */
async function errorRecord(sink: OtlpSink): Promise<Map<string, AttrValue>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    for (const req of sink.logs() as readonly LogsRequest[]) {
      for (const rl of req.resourceLogs ?? []) {
        for (const sl of rl.scopeLogs ?? []) {
          for (const lr of sl.logRecords ?? []) {
            const attrs = new Map((lr.attributes ?? []).map((a) => [a.key, a.value]));
            if (attrs.get("event.name")?.stringValue === "o11y.rum.error") return attrs;
          }
        }
      }
    }
    if (Date.now() > deadline) throw new Error("no o11y.rum.error record reached the sink within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const SECRETS = [
  "Jane Doe",
  "John Roe",
  "masked inside",
  "jane@x.test",
  "typedS3cret",
  "draftS3cret",
  "s3cr3t",
];

test("a strict gateway stores, serves and replays a masked session, then erases it", async ({
  page,
  baseURL,
}) => {
  const gw = await startGateway(new URL(baseURL ?? "").origin, false);
  try {
    const session = await recordSession(page, gw);

    // The read API needs the token.
    const anonymous = await fetch(`${gw.read}/v1/replay/${SERVICE}/sessions/${session}`);
    expect(anonymous.status).toBe(401);
    await anonymous.body?.cancel();

    const segments = await listSegments(gw, session);
    expect(segments[0]).toMatchObject({ segment: 0, session, service: SERVICE });
    expect(segments[0]?.event_count).toBeGreaterThan(1);

    // The segment is served gzipped; fetch inflates it.
    const res = await readAPI(gw, `${session}/segments/0`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const stored = (await res.json()) as StoredSegment;
    expect(stored).toMatchObject({ segment: 0, session, service: SERVICE });
    const text = JSON.stringify(stored);
    for (const secret of [...SECRETS, "Public heading"]) expect(text, secret).not.toContain(secret);

    // The gateway masks all text by default, the app's unmask list included.
    const played = await play(page, stored.events);
    expect(played.heading).toMatch(/^\*+ \*+$/);
    expect(played.name).toMatch(/^\*+ \*+$/);
    expect(played.masked).toMatch(/^\*+ \*+$/);
    expect(played.email ?? "").not.toContain("jane");

    // An error after the first segment was numbered carries its number through the gateway.
    await page.locator("#boom").click();
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    const error = await errorRecord(gw.sink);
    expect(Number(error.get("o11y.rum.replay.segment")?.intValue)).toBe(0);

    // Erasure removes every object of the session, and the read API then has nothing.
    const erased = await readAPI(gw, session, "DELETE");
    expect(erased.status).toBe(200);
    const body = (await erased.json()) as { deleted: number; segments: number[] };
    expect(body.deleted).toBeGreaterThanOrEqual(2);
    expect(body.segments).toContain(0);
    for (const path of [session, `${session}/segments/0`]) {
      const after = await readAPI(gw, path);
      expect(after.status, path).toBe(404);
      await after.body?.cancel();
    }
  } finally {
    await gw.stop();
  }
});

test("a gateway with unmasked_text keeps only the text the app unmasked", async ({ page, baseURL }) => {
  const gw = await startGateway(new URL(baseURL ?? "").origin, true);
  try {
    const session = await recordSession(page, gw);
    const segments = await listSegments(gw, session);
    expect(segments[0]?.segment).toBe(0);
    const res = await readAPI(gw, `${session}/segments/0`);
    expect(res.status).toBe(200);
    const stored = (await res.json()) as StoredSegment;
    const text = JSON.stringify(stored);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    const played = await play(page, stored.events);
    expect(played.heading).toBe("Public heading");
    expect(played.name).toMatch(/^\*+ \*+$/);
    expect(played.masked).toMatch(/^\*+ \*+$/);
    expect(played.email ?? "").not.toContain("jane");
  } finally {
    await gw.stop();
  }
});
