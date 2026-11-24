/**
 * The context matrix: libo11y's context manager must carry the active context across every async
 * boundary a server uses, on Bun and on Node. The known Bun 1.3.x gaps are asserted as losses, each
 * with its issue, so the test fails, and gets updated, once Bun fixes the gap.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Context, createContextKey, ROOT_CONTEXT } from "@opentelemetry/api";
import { createContextManager } from "./context.ts";

const KEY = createContextKey("libo11y.test.context");
const IS_BUN = "Bun" in globalThis;
const ctxWith = (value: string): Context => ROOT_CONTEXT.setValue(KEY, value);

type BunServer = { readonly port: number; stop(force?: boolean): void };
type BunGlobal = {
  version: string;
  serve(opts: {
    port: number;
    hostname: string;
    fetch(req: Request): Response | Promise<Response>;
  }): BunServer;
};
const bun = (globalThis as unknown as { Bun?: BunGlobal }).Bun;

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

test("createContextManager returns an enabled AsyncLocalStorage manager", () => {
  const cm = createContextManager();
  assert.equal(cm.active(), ROOT_CONTEXT);
  assert.equal(
    cm.with(ctxWith("v"), () => cm.active().getValue(KEY)),
    "v",
  );
  assert.equal(cm.active(), ROOT_CONTEXT);
  cm.disable();
});

test("context holds across timers, microtasks, nextTick and await", async () => {
  const cm = createContextManager();
  const seen: Record<string, unknown> = {};
  const get = (): unknown => cm.active().getValue(KEY);
  const capture = (name: string, done: () => void) => () => {
    seen[name] = get();
    done();
  };
  await cm.with(ctxWith("v"), async () => {
    await new Promise<void>((r) => setTimeout(capture("setTimeout", r), 1));
    await new Promise<void>((r) => setImmediate(capture("setImmediate", r)));
    await new Promise<void>((r) => {
      const id = setInterval(() => {
        seen.setInterval = get();
        clearInterval(id);
        r();
      }, 1);
    });
    await new Promise<void>((r) => queueMicrotask(capture("queueMicrotask", r)));
    await new Promise<void>((r) => process.nextTick(capture("nextTick", r)));
    await Promise.resolve();
    seen.await = get();
  });
  assert.deepEqual(seen, {
    setTimeout: "v",
    setImmediate: "v",
    setInterval: "v",
    queueMicrotask: "v",
    nextTick: "v",
    await: "v",
  });
  cm.disable();
});

test("context holds across fetch and reading its body from a node:http server", async () => {
  const cm = createContextManager();
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(100_000));
  });
  const url = await listen(server);
  try {
    const seen = await cm.with(ctxWith("fetch"), async () => {
      const res = await fetch(url);
      const afterFetch = cm.active().getValue(KEY);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      const afterRead = cm.active().getValue(KEY);
      await reader.cancel();
      return { afterFetch, afterRead };
    });
    assert.deepEqual(seen, { afterFetch: "fetch", afterRead: "fetch" });
  } finally {
    await close(server);
    cm.disable();
  }
});

test("context holds in a ReadableStream pull and a synchronous EventEmitter", async () => {
  const cm = createContextManager();
  const seen: Record<string, unknown> = {};
  await cm.with(ctxWith("stream"), async () => {
    const stream = new ReadableStream<number>({
      pull(controller) {
        seen.pull = cm.active().getValue(KEY);
        controller.enqueue(1);
        controller.close();
      },
    });
    await stream.getReader().read();
    const ee = new EventEmitter();
    ee.on("e", () => {
      seen.emitter = cm.active().getValue(KEY);
    });
    ee.emit("e");
  });
  assert.deepEqual(seen, { pull: "stream", emitter: "stream" });
  cm.disable();
});

test("context holds in a Bun.serve handler across await and fetch", { skip: !IS_BUN }, async () => {
  const cm = createContextManager();
  const upstream = createServer((_req, res) => res.end("up"));
  const upstreamUrl = await listen(upstream);
  const server = (bun as BunGlobal).serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      cm.with(ctxWith("serve"), async () => {
        await new Promise((r) => setTimeout(r, 1));
        const afterAwait = cm.active().getValue(KEY);
        await (await fetch(upstreamUrl)).text();
        const afterFetch = cm.active().getValue(KEY);
        return Response.json({ afterAwait, afterFetch });
      }),
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    assert.deepEqual(await res.json(), { afterAwait: "serve", afterFetch: "serve" });
  } finally {
    server.stop(true);
    await close(upstream);
    cm.disable();
  }
});

test("context holds in a ReadableStream pull used as a Bun.serve body", { skip: !IS_BUN }, async () => {
  const cm = createContextManager();
  const seen: unknown[] = [];
  const server = (bun as BunGlobal).serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      cm.with(ctxWith("body"), () => {
        let n = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              seen.push(cm.active().getValue(KEY));
              await new Promise((r) => setTimeout(r, 1));
              if (n++ < 2) controller.enqueue(new TextEncoder().encode("x"));
              else controller.close();
            },
          }),
        );
      }),
  });
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${server.port}/`)).text(), "xx");
    assert.ok(seen.length >= 2);
    assert.ok(
      seen.every((v) => v === "body"),
      JSON.stringify(seen),
    );
  } finally {
    server.stop(true);
    cm.disable();
  }
});

// Known gap: https://github.com/oven-sh/bun/issues/24199, fixed in Bun 1.4.x only. An async generator
// used as a Bun.serve response body runs without the handler's context after its first await.
test("known Bun 1.3 gap: an async generator Bun.serve body loses context (oven-sh/bun#24199)", {
  skip: !IS_BUN,
}, async () => {
  const cm = createContextManager();
  const seen: Record<string, unknown> = {};
  const server = (bun as BunGlobal).serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () =>
      cm.with(ctxWith("gen"), () => {
        async function* body(): AsyncGenerator<string> {
          yield "a";
          await new Promise((r) => setTimeout(r, 1));
          seen.afterAwait = cm.active().getValue(KEY) ?? null;
          yield "b";
        }
        return new Response(body() as unknown as ReadableStream);
      }),
  });
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${server.port}/`)).text(), "ab");
    assert.equal(
      seen.afterAwait,
      null,
      "Bun now keeps context in async generator bodies (oven-sh/bun#24199): update this known-gap test",
    );
  } finally {
    server.stop(true);
    cm.disable();
  }
});

const PROBE = fileURLToPath(new URL("./test-support/context-probe.ts", import.meta.url));

// runProbe runs the context probe in a child process of the same runtime: a stray unhandled
// rejection must not reach this process's test runner.
function runProbe(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PROBE], { timeout: 20_000 }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(new Error(`context probe failed: ${err.message}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as Record<string, unknown>);
    });
  });
}

// Known gaps on Bun 1.3.x: https://github.com/oven-sh/bun/issues/34266 (a thenable returned from an
// async function after an await, fixed in 1.4.x) and https://github.com/oven-sh/bun/issues/40223
// (unhandledRejection listeners, open). Node keeps the context in both.
test("known Bun 1.3 gaps: a thenable after await (oven-sh/bun#34266) and unhandledRejection (oven-sh/bun#40223)", async () => {
  const seen = await runProbe();
  if (IS_BUN) {
    assert.deepEqual(
      seen,
      { thenable: null, unhandledRejection: null },
      "Bun now keeps context here (oven-sh/bun#34266, #40223): update this known-gap test",
    );
  } else {
    assert.deepEqual(seen, { thenable: "probe", unhandledRejection: "probe" });
  }
});
