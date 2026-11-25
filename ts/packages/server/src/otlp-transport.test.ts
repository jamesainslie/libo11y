/**
 * The OTLP/HTTP transport against loopback servers. The transport reimplements upstream's node
 * transport and retrying transport, so most of this file pins parity: what a collector sees, how
 * each outcome maps to success, retryable or failure, the retry loop and its diag messages. The
 * rest covers the three things it does differently: a timeout over the whole attempt, abort(), and
 * destroying the agent at shutdown.
 *
 * Time is the test's to decide wherever it matters. A test that checks a delay hands the transport
 * manual timers, reads the delay each timer was armed with, and fires the timer itself.
 */
import assert from "node:assert/strict";
import { Agent, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, Socket } from "node:net";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { DiagLogLevel, diag } from "@opentelemetry/api";
import { OTLPExporterError } from "@opentelemetry/otlp-exporter-base";
import {
  createHttpTransport,
  type HttpTransportParameters,
  MAX_RESPONSE_BODY_SIZE,
  MAX_TIMER_MILLIS,
  OTLP_EXPORTER_VERSION,
  retryAfterMillis,
  type TransportTimers,
} from "./otlp-transport.ts";
import { close, IS_BUN, listen } from "./test-support/http.ts";

const nodeOnly = IS_BUN ? test.skip : test;

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

type Answer = (seen: Seen, res: ServerResponse, n: number) => void;

/** A loopback server that records each request and answers it with answer. */
async function collector(answer: Answer): Promise<{ url: string; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const { server, url } = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const request = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(request);
      answer(request, res, seen.length);
    });
  });
  return { url: `${url}/v1/traces`, seen, close: () => close(server) };
}

function params(url: string, overrides: Partial<HttpTransportParameters> = {}): HttpTransportParameters {
  return {
    url,
    headers: async () => ({ "Content-Type": "application/x-protobuf", "x-tenant": "t1" }),
    compression: "none",
    agentFactory: () => new Agent({ keepAlive: true }),
    ...overrides,
  };
}

const status =
  (code: number, headers: Record<string, string> = {}, body = ""): Answer =>
  (_seen, res) => {
    res.writeHead(code, headers);
    res.end(body);
  };

const BODY = Uint8Array.of(1, 2, 3, 4);

/** One timer the transport armed. */
interface Armed {
  readonly ms: number;
  cleared: boolean;
  fired: boolean;
  fire(): void;
}

/**
 * Timers that never fire by themselves. armed lists every timer in the order the transport set it,
 * armedAt(i) resolves once the timer at that position exists, and now is the test's to move.
 */
function manualTimers(
  start = 1_700_000_000_000,
  random: () => number = Math.random,
): {
  timers: TransportTimers;
  armed: Armed[];
  armedAt(index: number): Promise<Armed>;
  advance(ms: number): void;
} {
  let now = start;
  const armed: Armed[] = [];
  let waiting: (() => void)[] = [];
  const timers: TransportTimers = {
    random,
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer: Armed = {
        ms,
        cleared: false,
        fired: false,
        fire: () => {
          if (timer.cleared || timer.fired) return;
          timer.fired = true;
          fn();
        },
      };
      armed.push(timer);
      const wake = waiting;
      waiting = [];
      for (const w of wake) w();
      return timer;
    },
    clearTimeout: (handle) => {
      if (handle !== undefined) (handle as Armed).cleared = true;
    },
  };
  return {
    timers,
    armed,
    armedAt: async (index) => {
      while (armed.length <= index) await new Promise<void>((resolve) => waiting.push(resolve));
      return armed[index] as Armed;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

/** A TCP server that accepts connections and never answers them. opened resolves at the first. */
async function blackHole(): Promise<{
  url: string;
  opened: Promise<Socket>;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let first: (socket: Socket) => void = () => {};
  const opened = new Promise<Socket>((resolve) => {
    first = resolve;
  });
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    first(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    opened,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise((done) => server.close(() => done()));
    },
  };
}

/** Resolves when socket has closed, and fails the test if it is still open after a long while. */
function closed(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const giveUp = setTimeout(() => reject(new Error("the connection was never closed")), 10_000);
    socket.once("close", () => {
      clearTimeout(giveUp);
      resolve();
    });
  });
}

