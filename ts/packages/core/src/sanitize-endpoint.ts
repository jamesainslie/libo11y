/**
 * How the startup summary shows an OTLP endpoint: without userinfo, query or fragment, and
 * "unparseable" when anything is ambiguous, so a credential is never echoed. It reproduces Go's
 * sanitizeEndpoint, which formats with net/url's URL.String: only the scheme is lowercased and the
 * host and path are escaped. A WHATWG URL parser normalizes far more, so this is a hand port of Go
 * 1.26's url.Parse over UTF-8 bytes (conformance/vectors/endpoint-sanitize.json).
 */
import { utf8Encode } from "./utf8.ts";

const WITHHELD = "unparseable";

// Encoding modes, as in Go's net/url.
type Mode = "path" | "host" | "zone" | "userPassword" | "fragment";

class ParseError extends Error {}

function fail(): never {
  throw new ParseError();
}

function isAlnum(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39);
}

// shouldEscape is Go's net/url shouldEscape for the modes this port needs.
function shouldEscape(c: number, mode: Mode): boolean {
  if (isAlnum(c)) return false;
  const ch = String.fromCharCode(c);
  if ((mode === "host" || mode === "zone") && "!$&'()*+,;=:[]<>\"".includes(ch)) return false;
  if ("-_.~".includes(ch)) return false;
  if ("$&+,/:;=?@".includes(ch)) {
    switch (mode) {
      case "path":
        return ch === "?";
      case "userPassword":
        return ch === "@" || ch === "/" || ch === "?" || ch === ":";
      case "fragment":
        return false;
    }
  }
  if (mode === "fragment" && "!()*".includes(ch)) return false;
  return true;
}

function isHex(c: number | undefined): boolean {
  return (
    c !== undefined && ((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46))
  );
}

function unhex(c: number): number {
  if (c <= 0x39) return c - 0x30;
  if (c <= 0x46) return c - 0x41 + 10;
  return c - 0x61 + 10;
}

// A byte string holds one UTF-8 byte per char code, so Go's byte-wise logic ports directly.
type Bytes = string;

function toBytes(s: string): Bytes {
  let out = "";
  for (const b of utf8Encode(s)) out += String.fromCharCode(b);
  return out;
}

// urlUnescape is Go's unescape: it validates the escapes for mode and decodes them.
function urlUnescape(s: Bytes, mode: Mode): Bytes {
  for (let i = 0; i < s.length; ) {
    const c = s.charCodeAt(i);
    if (c === 0x25) {
      const h1 = s.charCodeAt(i + 1);
      const h2 = s.charCodeAt(i + 2);
      if (i + 2 >= s.length || !isHex(h1) || !isHex(h2)) fail();
      if (mode === "host" && unhex(h1) < 8 && s.slice(i, i + 3) !== "%25") fail();
      if (mode === "zone") {
        const v = (unhex(h1) << 4) | unhex(h2);
        if (s.slice(i, i + 3) !== "%25" && v !== 0x20 && shouldEscape(v, "host")) fail();
      }
      i += 3;
    } else {
      if ((mode === "host" || mode === "zone") && c < 0x80 && shouldEscape(c, mode)) fail();
      i++;
    }
  }
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x25) {
      out += String.fromCharCode((unhex(s.charCodeAt(i + 1)) << 4) | unhex(s.charCodeAt(i + 2)));
      i += 2;
    } else {
      out += s[i];
    }
  }
  return out;
}

const UPPER_HEX = "0123456789ABCDEF";

function urlEscape(s: Bytes, mode: Mode): Bytes {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += shouldEscape(c, mode) ? `%${UPPER_HEX[c >> 4]}${UPPER_HEX[c & 15]}` : s[i];
  }
  return out;
}

function validEncoded(s: Bytes, mode: Mode): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ("!$&'()*+,;=:@[]%".includes(s[i] as string)) continue;
    if (shouldEscape(c, mode)) return false;
  }
  return true;
}

function validOptionalPort(port: Bytes): boolean {
  return port === "" || /^:[0-9]*$/.test(port);
}

