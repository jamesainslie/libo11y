/**
 * Coalesced: an operation that must not overlap itself, with callers that arrive while it runs
 * sharing one follow-up run. No sleeps: each run is finished by hand.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Coalesced } from "./coalesce.ts";

/** An operation whose every run the test finishes, and that counts how many run at once. */
function manual(): {
  coalesced: Coalesced;
  runs: { finish(): void; fail(err: unknown): void }[];
  mostAtOnce(): number;
} {
  const runs: { finish(): void; fail(err: unknown): void }[] = [];
  let active = 0;
  let most = 0;
  const coalesced = new Coalesced(
    () =>
      new Promise<void>((resolve, reject) => {
        active++;
        most = Math.max(most, active);
        runs.push({
          finish: () => {
            active--;
            resolve();
          },
          fail: (err) => {
            active--;
            reject(err);
          },
        });
      }),
  );
  return { coalesced, runs, mostAtOnce: () => most };
}

/** Lets every microtask already queued, and those they queue, run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function state(p: Promise<void>): () => string {
  let s = "pending";
  p.then(
    () => {
      s = "resolved";
    },
    (err: unknown) => {
      s = `rejected ${String((err as Error).message)}`;
    },
  );
  return () => s;
}

test("a run with nothing running starts at once", async () => {
  const m = manual();
  const a = state(m.coalesced.run());
  assert.equal(m.runs.length, 1);
  m.runs[0]?.finish();
  await drain();
  assert.equal(a(), "resolved");
  // And the next one starts at once again: nothing was left waiting.
  const b = state(m.coalesced.run());
  assert.equal(m.runs.length, 2);
  m.runs[1]?.finish();
  await drain();
  assert.equal(b(), "resolved");
});

test("callers that arrive while a run is under way share one follow-up, which starts when that run ends", async () => {
  const m = manual();
  const a = state(m.coalesced.run());
  const late = [m.coalesced.run(), m.coalesced.run(), m.coalesced.run()];
  const states = late.map(state);
  assert.equal(late[0], late[1], "one promise for all of them");
  assert.equal(late[1], late[2]);
  await drain();
  assert.equal(m.runs.length, 1, "the follow-up has not started: the first run has not ended");
  assert.deepEqual(
    states.map((s) => s()),
    ["pending", "pending", "pending"],
  );

  m.runs[0]?.finish();
  await drain();
  assert.equal(a(), "resolved");
  assert.equal(m.runs.length, 2, "one follow-up for the three of them");
  assert.deepEqual(
    states.map((s) => s()),
    ["pending", "pending", "pending"],
    "they wait for the follow-up",
  );

  m.runs[1]?.finish();
  await drain();
  assert.deepEqual(
    states.map((s) => s()),
    ["resolved", "resolved", "resolved"],
  );
  assert.equal(m.runs.length, 2, "nothing else ran");
  assert.equal(m.mostAtOnce(), 1);
});

test("a caller that arrives during the follow-up waits for the next one, never for more than two runs", async () => {
  const m = manual();
  void m.coalesced.run();
  const b = state(m.coalesced.run());
  m.runs[0]?.finish();
  await drain();
  assert.equal(m.runs.length, 2);
  // The follow-up is running. Its callers are served by it, a new caller by the one after it.
  const c = state(m.coalesced.run());
  const d = state(m.coalesced.run());
  await drain();
  assert.equal(m.runs.length, 2);
  m.runs[1]?.finish();
  await drain();
  assert.equal(b(), "resolved");
  assert.equal(c(), "pending");
  assert.equal(m.runs.length, 3, "the run after the follow-up started when the follow-up ended");
  m.runs[2]?.finish();
  await drain();
  assert.equal(c(), "resolved");
  assert.equal(d(), "resolved");
  assert.equal(m.runs.length, 3);
  assert.equal(m.mostAtOnce(), 1);
});

test("a run that fails still lets the follow-up start, and a follow-up that fails tells everyone who shares it", async () => {
  const m = manual();
  const a = state(m.coalesced.run());
  const b = state(m.coalesced.run());
  const c = state(m.coalesced.run());
  m.runs[0]?.fail(new Error("first"));
  await drain();
  assert.equal(a(), "rejected first");
  assert.equal(b(), "pending", "the first run's failure is not the follow-up's");
  assert.equal(m.runs.length, 2);
  m.runs[1]?.fail(new Error("second"));
  await drain();
  assert.equal(b(), "rejected second");
  assert.equal(c(), "rejected second");
  // Nothing is stuck: the next run starts at once.
  const d = state(m.coalesced.run());
  assert.equal(m.runs.length, 3);
  m.runs[2]?.finish();
  await drain();
  assert.equal(d(), "resolved");
});

test("an operation that throws instead of returning a promise rejects the run and leaves nothing stuck", async () => {
  let calls = 0;
  const coalesced = new Coalesced(() => {
    calls++;
    if (calls === 1) throw new Error("thrown");
    return Promise.resolve();
  });
  const a = state(coalesced.run());
  await drain();
  assert.equal(a(), "rejected thrown");
  const b = state(coalesced.run());
  await drain();
  assert.equal(b(), "resolved");
  assert.equal(calls, 2);
});

// The step from one run to the next is one step. A caller woken by the end of a run, calling again
// at once, must not start a run beside the follow-up that the same end starts.
test("no two runs overlap, whatever calls again the moment a run ends", async () => {
  const m = manual();
  const again: Promise<void>[] = [];
  const first = m.coalesced.run();
  // Registered before anyone waits for a follow-up, so these reactions run first when the run ends.
  for (let hops = 0; hops < 6; hops++) {
    let p: Promise<void> = first;
    for (let i = 0; i < hops; i++) p = p.then(() => undefined);
    void p.then(() => {
      again.push(m.coalesced.run());
    });
  }
  const follower = m.coalesced.run();
  for (let round = 0; round < 12; round++) {
    await drain();
    m.runs[round]?.finish();
  }
  await drain();
  await Promise.all([first, follower, ...again]);
  assert.equal(again.length, 6);
  assert.equal(m.mostAtOnce(), 1, "one run at a time");
  assert.ok(m.runs.length <= 4, `callers were coalesced: ${m.runs.length} runs for 8 calls`);
});

test("idle resolves once nothing runs and nothing waits to, and never rejects", async () => {
  const m = manual();
  let idle = false;
  await m.coalesced.idle();
  void m.coalesced.run();
  void m.coalesced.run().catch(() => undefined);
  void m.coalesced.idle().then(() => {
    idle = true;
  });
  await drain();
  assert.equal(idle, false, "a run is under way");
  m.runs[0]?.finish();
  await drain();
  assert.equal(idle, false, "the follow-up is under way");
  m.runs[1]?.fail(new Error("the follow-up failed"));
  await drain();
  assert.equal(idle, true, "idle after a failure too, without rejecting");
});