/** Captures what the transport writes through the OpenTelemetry diag logger while fn runs. */
async function capturingDiag(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const logger = Object.fromEntries(
    (["error", "warn", "info", "debug", "verbose"] as const).map((level) => [
      level,
      (...args: unknown[]) => lines.push(`${level}: ${args.join(" ")}`),
    ]),
  ) as unknown as Parameters<typeof diag.setLogger>[0];
  diag.setLogger(logger, { logLevel: DiagLogLevel.ALL, suppressOverrideMessage: true });
  lines.length = 0;
  let captured: string[] = [];
  try {
    await fn();
  } finally {
    // Taken before the logger is removed, which the API itself reports through it.
    captured = [...lines];
    diag.disable();
  }
  return captured;
}

test("one POST carries the body, the headers and upstream's User-Agent, and a 2xx is a success with its body", async () => {
  const c = await collector(status(200, {}, "accepted"));
  const transport = createHttpTransport(params(c.url));
  try {
    const response = await transport.send(BODY, 30_000);
    assert.equal(response.status, "success");
    assert.equal(Buffer.from((response as { data?: Uint8Array }).data ?? []).toString(), "accepted");
    assert.equal(c.seen.length, 1);
    const [req] = c.seen;
    assert.equal(req?.method, "POST");
    assert.equal(req?.url, "/v1/traces");
    assert.deepEqual([...(req?.body ?? [])], [1, 2, 3, 4]);
    assert.equal(req?.headers["content-type"], "application/x-protobuf");
    assert.equal(req?.headers["x-tenant"], "t1");
    assert.equal(req?.headers["user-agent"], `OTel-OTLP-Exporter-JavaScript/${OTLP_EXPORTER_VERSION}`);
    assert.equal(req?.headers["content-encoding"], undefined);
  } finally {
    transport.shutdown();
    await c.close();
  }
});

test("a configured user agent goes in front of upstream's, and gzip compresses the body", async () => {
  const c = await collector(status(200));
  const transport = createHttpTransport(params(c.url, { userAgent: "my-app/1.0", compression: "gzip" }));
  try {
    assert.equal((await transport.send(BODY, 30_000)).status, "success");
    const [req] = c.seen;
    assert.equal(
      req?.headers["user-agent"],
      `my-app/1.0 OTel-OTLP-Exporter-JavaScript/${OTLP_EXPORTER_VERSION}`,
    );
    assert.equal(req?.headers["content-encoding"], "gzip");
    assert.deepEqual([...gunzipSync(req?.body ?? Buffer.alloc(0))], [1, 2, 3, 4]);
  } finally {
    transport.shutdown();
    await c.close();
  }
});

// Node frames a body that is written and then ended as chunked, which is what upstream's stream
// sends. Bun buffers a request body and sends a Content-Length. Upstream's transport does the same
// under Bun for a body that is not compressed, and sends a gzip body chunked, which is the one
// place the two differ on the wire.
test("a body is chunked under Node and carries a Content-Length under Bun, compressed or not", async () => {
  const c = await collector(status(200));
  const plain = createHttpTransport(params(c.url));
  const zipped = createHttpTransport(params(c.url, { compression: "gzip" }));
  try {
    await plain.send(BODY, 30_000);
    await zipped.send(BODY, 30_000);
    for (const req of c.seen) {
      if (IS_BUN) {
        assert.equal(req.headers["content-length"], String(req.body.length));
      } else {
        assert.equal(req.headers["transfer-encoding"], "chunked");
        assert.equal(req.headers["content-length"], undefined);
      }
    }
  } finally {
    plain.shutdown();
    zipped.shutdown();
    await c.close();
  }
});

