import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { LifecycleOptions, SignalReport, Telemetry } from "@libo11y/core";
import { type SignalClock, shutdownOnSignalsWith } from "./signals.ts";

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

test("beforeShutdown runs to completion before the telemetry shuts down", async () => {
  const source = new EventEmitter();
  const order: string[] = [];
  const telemetry = {
    shutdown: async () => {
      order.push("shutdown");
      return { ok: true, errors: [] };
    },
  } as unknown as Telemetry;
  const done = shutdownOnSignalsWith(source, telemetry, {
    beforeShutdown: async () => {
      order.push("before:start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("before:end");
    },
  });
  source.emit("SIGTERM");
  assert.deepEqual(await done, { ok: true, errors: [] });
  assert.deepEqual(order, ["before:start", "before:end", "shutdown"]);
});

test("a failing beforeShutdown is reported, not thrown, and the telemetry still shuts down", async () => {
  for (const before of [
    () => {
      throw new Error("server would not stop");
    },
    () => Promise.reject(new Error("server would not stop")),
  ]) {
    const source = new EventEmitter();
    const { telemetry, calls } = fakeTelemetry();
    const done = shutdownOnSignalsWith(source, telemetry, { beforeShutdown: before });
    source.emit("SIGINT");
    const report = await done;
    assert.equal(report.ok, false);
    assert.equal(report.errors.length, 1);
    assert.equal(report.errors[0]?.signal, "lifecycle");
    assert.match(String(report.errors[0]?.error), /beforeShutdown: server would not stop/);
    assert.equal(calls.length, 1);
  }
});

/**
 * A clock the test moves and timers the test fires, so no deadline here depends on how busy the
 * machine is. armed lists the delay each timer was set with.
 */
function manualClock(): {
  clock: SignalClock;
  armed: { ms: number; fire(): void; cleared: boolean }[];
  advance(ms: number): void;
  armedAt(index: number): Promise<{ ms: number; fire(): void; cleared: boolean }>;
} {
  let now = 1000;
  const armed: { ms: number; fire(): void; cleared: boolean }[] = [];
  let waiting: (() => void)[] = [];
  return {
    armed,
    advance: (ms) => {
      now += ms;
    },
    armedAt: async (index) => {
      while (armed.length <= index) await new Promise<void>((resolve) => waiting.push(resolve));
      return armed[index] as { ms: number; fire(): void; cleared: boolean };
    },
    clock: {
      now: () => now,
      setTimeout: (fn, ms) => {
        const timer = { ms, cleared: false, fire: () => fn() };
        armed.push(timer);
        const wake = waiting;
        waiting = [];
        for (const w of wake) w();
        return timer;
      },
      clearTimeout: (handle) => {
        if (handle !== undefined) (handle as { cleared: boolean }).cleared = true;
      },
    },
  };
}

/** Runs shutdownOnSignalsWith to its report on a manual clock, with before as beforeShutdown. */
async function onSignal(
  timeoutMillis: unknown,
  before: (clock: ReturnType<typeof manualClock>) => Promise<void> | void,
): Promise<{
  report: SignalReport;
  calls: (LifecycleOptions | undefined)[];
  clock: ReturnType<typeof manualClock>;
}> {
  const source = new EventEmitter();
  const { telemetry, calls } = fakeTelemetry();
  const clock = manualClock();
  const done = shutdownOnSignalsWith(
    source,
    telemetry,
    {
      ...(timeoutMillis === undefined ? {} : { timeoutMillis: timeoutMillis as number }),
      beforeShutdown: () => before(clock),
    },
    clock.clock,
  );
  source.emit("SIGTERM");
  return { report: await done, calls, clock };
}

/** A beforeShutdown that never settles: the test fires its deadline once the clock has moved. */
function hung(late = 0) {
  return (clock: ReturnType<typeof manualClock>): Promise<void> => {
    void clock.armedAt(0).then((timer) => {
      clock.advance(timer.ms + late);
      timer.fire();
    });
    return new Promise<void>(() => {});
  };
}

// Site review: beforeShutdown and the telemetry shutdown share one deadline. Before the fix each
// got the whole of it, so a hung beforeShutdown and a hung exporter took twice the stated time.
// Second review: the two together never take longer than the deadline. beforeShutdown may use nine
// tenths of it, and the shutdown gets what is left, which is then never less than a tenth.
test("beforeShutdown may use nine tenths of the deadline, and the shutdown gets the last tenth", async () => {
  const { report, calls, clock } = await onSignal(1000, hung());
  assert.equal(clock.armed[0]?.ms, 900);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0]?.signal, "lifecycle");
  assert.match(String(report.errors[0]?.error), /beforeShutdown: deadline exceeded/);
  assert.deepEqual(calls, [{ timeoutMillis: 100 }]);
});

