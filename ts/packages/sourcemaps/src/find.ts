import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A script and the source map that describes it. */
export interface SourceMapFile {
  /** Absolute path of the generated script. */
  readonly script: string;
  /** Absolute path of its source map. */
  readonly map: string;
  /** The URL path the script is served at, as stack traces report it. */
  readonly url: string;
}

const SCRIPT = /\.(?:m?js|cjs|bundle)$/;
const MAP_COMMENT = /^\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/;

/**
 * Finds every script under directory that has an external source map: the file its
 * `//# sourceMappingURL=` comment names, or a sibling `<script>.map` when it has no comment. Scripts
 * with an inline `data:` map are skipped, and so is a map outside directory. `node_modules` is not
 * searched. Each script's URL is urlPrefix joined to its path relative to directory, so with
 * urlPrefix "/assets/" the file `app.js` is served at "/assets/app.js". A "~/" prefix stands for the
 * site root. The result is sorted by URL.
 */
export async function findSourceMaps(directory: string, urlPrefix: string): Promise<SourceMapFile[]> {
  const root = resolve(directory);
  const out: SourceMapFile[] = [];
  for (const script of await walk(root)) {
    if (!SCRIPT.test(script)) continue;
    const map = await mapFor(root, script);
    if (map === undefined) continue;
    const rel = relative(root, script).split(sep).join("/");
    out.push({ script, map, url: joinUrl(urlPrefix, rel) });
  }
  return out.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

/** The sourceMappingURL comment on a script's last non-empty line, if any. */
export function mapComment(text: string): string | undefined {
  const tail = text.trimEnd().split("\n").at(-1) ?? "";
  return MAP_COMMENT.exec(tail.trim())?.[1];
}

async function mapFor(root: string, script: string): Promise<string | undefined> {
  const ref = mapComment(await readFile(script, "utf8"));
  let candidate: string;
  if (ref !== undefined) {
    if (ref.startsWith("data:") || /^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return undefined;
    const path = ref.split(/[?#]/)[0] ?? "";
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return undefined;
    }
    candidate = resolve(dirname(script), decoded);
  } else {
    candidate = `${script}.map`;
  }
  if (!inside(root, candidate)) return undefined;
  return (await isFile(candidate)) ? candidate : undefined;
}

// inside reports whether path is root or below it.
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...(await walk(path)));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// joinUrl joins prefix and a relative path with exactly one slash.
function joinUrl(prefix: string, rel: string): string {
  return `${prefix.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
}