test("a status that is not retried is a failure carrying the status, its text and the body", async () => {
  for (const [code, text] of [
    [404, "Not Found"],
    [500, "Internal Server Error"],
    [400, "Bad Request"],
    [501, "Not Implemented"],
  ] as const) {
    const c = await collector(status(code, {}, "why"));
    const transport = createHttpTransport(params(c.url));
    try {
      const response = await transport.send(BODY, 30_000);
      assert.equal(response.status, "failure");
      const error = (response as { error: Error }).error;
      assert.ok(error instanceof OTLPExporterError);
      assert.equal(error.message, text);
      assert.equal(error.code, code);
      assert.equal(error.data, "why");
      assert.equal(c.seen.length, 1, "it is not retried");
    } finally {
      transport.shutdown();
      await c.close();
    }
  }
});

// Fourth review: a redirect is not a delivery. Upstream's transport does not follow one, so the
// collector the export was meant for never received it.
test("a 3xx response is a failure carrying its status, never a delivery, and is neither followed nor retried", async () => {
  const target = await collector(status(200));
  try {
    for (const [code, text] of [
      [300, "Multiple Choices"],
      [301, "Moved Permanently"],
      [302, "Found"],
      [303, "See Other"],
      [304, "Not Modified"],
      [307, "Temporary Redirect"],
      [308, "Permanent Redirect"],
    ] as const) {
      const c = await collector(status(code, { location: target.url }));
      const transport = createHttpTransport(params(c.url));
      try {
        const response = await transport.send(BODY, 30_000);
        assert.equal(response.status, "failure", String(code));
        const error = (response as { error: Error }).error;
        assert.ok(error instanceof OTLPExporterError, String(code));
        assert.equal(error.code, code);
        assert.equal(error.message, text);
        assert.equal(c.seen.length, 1, `${code} is not retried`);
      } finally {
        transport.shutdown();
        await c.close();
      }
    }
    assert.equal(target.seen.length, 0, "no redirect was followed");
  } finally {
    await target.close();
  }
});

test("429, 502, 503 and 504 are retried after Retry-After until the collector accepts", async () => {
  for (const code of [429, 502, 503, 504]) {
    const c = await collector((_seen, res, n) => {
      if (n < 3) status(code, { "retry-after": "0" })(_seen, res, n);
      else status(200)(_seen, res, n);
    });
    const transport = createHttpTransport(params(c.url));
    try {
      assert.equal((await transport.send(BODY, 30_000)).status, "success");
      assert.equal(c.seen.length, 3, String(code));
    } finally {
      transport.shutdown();
      await c.close();
    }
  }
});

test("an export is attempted once and retried five times at most, as upstream retries it", async () => {
  const c = await collector(status(503, { "retry-after": "0" }));
  const transport = createHttpTransport(params(c.url));
  try {
    const response = await transport.send(BODY, 600_000);
    assert.equal(response.status, "retryable");
    assert.equal(c.seen.length, 6);
  } finally {
    transport.shutdown();
    await c.close();
  }
});

test("without Retry-After the wait grows from one second by half each time, with a fifth of jitter, to five seconds", async () => {
  const c = await collector(status(503));
  const clock = manualTimers();
  const transport = createHttpTransport(params(c.url), clock.timers);
  try {
    const sending = transport.send(BODY, 3_600_000);
    // The timers alternate: an attempt's timeout, then the wait before the next attempt.
    const waits: number[] = [];
    for (let retry = 0; retry < 5; retry++) {
      const wait = await clock.armedAt(retry * 2 + 1);
      waits.push(wait.ms);
      wait.fire();
    }
    assert.equal((await sending).status, "retryable");
    assert.equal(c.seen.length, 6);
    const base = [1000, 1500, 2250, 3375, 5062.5];
    for (const [i, ms] of waits.entries()) {
      const low = Math.min((base[i] as number) * 0.8, 5000);
      const high = Math.min((base[i] as number) * 1.2, 5000);
      assert.ok(ms >= low && ms <= high, `wait ${i + 1} was ${ms} ms, outside ${low} to ${high}`);
    }
    assert.equal(clock.armed.length, 11, "six attempts and five waits, and no more");
  } finally {
    transport.shutdown();
    await c.close();
  }
});