test("the time beforeShutdown takes comes out of what the telemetry shutdown gets", async () => {
  const { report, calls, clock } = await onSignal(400, async (c) => {
    c.advance(100);
  });
  assert.deepEqual(report, { ok: true, errors: [] });
  assert.deepEqual(calls, [{ timeoutMillis: 300 }]);
  assert.equal(clock.armed[0]?.cleared, true, "the deadline timer is cancelled once beforeShutdown is done");
});

test("a deadline timer that fires late still leaves the shutdown its tenth", async () => {
  const { calls } = await onSignal(1000, hung(5000));
  assert.deepEqual(calls, [{ timeoutMillis: 100 }]);
});

test("with beforeShutdown and no deadline given, the two share the 5000 ms default", async () => {
  const { calls, clock } = await onSignal(undefined, () => {});
  assert.equal(clock.armed[0]?.ms, 4500);
  assert.deepEqual(calls, [{ timeoutMillis: 5000 }]);
});

// A deadline is a number of milliseconds. A string that reads as a finite number is taken as that
// number, as it always was. Anything else that is not a number is the default.
test("the deadline is clamped and read as Telemetry.shutdown reads it", async () => {
  for (const [given, beforeCap, shutdownGets] of [
    [0, 0, 0],
    [-5, 0, 0],
    [Number.POSITIVE_INFINITY, (2 ** 31 - 1) * 0.9, 2 ** 31 - 1],
    [2 ** 40, (2 ** 31 - 1) * 0.9, 2 ** 31 - 1],
    [Number.NaN, 4500, 5000],
    ["3000", 2700, 3000],
    [" 250 ", 225, 250],
    ["abc", 4500, 5000],
    ["", 4500, 5000],
    [null, 4500, 5000],
    [{}, 4500, 5000],
    [100.5, 90.45, 100.5],
  ] as const) {
    const { report, calls, clock } = await onSignal(given, () => {});
    assert.deepEqual(report, { ok: true, errors: [] }, String(given));
    assert.equal(clock.armed[0]?.ms, beforeCap, `beforeShutdown's cap for ${String(given)}`);
    assert.deepEqual(calls, [{ timeoutMillis: shutdownGets }], String(given));
  }
});

test("a deadline of zero still runs a beforeShutdown that finishes at once, and reports one that does not", async () => {
  const sync = await onSignal(0, () => {});
  assert.deepEqual(sync.report, { ok: true, errors: [] });
  const slow = await onSignal(0, hung());
  assert.match(String(slow.report.errors[0]?.error), /beforeShutdown: deadline exceeded/);
  assert.deepEqual(slow.calls, [{ timeoutMillis: 0 }]);
});

test("without beforeShutdown the deadline goes to the shutdown as it was given", async () => {
  for (const given of [0, -5, Number.POSITIVE_INFINITY, "3000"] as const) {
    const source = new EventEmitter();
    const { telemetry, calls } = fakeTelemetry();
    const done = shutdownOnSignalsWith(source, telemetry, { timeoutMillis: given as number });
    source.emit("SIGTERM");
    await done;
    assert.deepEqual(calls, [{ timeoutMillis: given }]);
  }
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
