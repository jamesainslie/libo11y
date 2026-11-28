/** webLifecycle: the page signals RUM's hide, show, restore and activity come from. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { webLifecycle } from "./bind.ts";

/** An EventTarget that counts its listeners and remembers the options each was added with. */
class SpyTarget extends EventTarget {
  visibilityState: "visible" | "hidden" = "visible";
  readonly added: { type: string; options: unknown }[] = [];
  #count = 0;
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, listener, options);
    this.added.push({ type, options });
    this.#count++;
  }
  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    super.removeEventListener(type, listener, options);
    this.#count--;
  }
  listeners(): number {
    return this.#count;
  }
  fire(type: string, props: Record<string, unknown> = {}): void {
    const e = new Event(type);
    for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
    this.dispatchEvent(e);
  }
}

function subscribed() {
  const doc = new SpyTarget();
  const win = new SpyTarget();
  const calls: string[] = [];
  const lifecycle = webLifecycle(doc, win);
  const off = lifecycle.subscribe({
    hide: () => calls.push("hide"),
    show: () => calls.push("show"),
    restore: () => calls.push("restore"),
  });
  return { doc, win, calls, lifecycle, off };
}

test("visibilitychange is a hide or a show by the document's visibility, pagehide is a hide", () => {
  const { doc, win, calls, lifecycle } = subscribed();
  assert.equal(lifecycle.visible(), true);
  win.fire("pagehide");
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  assert.equal(lifecycle.visible(), false);
  doc.visibilityState = "visible";
  doc.fire("visibilitychange");
  assert.deepEqual(calls, ["hide", "hide", "show"]);
});

test("only a pageshow from the back/forward cache is a restore", () => {
  const { win, calls } = subscribed();
  win.fire("pageshow", { persisted: false });
  win.fire("pageshow");
  win.fire("pageshow", { persisted: true });
  assert.deepEqual(calls, ["restore"]);
});

test("unsubscribing removes every listener from the document and the window", () => {
  const { doc, win, calls, off } = subscribed();
  assert.equal(doc.listeners(), 1);
  assert.equal(win.listeners(), 2);
  off();
  assert.equal(doc.listeners(), 0);
  assert.equal(win.listeners(), 0);
  win.fire("pagehide");
  assert.deepEqual(calls, []);
});

test("activity is pointerdown, keydown, scroll and touchstart on window, captured and passive", () => {
  const doc = new SpyTarget();
  const win = new SpyTarget();
  let touches = 0;
  const off = webLifecycle(doc, win).activity?.(() => touches++);
  assert.deepEqual(
    win.added.map((a) => a.type),
    ["pointerdown", "keydown", "scroll", "touchstart"],
  );
  for (const a of win.added) assert.deepEqual(a.options, { capture: true, passive: true });
  win.fire("keydown");
  win.fire("scroll");
  assert.equal(touches, 2);
  off?.();
  assert.equal(win.listeners(), 0);
  win.fire("keydown");
  assert.equal(touches, 2);
});

test("a context without a document or window subscribes to nothing and is visible", () => {
  const lifecycle = webLifecycle(undefined, undefined);
  assert.equal(lifecycle.visible(), true);
  lifecycle.subscribe({ hide: () => {}, show: () => {}, restore: () => {} })();
  lifecycle.activity?.(() => {})();
});
