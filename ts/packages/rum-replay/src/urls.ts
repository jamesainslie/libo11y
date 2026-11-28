/**
 * URL stripping for recorded attributes, CSS and the page URL. The rules are textual, never a URL
 * parser's normalization, so every implementation produces the same output:
 *
 * - ASCII tab, line feed and carriage return are removed and leading and trailing C0 controls and
 *   spaces trimmed first, as a browser does, so "java\tscript:" is seen as "javascript:".
 * - A URL with a scheme other than http or https (data, blob, javascript, mailto, tel, file,
 *   about and every other) becomes "".
 * - userinfo is removed from the authority. An authority that is not a host with an optional
 *   numeric port (an empty host, or a port that is not digits, as when the userinfo itself holds
 *   "/", "?" or "#") fails closed: the URL becomes "".
 * - The path ends at the first ";", so path parameters such as ;jsessionid= are removed.
 * - The query is split on "&" and ";", and keeps only the parameters whose name, exactly as
 *   written, is on the allow list. They are joined with "&".
 * - The fragment is removed, except a whole value that is an in-document reference such as
 *   "#icon-cart" or "#:r1:" (an SVG use or a same-page link): a letter, "_" or ":" followed by
 *   at most 63 letters, digits, "_", ":" or "-".
 * - Relative URLs stay relative.
 */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const KEPT_SCHEMES: ReadonlySet<string> = new Set(["http", "https"]);
const ID_REFERENCE = /^#[A-Za-z_:][A-Za-z0-9_:-]{0,63}$/;
/** A host (a bracketed IPv6 literal or a name without ":") with an optional numeric port. */
const HOST = /^(?:\[[0-9A-Fa-f:.]+\]|[^:[\]]+)(?::[0-9]*)?$/;

/** raw as a browser reads it: tab, LF and CR removed, C0 controls and spaces trimmed. */
function clean(raw: string): string {
  const s = raw.replace(/[\t\n\r]/g, "");
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

/** The host of rest (which starts right after the slashes) without userinfo, or undefined when it is not a valid host, and what follows it. */
function splitAuthority(rest: string): { readonly host: string | undefined; readonly tail: string } {
  const end = rest.search(/[/\\?#]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const tail = end < 0 ? "" : rest.slice(end);
  const at = authority.lastIndexOf("@");
  const host = at < 0 ? authority : authority.slice(at + 1);
  return { host: HOST.test(host) ? host : undefined, tail };
}

/** The path of tail (up to "?" or "#") followed by the allowed part of its query. */
function pathAndQuery(tail: string, allow: ReadonlySet<string>): string {
  const pathEnd = tail.search(/[?#]/);
  const full = pathEnd < 0 ? tail : tail.slice(0, pathEnd);
  const semicolon = full.indexOf(";");
  const path = semicolon < 0 ? full : full.slice(0, semicolon);
  if (pathEnd < 0 || tail[pathEnd] !== "?") return path;
  const afterQuery = tail.slice(pathEnd + 1);
  const hash = afterQuery.indexOf("#");
  const query = hash < 0 ? afterQuery : afterQuery.slice(0, hash);
  const kept = query.split(/[&;]/).filter((piece) => {
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
    if (host === undefined) return "";
    return `${name}://${host}${pathAndQuery(tail, allow)}`;
  }
  if (/^[/\\]{2}/.test(url)) {
    const { host, tail } = splitAuthority(url.slice(2));
    if (host === undefined) return "";
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

/** Schemes that make a text value a URL: the ones a page links or loads with, and those stripUrl empties. */
export const URL_SCHEMES: RegExp = /^(?:https?|data|blob|javascript|file|ftp|wss?|mailto|tel):/i;
/** A meta refresh value: a delay, then ";" or ",", then a URL. */
const REFRESH = /^(\d+(?:\.\d*)?)\s*[;,]/;

/**
 * A kept content attribute (meta og:url, og:image, twitter:image, a refresh): a value that, read as
 * stripUrl reads it, starts with a scheme of URL_SCHEMES, "/" or "\\" is stripped by stripUrl. A
 * refresh value (digits, then ";" or ",") keeps only its delay. Any other value is text and kept.
 */
export function stripContent(raw: string, allow: ReadonlySet<string>): string {
  const t = clean(raw);
  const refresh = REFRESH.exec(t);
  if (refresh !== null) return refresh[1] ?? "";
  if (URL_SCHEMES.test(t) || t.startsWith("/") || t.startsWith("\\")) return stripUrl(raw, allow);
  return raw;
}
