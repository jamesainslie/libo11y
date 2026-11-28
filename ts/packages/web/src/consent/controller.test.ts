import assert from "node:assert/strict";
import { test } from "node:test";
import { type DiagLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import type { ConsentState } from "../contracts/consent.ts";
import { createConsentController } from "./controller.ts";

const NO_SIGNALS = { navigator: {} };

// captureDiag routes diag errors into an array for the duration of fn.
async function captureDiag(fn: (errors: unknown[][]) => Promise<void> | void): Promise<void> {
  const errors: unknown[][] = [];
  const logger: DiagLogger = {
    error: (...args) => {
      errors.push(args);
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
    verbose: () => {},
  };
  diag.setLogger(logger, { logLevel: DiagLogLevel.ERROR, suppressOverrideMessage: true });
  try {
    await fn(errors);
  } finally {
    diag.disable();
  }
}

test("consent starts pending by default and the gate is closed", () => {
  const c = createConsentController(NO_SIGNALS);
  assert.equal(c.consent.state(), "pending");
  assert.equal(c.recording(), false);
});

test("initial sets the starting state", () => {
  for (const initial of ["pending", "granted", "denied"] as const) {
    const c = createConsentController({ ...NO_SIGNALS, initial });
    assert.equal(c.consent.state(), initial);
    assert.equal(c.recording(), initial === "granted");
  }
});

test("grant, revoke and grant again", async () => {
  const c = createConsentController(NO_SIGNALS);
  assert.equal(c.consent.grant(), "granted");
  assert.equal(c.consent.state(), "granted");
  assert.equal(c.recording(), true);
  const revoked = c.consent.revoke();
  assert.equal(c.consent.state(), "denied", "denied before revoke resolves");
  assert.equal(c.recording(), false);
  assert.equal(await revoked, undefined);
  assert.equal(c.consent.grant(), "granted");
  assert.equal(c.recording(), true);
});

test("a respected Do Not Track starts denied and refuses grant", () => {
  const c = createConsentController({
    initial: "granted",
    respectDoNotTrack: true,
    navigator: { doNotTrack: "1" },
  });
  assert.equal(c.consent.state(), "denied");
  assert.equal(c.consent.grant(), "denied");
  assert.equal(c.consent.state(), "denied");
  assert.equal(c.recording(), false);
});

test("a respected Global Privacy Control starts denied and refuses grant", () => {
  const c = createConsentController({
    respectGlobalPrivacyControl: true,
    navigator: { globalPrivacyControl: true },
  });
  assert.equal(c.consent.state(), "denied");
  assert.equal(c.consent.grant(), "denied");
});

test("signals that are not respected change nothing", () => {
  const c = createConsentController({ navigator: { doNotTrack: "1", globalPrivacyControl: true } });
  assert.equal(c.consent.state(), "pending");
  assert.equal(c.consent.grant(), "granted");
});

test("the default navigator is globalThis.navigator", (t) => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { globalPrivacyControl: true },
    configurable: true,
    writable: true,
  });
  t.after(() => {
    if (desc === undefined) delete (globalThis as { navigator?: unknown }).navigator;
    else Object.defineProperty(globalThis, "navigator", desc);
  });
  const c = createConsentController({ respectGlobalPrivacyControl: true });
  assert.equal(c.consent.state(), "denied");
});

test("subscribers hear only real changes, in registration order", async () => {
  const c = createConsentController(NO_SIGNALS);
  const seen: string[] = [];
  c.consent.subscribe((s) => seen.push(`a:${s}`));
  c.consent.subscribe((s) => seen.push(`b:${s}`));
  c.consent.grant();
  c.consent.grant();
  await c.consent.revoke();
  await c.consent.revoke();
  c.consent.grant();
  assert.deepEqual(seen, ["a:granted", "b:granted", "a:denied", "b:denied", "a:granted", "b:granted"]);
});

