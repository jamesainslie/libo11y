/**
 * URL stripping for recorded attributes, CSS and the page URL. The rules are textual, never a URL
 * parser's normalization, so every implementation produces the same output:
 *
 * - ASCII tab, line feed and carriage return are removed and leading and trailing C0 controls and
 *   spaces trimmed first, as a browser does, so "java\tscript:" is seen as "javascript:".
 * - A URL with a scheme other than http or https (data, blob, javascript, mailto, tel, file,
 *   about and every other) becomes "".
 * - userinfo is removed from the authority.
 * - The query keeps only the parameters whose name, exactly as written, is on the allow list.
 * - The fragment is removed, except a whole value that is an in-document reference such as
 *   "#icon-cart" (an SVG use or a same-page link), which carries no query or parameters.
 * - Relative URLs stay relative.
 */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const KEPT_SCHEMES: ReadonlySet<string> = new Set(["http", "https"]);
const ID_REFERENCE = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;

/** raw as a browser reads it: tab, LF and CR removed, C0 controls and spaces trimmed. */
function clean(raw: string): string {
  const s = raw.replace(/[\t\n\r]/g, "");
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

/** The authority of rest (which starts right after the slashes) without userinfo, and what follows it. */
function splitAuthority(rest: string): { readonly host: string; readonly tail: string } {
  const end = rest.search(/[/\\?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const tail = end < 0 ? "" : rest.slice(end);
  const at = authority.lastIndexOf("@");
  return { host: at < 0 ? authority : authority.slice(at + 1), tail };
}

/** The path of tail (up to "?" or "#") followed by the allowed part of its query. */
function pathAndQuery(tail: string, allow: ReadonlySet<string>): string {
  const pathEnd = tail.search(/[?#]/);
  const path = pathEnd < 0 ? tail : tail.slice(0, pathEnd);
  if (pathEnd < 0 || tail[pathEnd] !== "?") return path;
  const afterQuery = tail.slice(pathEnd + 1);
  const hash = afterQuery.indexOf("#");
  const query = hash < 0 ? afterQuery : afterQuery.slice(0, hash);
  const kept = query.split("&").filter((piece) => {
    const eq = piece.indexOf("=");
    return allow.has(eq < 0 ? piece : piece.slice(0, eq));
  });
  return kept.length > 0 ? `${path}?${kept.join("&")}` : path;
}

/** raw with userinfo and the fragment removed and the query reduced to allowed parameters. See the file comment. */
export function stripUrl(raw: string, allow: ReadonlySet<string>): string {
  const url = clean(raw);
  if (ID_REFERENCE.test(url)) return url;
  const scheme = SCHEME.exec(url);
  if (scheme !== null) {
    const name = (scheme[1] ?? "").toLowerCase();
    if (!KEPT_SCHEMES.has(name)) return "";
    const rest = url.slice(scheme[0].length).replace(/^[/\\]+/, "");
    const { host, tail } = splitAuthority(rest);
    return `${name}://${host}${pathAndQuery(tail, allow)}`;
  }
  if (/^[/\\]{2}/.test(url)) {
    const { host, tail } = splitAuthority(url.slice(2));
    return `//${host}${pathAndQuery(tail, allow)}`;
  }
  return pathAndQuery(url, allow);
}

const ASCII_WHITESPACE = /[\t\n\f\r ]/;
/** A srcset descriptor: a width (320w), a pixel density (1.5x) or a height (200h). */
const DESCRIPTOR = /^(?:\d+w|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?x|\d+h)$/;

/**
 * Each candidate of a srcset value stripped by stripUrl, keeping only valid w, x and h
 * descriptors. The value is split the way the HTML parser splits it (a URL runs to whitespace, so
 * the commas of a data URL stay inside it), and a candidate whose URL strips to "" is dropped.
 */
export function stripSrcset(raw: string, allow: ReadonlySet<string>): string {
  const out: string[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && (ASCII_WHITESPACE.test(raw[i] ?? "") || raw[i] === ",")) i++;
    if (i >= raw.length) break;
    let url = "";
    while (i < raw.length && !ASCII_WHITESPACE.test(raw[i] ?? "")) url += raw[i++];
    let descriptors = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      let depth = 0;
      while (i < raw.length) {
        const c = raw[i] ?? "";
        if (c === "," && depth === 0) break;
        if (c === "(") depth++;
        else if (c === ")" && depth > 0) depth--;
        descriptors += c;
        i++;
      }
    }
    const stripped = stripUrl(url, allow);
    if (stripped === "") continue;
    const kept = descriptors.split(/[\t\n\f\r ]+/).filter((d) => DESCRIPTOR.test(d));
    out.push(kept.length > 0 ? `${stripped} ${kept.join(" ")}` : stripped);
  }
  return out.join(", ");
}