// Fourth review: the test above takes its jitter from Math.random, so a wrong cap got past it in
// three runs of seven. Here the test decides the random number, and every wait is one exact value.
test("the wait is the backoff times one plus the jitter, capped at five seconds, for a jitter the test decides", async () => {
  for (const [random, want] of [
    // 0 is the least jitter, a fifth less. 0.5 is none. 0.75 is a tenth more.
    [0, [800, 1200, 1800, 2700, 4050]],
    [0.5, [1000, 1500, 2250, 3375, 5000]],
    [0.75, [1100, 1650, 2475, 3712.5, 5000]],
    // The most there can be, just under a fifth more: the fifth wait would be 6075 ms uncapped.
    [1 - 2 ** -52, [1200, 1800, 2700, 4050, 5000]],
  ] as const) {
    const c = await collector(status(503));
    let drawn = 0;
    const clock = manualTimers(undefined, () => {
      drawn++;
      return random;
    });
    const transport = createHttpTransport(params(c.url), clock.timers);
    try {
      const sending = transport.send(BODY, 3_600_000);
      const waits: number[] = [];
      for (let retry = 0; retry < 5; retry++) {
        const wait = await clock.armedAt(retry * 2 + 1);
        waits.push(wait.ms);
        wait.fire();
      }
      assert.equal((await sending).status, "retryable");
      for (const [i, ms] of waits.entries()) {
        const expected = want[i] as number;
        assert.ok(
          Math.abs(ms - expected) < 1e-6,
          `random ${random}: wait ${i + 1} was ${ms} ms, not ${expected}`,
        );
      }
      assert.equal(drawn, 5, "one random number for each wait");
    } finally {
      transport.shutdown();
      await c.close();
    }
  }
});

test("Retry-After is read as upstream reads it: seconds, or an HTTP date from now", () => {
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  assert.equal(retryAfterMillis(undefined, now), undefined);
  assert.equal(retryAfterMillis("7", now), 7000);
  assert.equal(retryAfterMillis("0", now), -1);
  assert.equal(retryAfterMillis("-3", now), -1);
  assert.equal(retryAfterMillis(new Date(now + 90_000).toUTCString(), now), 90_000);
  assert.equal(retryAfterMillis(new Date(now - 90_000).toUTCString(), now), 0);
  assert.equal(retryAfterMillis("soon", now), 0);
});

test("a Retry-After given as an HTTP date sets the wait, and the retry gets the time that was left when it was scheduled", async () => {
  const clock = manualTimers(Date.UTC(2026, 10, 25, 12, 0, 0));
  const c = await collector((seen, res, n) => {
    if (n > 1) return status(200)(seen, res, n);
    // The collector takes three seconds, then asks for two more by the clock the transport reads.
    clock.advance(3000);
    status(503, { "retry-after": new Date(clock.timers.now() + 2000).toUTCString() })(seen, res, n);
  });
  const transport = createHttpTransport(params(c.url), clock.timers);
  try {
    const sending = transport.send(BODY, 10_000);
    const wait = await clock.armedAt(1);
    assert.equal(clock.armed[0]?.ms, 10_000, "the first attempt has the whole timeout");
    assert.equal(wait.ms, 2000, "the wait is the time to the date");
    clock.advance(2000);
    wait.fire();
    const retry = await clock.armedAt(2);
    assert.equal(retry.ms, 7000, "the retry has what was left of the timeout, not all of it again");
    assert.equal((await sending).status, "success");
    assert.equal(c.seen.length, 2);
  } finally {
    transport.shutdown();
    await c.close();
  }
});

