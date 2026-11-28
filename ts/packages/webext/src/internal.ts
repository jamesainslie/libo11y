/**
 * @libo11y/webext/internal: the seams @libo11y/rum composes. For libo11y packages only; it follows
 * the package version but carries no compatibility promise and has no API report.
 */

export type { ChromeLike } from "./chrome.ts";
export { type ContentDeps, defaultContentDeps, setupContentScriptWith, WORKER_ENDPOINT } from "./content.ts";
export { defaultWorkerDeps, setupWorkerWith, type WorkerDeps } from "./worker.ts";
