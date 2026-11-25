import assert from "node:assert/strict";
import { test } from "node:test";
import { installFlushOnHide, type VisibilitySource } from "./lifecycle.ts";

/** A document stand-in whose visibilityState the test sets. */
class FakeDocument extends EventTarget implements VisibilitySource {
  visibilityState: DocumentVisibilityState = "visible";

  set(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

function counter(): { flush: () => Promise<void>; calls: () => number } {
  let n = 0;
  return {
    flush: async () => {
      n++;
    },
    calls: () => n,
  };
}

test("becoming hidden flushes once, and becoming visible again re-arms it", () => {
  const doc = new FakeDocument();
  const c = counter();
  const remove = installFlushOnHide(doc, undefined, c.flush);
  try {
    doc.set("visible");
    assert.equal(c.calls(), 0);
    doc.set("hidden");
    assert.equal(c.calls(), 1);
    doc.set("hidden");
    assert.equal(c.calls(), 1);
    doc.set("visible");
    doc.set("hidden");
    assert.equal(c.calls(), 2);
  } finally {
    remove();
  }
});

test("pagehide flushes, at most once per hide together with visibilitychange", () => {
  const doc = new FakeDocument();
  const win = new EventTarget();
  const c = counter();
  const remove = installFlushOnHide(doc, win, c.flush);
  try {
    win.dispatchEvent(new Event("pagehide"));
    assert.equal(c.calls(), 1);
    doc.set("hidden");
    assert.equal(c.calls(), 1);
    win.dispatchEvent(new Event("pagehide"));
    assert.equal(c.calls(), 1);
    doc.set("visible");
    win.dispatchEvent(new Event("pageshow"));
    doc.set("hidden");
    assert.equal(c.calls(), 2);
  } finally {
    remove();
  }
});

test("a page restored from the back-forward cache flushes on its next pagehide", () => {
  const doc = new FakeDocument();
  const win = new EventTarget();
  const c = counter();
  const remove = installFlushOnHide(doc, win, c.flush);
  try {
    win.dispatchEvent(new Event("pagehide"));
    win.dispatchEvent(new Event("pageshow"));
    win.dispatchEvent(new Event("pagehide"));
    assert.equal(c.calls(), 2);
  } finally {
    remove();
  }
});

test("a flush that rejects or throws is swallowed", async () => {
  const doc = new FakeDocument();
  let n = 0;
  const remove = installFlushOnHide(doc, undefined, () => {
    n++;
    if (n === 1) return Promise.reject(new Error("boom"));
    throw new Error("sync boom");
  });
  try {
    doc.set("hidden");
    doc.set("visible");
    assert.doesNotThrow(() => doc.set("hidden"));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(n, 2);
  } finally {
    remove();
  }
});

test("the returned function removes every listener", () => {
  const doc = new FakeDocument();
  const win = new EventTarget();
  const c = counter();
  const remove = installFlushOnHide(doc, win, c.flush);
  remove();
  doc.set("hidden");
  win.dispatchEvent(new Event("pagehide"));
  assert.equal(c.calls(), 0);
  assert.doesNotThrow(remove);
});

test("a tab closed while hidden flushes what it recorded since the hide flush settled", async () => {
  const doc = new FakeDocument();
  const win = new EventTarget();
  let release: (() => void) | undefined;
  let n = 0;
  const remove = installFlushOnHide(doc, win, () => {
    n++;
    return new Promise<void>((r) => {
      release = r;
    });
  });
  try {
    doc.set("hidden");
    win.dispatchEvent(new Event("pagehide"));
    assert.equal(n, 1, "a pagehide while the hide flush runs adds none");
    release?.();
    await new Promise((r) => setTimeout(r, 0));
    // The tab stays hidden in the background and records more, then is closed: pagehide only.
    win.dispatchEvent(new Event("pagehide"));
    assert.equal(n, 2);
  } finally {
    remove();
  }
});
