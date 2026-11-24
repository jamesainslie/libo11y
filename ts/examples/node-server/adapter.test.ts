/**
 * The node:http adapter's backpressure: it reads the body only as fast as the client takes it, and
 * cancels the body when the client goes away while it waits. Bun's node:http never reports
 * backpressure (as of Bun 1.3.13 its write always returns true and buffers), so only Node runs it.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { test } from "node:test";
import { toNodeListener } from "./adapter.ts";

const CHUNK = new Uint8Array(64 * 1024);
const CHUNKS = 1024;

// Bun's test runner ignores node:test's skip option, so the skip is chosen up front.
const nodeOnly = "Bun" in globalThis ? test.skip : test;

nodeOnly(
  "the adapter waits for drain while the client is not reading, and cancels the body when it leaves",
  async () => {
    let pulled = 0;
    let cancelled = false;
    const handler = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (++pulled > CHUNKS) controller.close();
              else controller.enqueue(CHUNK);
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
      );
    const server = createServer(toNodeListener(handler));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const socket = connect((server.address() as AddressInfo).port, "127.0.0.1");
    try {
      socket.pause();
      socket.write("GET / HTTP/1.1\r\nHost: test\r\n\r\n");
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(pulled < CHUNKS / 4, `${pulled} chunks of 64 KiB were read with the client not reading`);
      socket.destroy();
      for (let i = 0; i < 200 && !cancelled; i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(cancelled, "the body was not cancelled after the client left");
    } finally {
      socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