test("subscribers are called synchronously and can unsubscribe", () => {
  const c = createConsentController(NO_SIGNALS);
  const seen: ConsentState[] = [];
  const off = c.consent.subscribe((s) => seen.push(s));
  c.consent.grant();
  assert.deepEqual(seen, ["granted"]);
  off();
  void c.consent.revoke();
  assert.deepEqual(seen, ["granted"]);
});

test("a subscriber that unsubscribes another during a change does not break the round", () => {
  const c = createConsentController(NO_SIGNALS);
  const seen: string[] = [];
  let offB: () => void = () => {};
  c.consent.subscribe(() => {
    seen.push("a");
    offB();
  });
  offB = c.consent.subscribe(() => seen.push("b"));
  c.consent.grant();
  void c.consent.revoke();
  assert.deepEqual(seen, ["a", "b", "a"]);
});

test("a throwing subscriber is reported through diag and the rest still run", async () => {
  await captureDiag((errors) => {
    const c = createConsentController(NO_SIGNALS);
    const seen: string[] = [];
    c.consent.subscribe(() => {
      throw new Error("boom");
    });
    c.subscribe(() => {
      throw new Error("gate boom");
    });
    c.consent.subscribe((s) => seen.push(s));
    c.subscribe((r) => seen.push(`gate:${r}`));
    assert.equal(c.consent.grant(), "granted");
    assert.deepEqual(seen, ["gate:true", "granted"]);
    assert.equal(errors.length, 2);
    assert.ok(errors.some((args) => args.some((a) => a instanceof Error && a.message === "boom")));
  });
});

test("the gate subscribe hears recording changes only, before consent subscribers", async () => {
  const c = createConsentController(NO_SIGNALS);
  const seen: string[] = [];
  c.consent.subscribe((s) => seen.push(s));
  const off = c.subscribe((r) => seen.push(`gate:${r}`));
  await c.consent.revoke();
  assert.deepEqual(seen, ["denied"], "pending to denied does not change recording");
  c.consent.grant();
  await c.consent.revoke();
  assert.deepEqual(seen, ["denied", "gate:true", "granted", "gate:false", "denied"]);
  off();
  c.consent.grant();
  assert.deepEqual(seen.slice(-1), ["granted"]);
});

test("revoke runs the hooks in order after the state change and waits for them", async () => {
  const c = createConsentController({ ...NO_SIGNALS, initial: "granted" });
  const seen: string[] = [];
  c.onRevoke(async () => {
    seen.push(`first:${c.consent.state()}`);
    await new Promise((r) => setTimeout(r, 10));
    seen.push("first done");
  });
  c.onRevoke(() => {
    seen.push("second");
  });
  await c.consent.revoke();
  assert.deepEqual(seen, ["first:denied", "first done", "second"]);
});

test("a failing hook is reported and the rest still run; revoke never rejects", async () => {
  await captureDiag(async (errors) => {
    const c = createConsentController({ ...NO_SIGNALS, initial: "granted" });
    const seen: string[] = [];
    c.onRevoke(() => {
      throw new Error("sync hook");
    });
    c.onRevoke(async () => {
      throw new Error("async hook");
    });
    c.onRevoke(() => {
      seen.push("ran");
    });
    await c.consent.revoke();
    assert.deepEqual(seen, ["ran"]);
    assert.equal(errors.length, 2);
  });
});

test("an unregistered hook does not run, and hooks run on every revoke", async () => {
  const c = createConsentController(NO_SIGNALS);
  let a = 0;
  let b = 0;
  const offA = c.onRevoke(() => {
    a++;
  });
  c.onRevoke(() => {
    b++;
  });
  await c.consent.revoke();
  offA();
  await c.consent.revoke();
  assert.equal(a, 1);
  assert.equal(b, 2, "a revoke while denied still clears the queues");
});

// held is a revoke hook the test finishes by hand.
function held(): { hook: () => Promise<void>; finish: () => void; fail: (err: Error) => void } {
  let finish: () => void = () => {};
  let fail: (err: Error) => void = () => {};
  return {
    hook: () =>
      new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
    finish: () => finish(),
    fail: (err) => fail(err),
  };
}