function validUserinfo(s: Bytes): boolean {
  for (let i = 0; i < s.length; i++) {
    if (!isAlnum(s.charCodeAt(i)) && !"-._:~!$&'()*+,;=%@".includes(s[i] as string)) return false;
  }
  return true;
}

// parseIPv4 is netip's strict dotted-decimal parse: four fields, no leading zeros, each <= 255.
function parseIPv4(s: string): boolean {
  const fields = s.split(".");
  return fields.length === 4 && fields.every((f) => /^(0|[1-9][0-9]{0,2})$/.test(f) && Number(f) <= 255);
}

// parseIPv6 is netip's IPv6 parse, with an optional non-empty zone after '%'.
function parseIPv6(input: string): boolean {
  let s = input;
  const pct = s.indexOf("%");
  if (pct !== -1) {
    if (pct === s.length - 1) return false;
    s = s.slice(0, pct);
  }
  let ellipsis = -1;
  let groups = 0;
  if (s.startsWith("::")) {
    ellipsis = 0;
    s = s.slice(2);
    if (s === "") return true;
  }
  while (groups < 8) {
    const m = /^[0-9a-fA-F]*/.exec(s)?.[0] ?? "";
    if (m.length === 0 || m.length > 4) return false;
    if (s[m.length] === ".") {
      if ((ellipsis < 0 && groups !== 6) || groups + 2 > 8) return false;
      if (!parseIPv4(s)) return false;
      groups += 2;
      s = "";
      break;
    }
    groups++;
    s = s.slice(m.length);
    if (s === "") break;
    if (s[0] !== ":" || s.length === 1) return false;
    s = s.slice(1);
    if (s[0] === ":") {
      if (ellipsis >= 0) return false;
      ellipsis = groups;
      s = s.slice(1);
      if (s === "") break;
    }
  }
  if (s !== "") return false;
  if (groups < 8) return ellipsis >= 0;
  return ellipsis < 0;
}

// isIPv6Literal reports whether netip.ParseAddr accepts s as an address that is not IPv4.
function isIPv6Literal(s: string): boolean {
  const first = /[.:%]/.exec(s)?.[0];
  return first === ":" && parseIPv6(s);
}

function parseHost(scheme: string, host: Bytes): Bytes {
  const open = host.lastIndexOf("[");
  if (open > 0) fail();
  if (open === 0) {
    const close = host.lastIndexOf("]");
    if (close < 0) fail();
    const colonPort = host.slice(close + 1);
    if (!validOptionalPort(colonPort)) fail();
    const port = urlUnescape(colonPort, "host");
    const hostname = host.slice(1, close);
    const zone = hostname.indexOf("%25");
    const unescaped =
      zone >= 0
        ? urlUnescape(hostname.slice(0, zone), "host") + urlUnescape(hostname.slice(zone), "zone")
        : urlUnescape(hostname, "host");
    if (!isIPv6Literal(unescaped)) fail();
    return `[${unescaped}]${port}`;
  }
  let i = host.indexOf(":");
  if (i !== -1) {
    const last = host.lastIndexOf(":");
    // Go 1.26 keeps the first colon for http and https (GODEBUG urlstrictcolons=1).
    if (last !== i && scheme !== "http" && scheme !== "https") i = last;
    if (!validOptionalPort(host.slice(i))) fail();
  }
  return urlUnescape(host, "host");
}

interface ParsedURL {
  scheme: string;
  opaque: string;
  hasUser: boolean;
  host: Bytes;
  path: Bytes;
  rawPath: Bytes;
  omitHost: boolean;
}

function getScheme(raw: Bytes): [string, Bytes] {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) continue;
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      if (i === 0) return ["", raw];
      continue;
    }
    if (c === 0x3a) {
      if (i === 0) fail();
      return [raw.slice(0, i), raw.slice(i + 1)];
    }
    return ["", raw];
  }
  return ["", raw];
}

