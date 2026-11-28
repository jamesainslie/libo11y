import assert from "node:assert/strict";
import { test } from "node:test";
import { appStateLifecycle } from "./lifecycle.ts";
import { fakeEnv } from "./test-support/fake-env.ts";

test("background and inactive hide, active shows, once per change, in registration order", () => {
  const env = fakeEnv();
  const life = appStateLifecycle(env.appState);
  const calls: string[] = [];
  life.subscribe((v) => calls.push(`a:${v}`));
  life.subscribe((v) => calls.push(`b:${v}`));
  assert.equal(life.visible(), true);
  env.setAppState("inactive");
  assert.equal(life.visible(), false);
  env.setAppState("background");
  env.setAppState("active");
  env.setAppState("active");
  assert.deepEqual(calls, ["a:false", "b:false", "a:true", "b:true"]);
  assert.equal(life.visible(), true);
});

test("an unknown or missing state counts as visible", () => {
  const env = fakeEnv();
  (env.appState as { currentState: string | null }).currentState = null;
  assert.equal(appStateLifecycle(env.appState).visible(), true);
  (env.appState as { currentState: string | null }).currentState = "unknown";
  assert.equal(appStateLifecycle(env.appState).visible(), true);
  (env.appState as { currentState: string | null }).currentState = "background";
  assert.equal(appStateLifecycle(env.appState).visible(), false);
});

test("AppState is listened to only while someone subscribes", () => {
  const env = fakeEnv();
  const life = appStateLifecycle(env.appState);
  assert.equal(env.listeners(), 0);
  const offA = life.subscribe(() => {});
  const offB = life.subscribe(() => {});
  assert.equal(env.listeners(), 1);
  offA();
  offA();
  assert.equal(env.listeners(), 1);
  offB();
  assert.equal(env.listeners(), 0);
});

test("a subscriber added while hidden hears the next show", () => {
  const env = fakeEnv();
  env.setAppState("background");
  const life = appStateLifecycle(env.appState);
  const calls: boolean[] = [];
  life.subscribe((v) => calls.push(v));
  env.setAppState("background");
  env.setAppState("active");
  assert.deepEqual(calls, [true]);
});

test("a listener that throws does not stop the others", () => {
  const env = fakeEnv();
  const life = appStateLifecycle(env.appState);
  let seen = false;
  life.subscribe(() => {
    throw new Error("x");
  });
  life.subscribe(() => {
    seen = true;
  });
  env.setAppState("background");
  assert.equal(seen, true);
});