test("a grant during a revocation shows at once and opens the gate when the hooks have settled", async () => {
  const c = createConsentController({ ...NO_SIGNALS, initial: "granted" });
  const h = held();
  c.onRevoke(h.hook);
  const seen: string[] = [];
  c.consent.subscribe((s) => seen.push(s));
  c.subscribe((r) => seen.push(`gate:${r}`));

  const revoked = c.consent.revoke();
  assert.equal(c.consent.grant(), "granted", "the decision is the user's and shows at once");
  assert.equal(c.consent.state(), "granted");
  assert.equal(c.recording(), false, "export stays closed while the revocation cleans up");
  assert.deepEqual(seen, ["gate:false", "denied", "granted"]);

  h.finish();
  await revoked;
  assert.equal(c.recording(), true);
  assert.deepEqual(seen, ["gate:false", "denied", "granted", "gate:true"]);
});

test("a revocation that ends while consent is denied leaves the gate closed", async () => {
  const c = createConsentController({ ...NO_SIGNALS, initial: "granted" });
  const h = held();
  c.onRevoke(h.hook);
  const gate: boolean[] = [];
  c.subscribe((r) => gate.push(r));
  const revoked = c.consent.revoke();
  h.finish();
  await revoked;
  assert.equal(c.recording(), false);
  assert.deepEqual(gate, [false]);
  assert.equal(c.consent.grant(), "granted");
  assert.equal(c.recording(), true, "with no revocation in progress a grant opens the gate at once");
  assert.deepEqual(gate, [false, true]);
});

test("overlapping revocations keep the gate closed until the last one has settled", async () => {
  const c = createConsentController({ ...NO_SIGNALS, initial: "granted" });
  const finishers: (() => void)[] = [];
  c.onRevoke(() => new Promise<void>((resolve) => finishers.push(resolve)));
  const gate: boolean[] = [];
  c.subscribe((r) => gate.push(r));

  const first = c.consent.revoke();
  const second = c.consent.revoke();
  c.consent.grant();
  assert.equal(finishers.length, 2, "each revocation runs the hooks");
  finishers[0]?.();
  await first;
  assert.equal(c.recording(), false, "the second revocation is still cleaning up");
  finishers[1]?.();
  await second;
  assert.equal(c.recording(), true);
  assert.deepEqual(gate, [false, true]);
});

test("a revoke during a deferred grant denies again and the gate never opens", async () => {
  const c = createConsentController({ ...NO_SIGNALS, initial: "granted" });
  const finishers: (() => void)[] = [];
  c.onRevoke(() => new Promise<void>((resolve) => finishers.push(resolve)));
  const seen: string[] = [];
  c.consent.subscribe((s) => seen.push(s));
  c.subscribe((r) => seen.push(`gate:${r}`));

  const first = c.consent.revoke();
  c.consent.grant();
  const second = c.consent.revoke();
  assert.equal(c.consent.state(), "denied");
  finishers[0]?.();
  await first;
  finishers[1]?.();
  await second;
  assert.equal(c.recording(), false);
  assert.deepEqual(seen, ["gate:false", "denied", "granted", "denied"]);
});

test("a hook that fails or settles late still lets a deferred grant open the gate", async () => {
  await captureDiag(async (errors) => {
    const c = createConsentController({ ...NO_SIGNALS, initial: "granted" });
    const h = held();
    c.onRevoke(h.hook);
    c.onRevoke(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
    const revoked = c.consent.revoke();
    c.consent.grant();
    h.fail(new Error("flush failed"));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.recording(), false, "the second hook has not run to its deadline yet");
    await revoked;
    assert.equal(c.recording(), true);
    assert.equal(errors.length, 1);
  });
});

test("a grant a privacy signal refuses during a revocation stays denied", async () => {
  const nav = { doNotTrack: "0" };
  const c = createConsentController({ initial: "granted", respectDoNotTrack: true, navigator: nav });
  const h = held();
  c.onRevoke(h.hook);
  const revoked = c.consent.revoke();
  nav.doNotTrack = "1";
  assert.equal(c.consent.grant(), "denied");
  h.finish();
  await revoked;
  assert.equal(c.recording(), false);
});
