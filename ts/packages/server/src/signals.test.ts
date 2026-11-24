import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { LifecycleOptions, SignalReport, Telemetry } from "@libo11y/core";
import { shutdownOnSignalsWith } from "./signals.ts";

function fakeTelemetry(): { telemetry: Telemetry; calls: (LifecycleOptions | undefined)[] } {
  const calls: (LifecycleOptions | undefined)[] = [];
  const report: SignalReport = { ok: true, errors: [] };
  const telemetry = {
    shutdown: (opts?: LifecycleOptions) => {
      calls.push(opts);
      return Promise.resolve(report);
    },
  } as unknown as Telemetry;
  return { telemetry, calls };
}

test("SIGINT and SIGTERM by default: the first one shuts down and removes every listener", async () => {
  const source = new EventEmitter();
  const { telemetry, calls } = fakeTelemetry();
  const done = shutdownOnSignalsWith(source, telemetry);
  assert.equal(source.listenerCount("SIGINT"), 1);
  assert.equal(source.listenerCount("SIGTERM"), 1);
  assert.equal(calls.length, 0, "nothing happens before a signal");
  source.emit("SIGTERM");
  assert.deepEqual(await done, { ok: true, errors: [] });
  assert.equal(calls.length, 1);
  assert.equal(source.listenerCount("SIGINT"), 0, "a second signal gets the default handling");
  assert.equal(source.listenerCount("SIGTERM"), 0);
  source.emit("SIGINT");
  assert.equal(calls.length, 1, "shutdown runs once");
});

test("the signals and the shutdown deadline are configurable", async () => {
  const source = new EventEmitter();
  const { telemetry, calls } = fakeTelemetry();
  const done = shutdownOnSignalsWith(source, telemetry, {
    signals: ["SIGHUP", "SIGUSR2"],
    timeoutMillis: 250,
  });
  assert.equal(source.listenerCount("SIGINT"), 0);
  source.emit("SIGUSR2");
  await done;
  assert.deepEqual(calls, [{ timeoutMillis: 250 }]);
  assert.equal(source.listenerCount("SIGHUP"), 0);
});

test("with no deadline given, shutdown uses its own default", async () => {
  const source = new EventEmitter();
  const { telemetry, calls } = fakeTelemetry();
  const done = shutdownOnSignalsWith(source, telemetry);
  source.emit("SIGINT");
  await done;
  assert.deepEqual(calls, [{}]);
});

const CHILD = fileURLToPath(new URL("./test-support/signals-child.ts", import.meta.url));

function waitForLine(child: ChildProcess, text: string, out: { stdout: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no "${text}" line in: ${out.stdout}`)), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out.stdout += chunk.toString();
      if (out.stdout.includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

test("a real SIGTERM shuts telemetry down, and a second one terminates the process", async () => {
  const child = spawn(process.execPath, [CHILD], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
    child.on("exit", (code, signal) => resolve(signal ?? code));
  });
  const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  try {
    const out = { stdout: "" };
    const ready = waitForLine(child, "ready\n", out);
    await ready;
    const shut = waitForLine(child, "report ", out);
    child.kill("SIGTERM");
    await shut;
    assert.match(out.stdout, /report \{"ok":true,"errors":\[\]\}/);
    child.kill("SIGTERM");
    assert.equal(await exited, "SIGTERM");
  } finally {
    clearTimeout(killer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});
