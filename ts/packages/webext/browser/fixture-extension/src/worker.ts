/**
 * Scaffold. The test extension's service worker. It counts its wakes in IndexedDB, which is what
 * the harness spec checks survives a stop; WP5 replaces the body with setupWorker.
 */
import * as webext from "@libo11y/webext";

declare const chrome: webext.ChromeLike;

function wakes(): Promise<number> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("harness", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("wakes");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("wakes", "readwrite");
      const store = tx.objectStore("wakes");
      const get = store.get("count");
      get.onsuccess = () => {
        const count = ((get.result as number | undefined) ?? 0) + 1;
        store.put(count, "count");
        tx.oncomplete = () => resolve(count);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const state = { exports: Object.keys(webext).sort(), wakes: wakes() };
(globalThis as { __harness?: unknown }).__harness = state;

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if ((message as { type?: string }).type === "wake") {
    void state.wakes.then((n) => reply({ wakes: n }));
    return true;
  }
  return false;
});
