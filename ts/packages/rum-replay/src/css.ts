/**
 * URL stripping inside CSS: style attributes, inlined stylesheets and CSSOM rule edits. A small
 * scanner, following CSS Syntax closely enough that escapes cannot hide a URL from it:
 *
 * - Comments are removed, since a URL in a comment is still data.
 * - A url() token, whatever its case and escapes (`URL(`, `\75 rl(`), has its argument decoded,
 *   stripped by stripUrl and written back as url("...").
 * - A quoted string is decoded. When it reads as a URL (a scheme of URL_SCHEMES, or no whitespace
 *   and a "/" at the start or a "?" or "#" in it), as in @import or image-set(), it is stripped by
 *   stripUrl and written back in double quotes. Any other string is kept exactly as written.
 * - Everything else is copied unchanged.
 */
import { stripUrl } from "./urls.ts";

/** Schemes that make a quoted CSS string a URL even when it holds whitespace. */
const URL_SCHEMES = /^(?:https?|data|blob|javascript|file|ftp|wss?|mailto|tel):/i;
const HEX = /^[0-9A-Fa-f]$/;
const WS = /^[\t\n\f\r ]$/;

/** The code point of a hex escape, U+FFFD for zero, a surrogate or one past U+10FFFF. */
function codePoint(hex: string): string {
  const n = Number.parseInt(hex, 16);
  return n === 0 || (n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff ? "�" : String.fromCodePoint(n);
}

/** Decodes the escape whose backslash is at css[i]. Returns the text and the index after it. */
function readEscape(css: string, i: number): { readonly text: string; readonly next: number } {
  let j = i + 1;
  if (j >= css.length) return { text: "�", next: j };
  if (HEX.test(css[j] ?? "")) {
    let hex = "";
    while (j < css.length && hex.length < 6 && HEX.test(css[j] ?? "")) hex += css[j++];
    if (css[j] === "\r" && css[j + 1] === "\n") j += 2;
    else if (WS.test(css[j] ?? "")) j++;
    return { text: codePoint(hex), next: j };
  }
  const cp = css.codePointAt(j) ?? 0;
  const ch = String.fromCodePoint(cp);
  return { text: ch, next: j + ch.length };
}

/** Whether css[i] starts a valid escape: a backslash not followed by a newline. */
function isEscape(css: string, i: number): boolean {
  return css[i] === "\\" && css[i + 1] !== "\n" && css[i + 1] !== "\r" && css[i + 1] !== "\f";
}

function isNameChar(c: string): boolean {
  return /^[A-Za-z0-9_-]$/.test(c) || c.charCodeAt(0) >= 0x80;
}

/** Reads the string whose quote is at css[i]. Returns the decoded value and the index after it. */
function readString(css: string, i: number): { readonly value: string; readonly next: number } {
  const quote = css[i];
  let j = i + 1;
  let value = "";
  while (j < css.length) {
    const c = css[j] ?? "";
    if (c === quote) return { value, next: j + 1 };
    if (c === "\n") return { value, next: j };
    if (c === "\\") {
      if (j + 1 >= css.length) {
        j++;
        continue;
      }
      if (css[j + 1] === "\n" || css[j + 1] === "\f") {
        j += 2;
        continue;
      }
      if (css[j + 1] === "\r") {
        j += css[j + 2] === "\n" ? 3 : 2;
        continue;
      }
      const e = readEscape(css, j);
      value += e.text;
      j = e.next;
      continue;
    }
    value += c;
    j++;
  }
  return { value, next: j };
}

/** Reads the argument of url( starting at css[i], right after the parenthesis, through the closing one. */
function readUrlArgument(css: string, i: number): { readonly value: string; readonly next: number } {
  let j = i;
  while (j < css.length && WS.test(css[j] ?? "")) j++;
  let value = "";
  if (css[j] === '"' || css[j] === "'") {
    const s = readString(css, j);
    value = s.value;
    j = s.next;
  } else {
    while (j < css.length && css[j] !== ")" && !WS.test(css[j] ?? "")) {
      if (css[j] === "\\") {
        const e = readEscape(css, j);
        value += e.text;
        j = e.next;
      } else {
        value += css[j++];
      }
    }
  }
  // Whatever stands between the argument and ")" is not part of a valid url() and is dropped.
  while (j < css.length && css[j] !== ")") j++;
  return { value, next: Math.min(j + 1, css.length) };
}

/** s as a double-quoted CSS string. */
function quote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === "\\") out += `\\${ch}`;
    else if (cp < 0x20 || cp === 0x7f) out += `\\${cp.toString(16)} `;
    else out += ch;
  }
  return `${out}"`;
}

function readsAsUrl(value: string): boolean {
  const t = value.trim();
  if (URL_SCHEMES.test(t)) return true;
  return !/\s/.test(t) && (t.startsWith("/") || t.includes("?") || t.includes("#"));
}

/** css with every URL stripped by stripUrl and comments removed. See the file comment. */
export function stripCssUrls(css: string, allow: ReadonlySet<string>): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const c = css[i] ?? "";
    if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const s = readString(css, i);
      out += readsAsUrl(s.value) ? quote(stripUrl(s.value, allow)) : css.slice(i, s.next);
      i = s.next;
      continue;
    }
    if (isNameChar(c) || isEscape(css, i)) {
      let j = i;
      let name = "";
      while (j < css.length) {
        const d = css[j] ?? "";
        if (isEscape(css, j)) {
          const e = readEscape(css, j);
          name += e.text;
          j = e.next;
        } else if (isNameChar(d)) {
          name += d;
          j++;
        } else {
          break;
        }
      }
      if (css[j] === "(" && name.replace(/[A-Z]/g, (x) => x.toLowerCase()) === "url") {
        const u = readUrlArgument(css, j + 1);
        out += `url(${quote(stripUrl(u.value, allow))})`;
        i = u.next;
        continue;
      }
      out += css.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
