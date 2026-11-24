/**
 * Go's path.Match, ported for ignorePaths: shell patterns over slash-separated paths, where '*'
 * matches any run of non-slash characters, '?' one non-slash character, '[...]' a character class
 * (negated with '^', ranges with '-') and '\' escapes the next character. The pattern must match
 * the whole name. Like Go, a malformed pattern is reported even when the match already failed.
 */

/** Thrown for a malformed pattern, as Go returns path.ErrBadPattern. */
export class BadPatternError extends Error {
  constructor() {
    super("syntax error in pattern");
    this.name = "BadPatternError";
  }
}

// Patterns and names are handled as arrays of code points, so '?' and classes consume one
// character the way Go consumes one rune.
type Chars = readonly string[];

/** Reports whether name matches the shell pattern. Throws BadPatternError for a malformed one. */
export function pathMatch(pattern: string, name: string): boolean {
  let p: Chars = Array.from(pattern);
  let n: Chars = Array.from(name);
  chunks: while (p.length > 0) {
    const { star, chunk, rest } = scanChunk(p);
    p = rest;
    if (star && chunk.length === 0) {
      // A trailing star matches the rest of the name unless it has a slash.
      return !n.includes("/");
    }
    const here = matchChunk(chunk, n);
    // The last chunk must exhaust the name, or the star may still find a later match.
    if (here !== undefined && (here.length === 0 || p.length > 0)) {
      n = here;
      continue;
    }
    if (star) {
      // Look for a match after skipping i+1 characters; a star never skips a slash.
      for (let i = 0; i < n.length && n[i] !== "/"; i++) {
        const t = matchChunk(chunk, n.slice(i + 1));
        if (t !== undefined) {
          if (p.length === 0 && t.length > 0) continue;
          n = t;
          continue chunks;
        }
      }
    }
    // Before reporting no match, check that the rest of the pattern is well formed.
    while (p.length > 0) {
      const next = scanChunk(p);
      p = next.rest;
      matchChunk(next.chunk, []);
    }
    return false;
  }
  return n.length === 0;
}

// scanChunk splits off the next run of non-star pattern characters, with any stars before it.
function scanChunk(pattern: Chars): { star: boolean; chunk: Chars; rest: Chars } {
  let i = 0;
  while (i < pattern.length && pattern[i] === "*") i++;
  const star = i > 0;
  const p = pattern.slice(i);
  let inRange = false;
  for (let j = 0; j < p.length; j++) {
    switch (p[j]) {
      case "\\":
        // A trailing backslash is reported by matchChunk.
        if (j + 1 < p.length) j++;
        break;
      case "[":
        inRange = true;
        break;
      case "]":
        inRange = false;
        break;
      case "*":
        if (!inRange) return { star, chunk: p.slice(0, j), rest: p.slice(j) };
        break;
    }
  }
  return { star, chunk: p, rest: [] };
}

// matchChunk matches a star-free chunk against the start of s and returns what is left of s, or
// undefined when it does not match. After a mismatch it keeps reading the chunk, so a malformed
// pattern still throws.
function matchChunk(chunkIn: Chars, sIn: Chars): Chars | undefined {
  let chunk = chunkIn;
  let s = sIn;
  let failed = false;
  while (chunk.length > 0) {
    failed ||= s.length === 0;
    const c = chunk[0] as string;
    if (c === "[") {
      let r = -1;
      if (!failed) {
        r = (s[0] as string).codePointAt(0) as number;
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
      let negated = false;
      if (chunk[0] === "^") {
        negated = true;
        chunk = chunk.slice(1);
      }
      let match = false;
      let ranges = 0;
      for (;;) {
        if (chunk[0] === "]" && ranges > 0) {
          chunk = chunk.slice(1);
          break;
        }
        const lo = getEsc(chunk);
        chunk = lo.rest;
        let hi = lo.r;
        if (chunk[0] === "-") {
          const h = getEsc(chunk.slice(1));
          chunk = h.rest;
          hi = h.r;
        }
        match ||= lo.r <= r && r <= hi;
        ranges++;
      }
      failed ||= match === negated;
      continue;
    }
    if (c === "?") {
      if (!failed) {
        failed = s[0] === "/";
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
      continue;
    }
    let literal = c;
    if (c === "\\") {
      chunk = chunk.slice(1);
      if (chunk.length === 0) throw new BadPatternError();
      literal = chunk[0] as string;
    }
    if (!failed) {
      failed = literal !== s[0];
      s = s.slice(1);
    }
    chunk = chunk.slice(1);
  }
  return failed ? undefined : s;
}

// getEsc reads one possibly escaped character of a character class.
function getEsc(chunkIn: Chars): { r: number; rest: Chars } {
  let chunk = chunkIn;
  if (chunk.length === 0 || chunk[0] === "-" || chunk[0] === "]") throw new BadPatternError();
  if (chunk[0] === "\\") {
    chunk = chunk.slice(1);
    if (chunk.length === 0) throw new BadPatternError();
  }
  const r = (chunk[0] as string).codePointAt(0) as number;
  const rest = chunk.slice(1);
  if (rest.length === 0) throw new BadPatternError();
  return { r, rest };
}

/** Whether path matches any pattern. A malformed pattern never matches, as in Go's WithIgnorePaths. */
export function matchesAny(patterns: readonly string[], path: string): boolean {
  for (const pattern of patterns) {
    try {
      if (pathMatch(pattern, path)) return true;
    } catch (err) {
      if (!(err instanceof BadPatternError)) throw err;
    }
  }
  return false;
}
