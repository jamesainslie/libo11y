/**
 * UTF-8 and base64 encoding without TextEncoder or btoa, which the ES library types core builds
 * against do not declare and which not every runtime core targets is guaranteed to have.
 */

/** Encodes s as UTF-8. A lone surrogate becomes U+FFFD, as TextEncoder and Go's []byte(s) do. */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      cp = 0xfffd;
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return Uint8Array.from(out);
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encodes data as standard, padded base64 (Go base64.StdEncoding). */
export function base64Encode(data: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < data.length; i += 3) {
    const n = ((data[i] as number) << 16) | ((data[i + 1] as number) << 8) | (data[i + 2] as number);
    out += BASE64[n >> 18] + (BASE64[(n >> 12) & 63] as string) + BASE64[(n >> 6) & 63] + BASE64[n & 63];
  }
  const rest = data.length - i;
  if (rest === 1) {
    const n = (data[i] as number) << 16;
    out += `${BASE64[n >> 18]}${BASE64[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = ((data[i] as number) << 16) | ((data[i + 1] as number) << 8);
    out += `${BASE64[n >> 18]}${BASE64[(n >> 12) & 63]}${BASE64[(n >> 6) & 63]}=`;
  }
  return out;
}

/** Lowercase hex of data. */
export function hexEncode(data: Uint8Array): string {
  let out = "";
  for (const b of data) out += b.toString(16).padStart(2, "0");
  return out;
}
