/**
 * The fetch and sendBeacon this module saw when it was first evaluated, before setup patches
 * globalThis.fetch, so export requests never pass through libo11y's own instrumentation.
 */

/** globalThis.fetch at module evaluation, bound, or undefined where there is none. */
export const pristineFetch: typeof fetch | undefined =
  typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined;

type BeaconNavigator = { sendBeacon?: (url: string, data?: BodyInit | null) => boolean };

/** navigator.sendBeacon at module evaluation, bound, or undefined (workers, Node). */
export const pristineSendBeacon: ((url: string, data: BodyInit) => boolean) | undefined = (() => {
  const nav = (globalThis as { navigator?: BeaconNavigator }).navigator;
  return typeof nav?.sendBeacon === "function" ? nav.sendBeacon.bind(nav) : undefined;
})();
