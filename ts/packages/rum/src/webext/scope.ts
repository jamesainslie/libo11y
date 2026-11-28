/**
 * The content script rules (decision P20). A content script shares the host page's document, so
 * RUM there records only what is the extension's own: actions inside the extension's UI root,
 * errors from the extension's own scripts, and one fixed view whose span names the host only by
 * url.domain.
 */
import type { RumScope } from "../contracts/runtime.ts";

/** The first extension or web URL in a stack trace. */
const FRAME_URL = /\b(?:(?:chrome|moz|safari-web)-extension|https?|file):\/\/[^\s)'"]+/;

function firstFrame(stack: unknown): string | undefined {
  return typeof stack === "string" ? FRAME_URL.exec(stack)?.[0] : undefined;
}

function stackOf(v: unknown): unknown {
  return typeof v === "object" && v !== null ? (v as { stack?: unknown }).stack : undefined;
}

/**
 * Where an error event came from: a failed element's resource URL, a CSP violation's source file,
 * an uncaught error's filename (else its stack's first frame), or a rejection reason's first frame.
 */
export function errorSourceUrl(e: Event): string | undefined {
  const target = e.target as {
    tagName?: unknown;
    currentSrc?: unknown;
    src?: unknown;
    href?: unknown;
  } | null;
  if (e.type === "error" && typeof target?.tagName === "string") {
    for (const v of [target.currentSrc, target.src, target.href])
      if (typeof v === "string" && v !== "") return v;
    return undefined;
  }
  if (e.type === "securitypolicyviolation") {
    const file = (e as { sourceFile?: unknown }).sourceFile;
    return typeof file === "string" && file !== "" ? file : undefined;
  }
  if (e.type === "unhandledrejection") return firstFrame(stackOf((e as { reason?: unknown }).reason));
  const ev = e as { filename?: unknown; error?: unknown };
  if (typeof ev.filename === "string" && ev.filename !== "") return ev.filename;
  return firstFrame(stackOf(ev.error));
}

export interface ContentScopeOptions {
  /** The extension's base URL, chrome.runtime.getURL(""). */
  readonly base: string;
  /** The extension's own UI in the page. Without it, no actions. */
  readonly uiRoot?: Node;
  /** The host page's host name, for url.domain. */
  readonly host: string;
}

/** The RumScope of a content script. */
export function contentScope(o: ContentScopeOptions): RumScope {
  const root = o.uiRoot;
  return {
    action: (e) =>
      root !== undefined && typeof e.composedPath === "function" && e.composedPath().includes(root),
    error: (e) => errorSourceUrl(e)?.startsWith(o.base) === true,
    fixedView: true,
    ...(o.host === "" ? {} : { viewAttributes: { "url.domain": o.host } }),
  };
}