test("a retry that would start past the export timeout is not made", async () => {
  const c = await collector(status(503));
  const clock = manualTimers();
  const transport = createHttpTransport(params(c.url), clock.timers);
  try {
    // The first wait is at least 800 ms, which a 500 ms timeout leaves no room for.
    const response = await transport.send(BODY, 500);
    assert.equal(response.status, "retryable");
    assert.equal(c.seen.length, 1);
    assert.equal(clock.armed.length, 1, "no wait was started");
  } finally {
    transport.shutdown();
    await c.close();
  }
});

test("a connection the peer resets is retryable, with the network error", async () => {
  // A listener that drops every connection: the port stays ours, so no other test can take it.
  const server = createTcpServer((socket) => {
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const clock = manualTimers();
  const transport = createHttpTransport(params(`http://127.0.0.1:${port}/v1/traces`), clock.timers);
  try {
    const response = await transport.send(BODY, 500);
    assert.equal(response.status, "retryable");
    assert.equal(
      ((response as { error?: Error }).error as { code?: string } | undefined)?.code,
      "ECONNRESET",
    );
  } finally {
    transport.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Bun's node:http does not ask the agent for its connections, so an agent cannot stand in for the
// network there. Under Node it can, which lets every error code be tried without the network.
nodeOnly("each network error upstream retries is retryable, and any other is a failure", async () => {
  class Failing extends Agent {
    code = "";
    override createConnection(): Socket {
      const socket = new Socket();
      const error = Object.assign(new Error(`connect ${this.code}`), { code: this.code });
      queueMicrotask(() => socket.destroy(error));
      return socket;
    }
  }
  const agent = new Failing();
  const clock = manualTimers();
  const transport = createHttpTransport(
    params("http://127.0.0.1:9/v1/traces", { agentFactory: () => agent }),
    clock.timers,
  );
  try {
    for (const code of [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "EAI_AGAIN",
      "ENOTFOUND",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ]) {
      agent.code = code;
      // The timeout leaves no room for a retry, so the first attempt's outcome is the result.
      const response = await transport.send(BODY, 500);
      assert.equal(response.status, "retryable", code);
      assert.equal(((response as { error?: Error }).error as { code?: string }).code, code);
    }
    for (const code of ["EACCES", "ECONNABORTED", "CERT_HAS_EXPIRED", ""]) {
      agent.code = code;
      const response = await transport.send(BODY, 500);
      assert.equal(response.status, "failure", code);
    }
  } finally {
    transport.shutdown();
  }
});

/** A server that sends a status line and part of a body, then resets the connection. */
async function breakingOff(code: number): Promise<{ url: string; close(): Promise<void> }> {
  const { server, url } = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(code, { "content-length": "1000", "retry-after": "7" });
      res.write("partial", () => res.socket?.destroy());
    });
  });
  return { url: `${url}/v1/traces`, close: () => close(server) };
}

// What a response that breaks off after its status line becomes is upstream's choice, and an odd
// one for a 2xx.
nodeOnly(
  "a response that breaks off is a success for a 2xx, retryable for a retryable status, else a failure",
  async () => {
    for (const [code, want] of [
      [200, "success"],
      [299, "success"],
      [503, "retryable"],
      [500, "failure"],
      // A redirect that breaks off is no more a delivery than one that arrives whole.
      [300, "failure"],
      [307, "failure"],
    ] as const) {
      const server = await breakingOff(code);
      const clock = manualTimers();
      const transport = createHttpTransport(params(server.url), clock.timers);
      try {
        const response = await transport.send(BODY, 500);
        assert.equal(response.status, want, String(code));
        if (want === "success") assert.equal((response as { data?: Uint8Array }).data, undefined);
        else assert.ok((response as { error?: Error }).error instanceof Error, String(code));
        if (want === "retryable") assert.equal((response as { retryInMillis?: number }).retryInMillis, 7000);
      } finally {
        transport.shutdown();
        await server.close();
      }
    }
  },
);

// Bun reports a response that breaks off as a reset of the request, whatever its status was, so
// the export is retryable there, for upstream's transport as for this one.
const bunOnly = IS_BUN ? test : test.skip;

bunOnly(
  "under Bun a response that breaks off is a reset connection, retryable whatever the status",
  async () => {
    for (const code of [200, 307, 503, 500]) {
      const server = await breakingOff(code);
      const clock = manualTimers();
      const transport = createHttpTransport(params(server.url), clock.timers);
      try {
        const response = await transport.send(BODY, 500);
        assert.equal(response.status, "retryable", String(code));
        assert.equal(
          ((response as { error?: Error }).error as { code?: string } | undefined)?.code,
          "ECONNRESET",
        );
      } finally {
        transport.shutdown();
        await server.close();
      }
    }
  },
);

test("the timeout ends a request the collector never answers, and the request is destroyed", async () => {
  const hole = await blackHole();
  const clock = manualTimers();
  const transport = createHttpTransport(params(hole.url), clock.timers);
  try {
    const sending = transport.send(BODY, 200);
    const socket = await hole.opened;
    const timeout = await clock.armedAt(0);
    assert.equal(timeout.ms, 200);
    timeout.fire();
    const response = await sending;
    assert.equal(response.status, "retryable");
    assert.equal((response as { error?: Error }).error?.message, "Request timed out");
    await closed(socket);
  } finally {
    transport.shutdown();
    await hole.close();
  }
});

// Upstream arms its timeout with ClientRequest.setTimeout, which Node applies only after the socket
// has connected, so a connection that never completes never times out.
nodeOnly("the timeout also bounds a connection that never completes", async () => {
  const sockets: Socket[] = [];
  class NeverConnects extends Agent {
    override createConnection(): Socket {
      const socket = new Socket();
      // What a socket reports between connect() and the handshake.
      Object.defineProperty(socket, "connecting", { value: true });
      sockets.push(socket);
      return socket;
    }
  }
  const clock = manualTimers();
  const transport = createHttpTransport(
    params("http://127.0.0.1:9/v1/traces", { agentFactory: () => new NeverConnects() }),
    clock.timers,
  );
  try {
    const sending = transport.send(BODY, 200);
    const timeout = await clock.armedAt(0);
    while (sockets.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timeout.ms, 200, "the timeout is armed before the connection completes");
    timeout.fire();
    const response = await sending;
    assert.equal(response.status, "retryable");
    assert.equal((response as { error?: Error }).error?.message, "Request timed out");
    // Node hands the socket to the request on the next tick, and destroys it then.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sockets[0]?.destroyed, true, "the connection attempt is destroyed");
  } finally {
    transport.shutdown();
  }
});

test("a timeout past what a timer can hold is clamped, where it would otherwise fire after a millisecond", async () => {
  const c = await collector((seen, res, n) => {
    // Late enough that a one millisecond timeout would have passed.
    setTimeout(() => status(200)(seen, res, n), 50);
  });
  const clock = manualTimers();
  const armedWith = createHttpTransport(params(c.url), clock.timers);
  const real = createHttpTransport(params(c.url));
  try {
    const recorded = armedWith.send(BODY, 3_000_000_000);
    assert.equal((await clock.armedAt(0)).ms, MAX_TIMER_MILLIS);
    assert.equal((await recorded).status, "success");

    // With the runtime's own timers: one request, accepted, as upstream manages.
    const before = c.seen.length;
    assert.equal((await real.send(BODY, 3_000_000_000)).status, "success");
    assert.equal(c.seen.length - before, 1, "the batch is sent once");
  } finally {
    armedWith.shutdown();
    real.shutdown();
    await c.close();
  }
});

test("a wait past what a timer can hold is clamped too", async () => {
  const c = await collector(status(503, { "retry-after": "3000000" }));
  const clock = manualTimers();
  const transport = createHttpTransport(params(c.url), clock.timers);
  try {
    const sending = transport.send(BODY, 4_000_000_000);
    assert.equal((await clock.armedAt(1)).ms, MAX_TIMER_MILLIS);
    transport.abort();
    assert.equal((await sending).status, "failure");
  } finally {
    transport.shutdown();
    await c.close();
  }
});

test("abort ends a request in flight as a failure and destroys it, and every later send fails without a request", async () => {
  const hole = await blackHole();
  const transport = createHttpTransport(params(hole.url));
  try {
    const pending = transport.send(BODY, 600_000);
    const socket = await hole.opened;
    transport.abort();
    const response = await pending;
    assert.equal(response.status, "failure");
    assert.match((response as { error: Error }).error.message, /aborted at shutdown/);
    await closed(socket);
    transport.abort();
    const later = await transport.send(BODY, 600_000);
    assert.equal(later.status, "failure");
    assert.match((later as { error: Error }).error.message, /aborted at shutdown/);
  } finally {
    transport.shutdown();
    await hole.close();
  }
});

test("after abort a send fails without a request reaching the collector", async () => {
  const c = await collector(status(200));
  const transport = createHttpTransport(params(c.url));
  try {
    assert.equal((await transport.send(BODY, 30_000)).status, "success");
    transport.abort();
    const response = await transport.send(BODY, 30_000);
    assert.equal(response.status, "failure");
    assert.match((response as { error: Error }).error.message, /aborted at shutdown/);
    assert.equal(c.seen.length, 1, "only the send before the abort went out");

    // A transport stopped before its first send builds nothing: no agent, no headers.
    let asked = 0;
    const unused = createHttpTransport(
      params(c.url, {
        agentFactory: () => {
          asked++;
          return new Agent();
        },
        headers: async () => {
          asked++;
          return {};
        },
      }),
    );
    unused.shutdown();
    assert.equal((await unused.send(BODY, 30_000)).status, "failure");
    assert.equal(asked, 0);
  } finally {
    transport.shutdown();
    await c.close();
  }
});

test("abort ends the wait between two retries", async () => {
  const c = await collector(status(503, { "retry-after": "20" }));
  const clock = manualTimers();
  const transport = createHttpTransport(params(c.url), clock.timers);
  try {
    const pending = transport.send(BODY, 600_000);
    const wait = await clock.armedAt(1);
    assert.equal(wait.ms, 20_000);
    transport.abort();
    const response = await pending;
    assert.equal(response.status, "failure");
    assert.equal(wait.cleared, true, "the wait's timer is cancelled");
    assert.equal(c.seen.length, 1, "the retry is never made");
  } finally {
    transport.shutdown();
    await c.close();
  }
});

test("shutdown destroys the agent, and an agent that was never built is left alone", async () => {
  const c = await collector(status(200));
  let destroyed = 0;
  let built = 0;
  const agentFactory = (): Agent => {
    built++;
    const agent = new Agent({ keepAlive: true });
    const destroy = agent.destroy.bind(agent);
    agent.destroy = () => {
      destroyed++;
      return destroy();
    };
    return agent;
  };
  const used = createHttpTransport(params(c.url, { agentFactory }));
  const unused = createHttpTransport(params(c.url, { agentFactory }));
  try {
    assert.equal((await used.send(BODY, 30_000)).status, "success");
    used.shutdown();
    unused.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(built, 1);
    assert.equal(destroyed, 1);
  } finally {
    await c.close();
  }
});

test("sends that start together share one agent, and a factory that failed is asked again by the next send", async () => {
  const c = await collector(status(200));
  let calls = 0;
  const agentFactory = (): Agent => {
    calls++;
    if (calls === 1) throw new Error("no agent yet");
    return new Agent({ keepAlive: true });
  };
  const transport = createHttpTransport(params(c.url, { agentFactory }));
  try {
    await assert.rejects(transport.send(BODY, 30_000), /no agent yet/);
    const together = await Promise.all([transport.send(BODY, 30_000), transport.send(BODY, 30_000)]);
    assert.deepEqual(
      together.map((r) => r.status),
      ["success", "success"],
    );
    assert.equal(calls, 2, "one failed call, then one agent for both sends");
  } finally {
    transport.shutdown();
    await c.close();
  }
});

// Upstream's transport rejects when the headers or the agent cannot be built, and its export
// delegate reports the rejection as a failed export. This one rejects the same way.
test("headers that cannot be built reject the send, as upstream's does", async () => {
  const c = await collector(status(200));
  const failure = new Error("no token");
  const transport = createHttpTransport(params(c.url, { headers: () => Promise.reject(failure) }));
  try {
    await assert.rejects(transport.send(BODY, 30_000), (err) => err === failure);
    assert.equal(c.seen.length, 0);
  } finally {
    transport.shutdown();
    await c.close();
  }
});

// Fourth review: the limit is the largest body read, so a body of exactly that size is read whole.
test("a response body of exactly the size limit is read whole", async () => {
  assert.equal(MAX_RESPONSE_BODY_SIZE, 4 * 1024 * 1024, "4 MiB, as upstream");
  // Sent in two writes, so the count reaches the limit on a chunk of its own.
  const c = await collector((_seen, res) => {
    res.writeHead(200);
    res.write(Buffer.alloc(MAX_RESPONSE_BODY_SIZE - 1, 0x61));
    res.end(Buffer.alloc(1, 0x62));
  });
  const transport = createHttpTransport(params(c.url));
  try {
    const response = await transport.send(BODY, 30_000);
    assert.equal(response.status, "success");
    const data = (response as { data?: Uint8Array }).data;
    assert.equal(data?.length, MAX_RESPONSE_BODY_SIZE);
    assert.equal(data?.[0], 0x61);
    assert.equal(data?.[MAX_RESPONSE_BODY_SIZE - 1], 0x62, "the last byte is the one sent last");
  } finally {
    transport.shutdown();
    await c.close();
  }
});

test("a response body past the size limit fails the export", async () => {
  const c = await collector((_seen, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(MAX_RESPONSE_BODY_SIZE + 1));
  });
  const transport = createHttpTransport(params(c.url));
  try {
    const response = await transport.send(BODY, 30_000);
    assert.equal(response.status, "failure");
    assert.match((response as { error: Error }).error.message, /response body exceeded size limit/);
  } finally {
    transport.shutdown();
    await c.close();
  }
});

