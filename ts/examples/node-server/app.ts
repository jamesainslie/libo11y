/**
 * The example's one route, GET /projects/:id: it fetches the project from an upstream API and
 * renders it as an HTML page, logging the project ID it loaded.
 */
import type { Logger } from "@libo11y/server";

const PROJECT = /^\/projects\/([^/]+)$/;

/** The route template of a request, for span names and metrics, or undefined when nothing matches. */
export function route(req: Request): string | undefined {
  return PROJECT.test(new URL(req.url).pathname) ? "/projects/:id" : undefined;
}

/** What the app needs: an instrumented fetch, the upstream base URL and a logger. */
export interface AppDeps {
  readonly fetch: typeof fetch;
  readonly upstream: string;
  readonly logger: Logger;
}

/** Builds the app's fetch-style handler. */
export function createApp(deps: AppDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const match = PROJECT.exec(new URL(req.url).pathname);
    if (req.method !== "GET" || match === null) return new Response("not found\n", { status: 404 });
    const id = decodeURIComponent(match[1] ?? "");
    const upstream = await deps.fetch(`${deps.upstream}/projects/${encodeURIComponent(id)}`);
    if (!upstream.ok) return new Response("upstream failed\n", { status: 502 });
    const project = (await upstream.json()) as { name: string };
    deps.logger.info("project loaded", { "example.project.id": id });
    const name = escapeHtml(project.name);
    return new Response(`<!doctype html>\n<title>${name}</title>\n<h1>${name}</h1>\n`, {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