// parse is Go's url.Parse, keeping only what sanitizeEndpoint reads.
function parse(rawURL: Bytes): ParsedURL {
  const hash = rawURL.indexOf("#");
  const u = hash < 0 ? rawURL : rawURL.slice(0, hash);
  const frag = hash < 0 ? "" : rawURL.slice(hash + 1);
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) fail(); // Go rejects any ASCII control character
  }
  const url: ParsedURL = {
    scheme: "",
    opaque: "",
    hasUser: false,
    host: "",
    path: "",
    rawPath: "",
    omitHost: false,
  };
  if (u === "*") {
    url.path = "*";
  } else {
    let [scheme, rest] = getScheme(u);
    url.scheme = scheme.toLowerCase();
    if (rest.endsWith("?") && rest.indexOf("?") === rest.length - 1) {
      rest = rest.slice(0, -1);
    } else if (rest.includes("?")) {
      rest = rest.slice(0, rest.indexOf("?"));
    }
    let done = false;
    if (!rest.startsWith("/")) {
      if (url.scheme !== "") {
        url.opaque = rest;
        done = true;
      } else if ((rest.split("/")[0] ?? "").includes(":")) {
        fail();
      }
    }
    if (!done) {
      if ((url.scheme !== "" || !rest.startsWith("///")) && rest.startsWith("//")) {
        let authority = rest.slice(2);
        rest = "";
        const slash = authority.indexOf("/");
        if (slash >= 0) {
          rest = authority.slice(slash);
          authority = authority.slice(0, slash);
        }
        const at = authority.lastIndexOf("@");
        url.host = parseHost(url.scheme, at < 0 ? authority : authority.slice(at + 1));
        if (at >= 0) {
          const userinfo = authority.slice(0, at);
          if (!validUserinfo(userinfo)) fail();
          const colon = userinfo.indexOf(":");
          if (colon < 0) {
            urlUnescape(userinfo, "userPassword");
          } else {
            urlUnescape(userinfo.slice(0, colon), "userPassword");
            urlUnescape(userinfo.slice(colon + 1), "userPassword");
          }
          url.hasUser = true;
        }
      } else if (url.scheme !== "" && rest.startsWith("/")) {
        url.omitHost = true;
      }
      url.path = urlUnescape(rest, "path");
      url.rawPath = urlEscape(url.path, "path") === rest ? "" : rest;
    }
  }
  if (frag !== "") urlUnescape(frag, "fragment");
  return url;
}

function escapedPath(u: ParsedURL): Bytes {
  if (u.rawPath !== "" && validEncoded(u.rawPath, "path")) {
    try {
      if (urlUnescape(u.rawPath, "path") === u.path) return u.rawPath;
    } catch {
      // An invalid raw path falls through to the computed escaping.
    }
  }
  if (u.path === "*") return "*";
  return urlEscape(u.path, "path");
}

// format is Go's URL.String for a URL without userinfo, query or fragment.
function format(u: ParsedURL): Bytes {
  let out = u.scheme === "" ? "" : `${u.scheme}:`;
  if (u.opaque !== "") return out + u.opaque;
  if ((u.scheme !== "" || u.host !== "") && !(u.omitHost && u.host === "")) {
    if (u.host !== "" || u.path !== "") out += "//";
    if (u.host !== "") out += urlEscape(u.host, "host");
  }
  const path = escapedPath(u);
  if (path !== "" && path[0] !== "/" && u.host !== "") out += "/";
  if (out === "" && (path.split("/")[0] ?? "").includes(":")) out += "./";
  return out + path;
}

/** Renders an exporter endpoint for display without credentials, as Go's sanitizeEndpoint does. */
export function sanitizeEndpoint(raw: string): string {
  const schemeless = !raw.includes("://");
  const input = toBytes(schemeless ? `//${raw}` : raw);
  let u: ParsedURL;
  try {
    u = parse(input);
  } catch (err) {
    if (err instanceof ParseError) return WITHHELD;
    throw err;
  }
  if (u.host === "") return WITHHELD;
  const ats = input.split("@").length - 1;
  if (ats > 1 || (ats === 1 && !u.hasUser)) return WITHHELD;
  let out = format(u);
  if (out.includes("@")) return WITHHELD;
  if (schemeless && out.startsWith("//")) out = out.slice(2);
  // Every byte above 0x7f was escaped, so the byte string is ASCII and reads as text directly.
  return out;
}