test("the retry loop writes upstream's diag messages, at upstream's levels", async () => {
  const flaky = await collector((seen, res, n) =>
    n === 1 ? status(503, { "retry-after": "0" })(seen, res, n) : status(200)(seen, res, n),
  );
  const refusing = await collector(status(500));
  const busy = await collector(status(503, { "retry-after": "0" }));
  const slow = await collector(status(503, { "retry-after": "9" }));
  const transports = [flaky, refusing, busy, slow].map((c) => createHttpTransport(params(c.url)));
  try {
    const [a, b, c, d] = transports;
    const lines = await capturingDiag(async () => {
      await a?.send(BODY, 30_000);
      await b?.send(BODY, 30_000);
      await c?.send(BODY, 30_000);
      await d?.send(BODY, 5000);
    });
    assert.deepEqual(lines.slice(0, 3), [
      "verbose: Scheduling export retry in -1ms",
      "verbose: Export succeeded after 1 retry attempts.",
      "info: Export failed with non-retryable error: OTLPExporterError: Internal Server Error",
    ]);
    assert.deepEqual(lines.slice(3, 9), [
      ...Array.from({ length: 5 }, () => "verbose: Scheduling export retry in -1ms"),
      "info: Export failed after maximum retry attempts (5).",
    ]);
    assert.equal(lines.length, 10, lines.join("\n"));
    assert.match(
      lines[9] ?? "",
      /^info: Export retry time 9000ms exceeds remaining timeout \d+ms, not retrying further\.$/,
    );
  } finally {
    for (const t of transports) t.shutdown();
    for (const c of [flaky, refusing, busy, slow]) await c.close();
  }
});
