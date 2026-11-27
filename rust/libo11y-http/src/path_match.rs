//! Pure-Rust implementation of Go's `path.Match` glob syntax.
//!
//! Pattern syntax:
//! - `*` matches any sequence of non-`/` characters.
//! - `?` matches any single non-`/` character.
//! - `[...]` matches a character class (non-empty, optional leading `^` for
//!   negation, `lo-hi` ranges, `\` escapes); never matches `/`.
//! - `\c` matches literal character `c`.
//! - Any other character matches itself literally.
//!
//! Malformed patterns (for example unclosed `[`, reversed range `[z-a]`, or a
//! trailing `\`) never match.

/// Reports whether `name` matches the shell-style `pattern` using Go's
/// `path.Match` rules. A malformed pattern never matches and returns `false`.
#[must_use]
pub fn path_match(pattern: &str, name: &str) -> bool {
    matches!(match_checked(pattern, name), Ok(true))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BadPattern;

fn match_checked(mut pattern: &str, mut name: &str) -> Result<bool, BadPattern> {
    while !pattern.is_empty() {
        let (star, chunk, rest) = scan_chunk(pattern);
        if star && chunk.is_empty() {
            // Trailing `*` matches the rest of the segment as long as no `/` remains.
            return Ok(!name.contains('/'));
        }
        let (tail, matched) = match_chunk(chunk, name)?;
        if matched && (tail.is_empty() || !rest.is_empty()) {
            pattern = rest;
            name = tail;
            continue;
        }
        if star {
            // Try matching `chunk` at each subsequent character in this path segment.
            for (idx, ch) in name.char_indices() {
                if ch == '/' {
                    break;
                }
                let next_start = idx + ch.len_utf8();
                let (tail, matched) = match_chunk(chunk, &name[next_start..])?;
                if matched && (tail.is_empty() || !rest.is_empty()) {
                    pattern = rest;
                    name = tail;
                    break;
                }
                // If we reached the end of the segment without matching, fall through
                // to syntax-check the remainder of the pattern below.
                if next_start == name.len() || name[next_start..].starts_with('/') {
                    validate_rest(rest)?;
                    return Ok(false);
                }
            }
            if pattern == rest {
                continue;
            }
        }
        // Validate any remaining pattern chunks so malformed patterns always
        // report `Err(BadPattern)`, matching Go's `path.Match`.
        validate_rest(rest)?;
        return Ok(false);
    }
    Ok(name.is_empty())
}

/// Validates syntax of remaining pattern text without matching against a name.
fn validate_rest(mut pattern: &str) -> Result<(), BadPattern> {
    while !pattern.is_empty() {
        let (_, chunk, rest) = scan_chunk(pattern);
        validate_chunk(chunk)?;
        pattern = rest;
    }
    Ok(())
}

/// Splits `pattern` into `(leading_star, non_star_chunk, rest)`.
fn scan_chunk(mut pattern: &str) -> (bool, &str, &str) {
    let mut star = false;
    while let Some(rest) = pattern.strip_prefix('*') {
        star = true;
        pattern = rest;
    }
    let mut in_range = false;
    let bytes = pattern.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => {
                // Skip escaped byte (if any) so `\*` or `\[` does not end chunk.
                i += 1;
                if i < bytes.len() {
                    let ch = pattern[i..].chars().next().map_or(1, char::len_utf8);
                    i += ch;
                }
            }
            b'[' => {
                in_range = true;
                i += 1;
            }
            b']' => {
                in_range = false;
                i += 1;
            }
            b'*' if !in_range => {
                return (star, &pattern[..i], &pattern[i..]);
            }
            _ => {
                let ch = pattern[i..].chars().next().map_or(1, char::len_utf8);
                i += ch;
            }
        }
    }
    (star, pattern, "")
}

/// Matches a star-free `chunk` against the start of `s`, returning
/// `(remaining_s, matched)`.
fn match_chunk<'a>(mut chunk: &str, mut s: &'a str) -> Result<(&'a str, bool), BadPattern> {
    let mut failed = false;
    while !chunk.is_empty() {
        if !failed && s.is_empty() {
            failed = true;
        }
        let Some(first) = chunk.chars().next() else {
            break;
        };
        match first {
            '[' => {
                let s_char = if failed {
                    None
                } else if let Some(ch) = s.chars().next() {
                    if ch == '/' {
                        failed = true;
                    }
                    s = &s[ch.len_utf8()..];
                    Some(ch)
                } else {
                    failed = true;
                    None
                };
                let (rest, matched) = match_char_class(&chunk[1..], s_char)?;
                chunk = rest;
                if !matched {
                    failed = true;
                }
            }
            '?' => {
                if !failed {
                    match s.chars().next() {
                        Some(ch) if ch != '/' => s = &s[ch.len_utf8()..],
                        _ => failed = true,
                    }
                }
                chunk = &chunk[1..];
            }
            '\\' => {
                chunk = &chunk[1..];
                let Some(esc) = chunk.chars().next() else {
                    return Err(BadPattern);
                };
                chunk = &chunk[esc.len_utf8()..];
                if !failed {
                    match s.chars().next() {
                        Some(ch) if ch == esc => s = &s[ch.len_utf8()..],
                        _ => failed = true,
                    }
                }
            }
            c => {
                chunk = &chunk[c.len_utf8()..];
                if !failed {
                    match s.chars().next() {
                        Some(ch) if ch == c => s = &s[ch.len_utf8()..],
                        _ => failed = true,
                    }
                }
            }
        }
    }
    if failed {
        Ok(("", false))
    } else {
        Ok((s, true))
    }
}

/// Parses and matches a `[...]` character class starting immediately after `[`.
fn match_char_class(mut chunk: &str, s_char: Option<char>) -> Result<(&str, bool), BadPattern> {
    let negated = if let Some(rest) = chunk.strip_prefix('^') {
        chunk = rest;
        true
    } else {
        false
    };
    let mut matched = false;
    let mut nrange = 0usize;
    loop {
        if chunk.starts_with(']') && nrange > 0 {
            chunk = &chunk[1..];
            break;
        }
        let (lo, rest) = get_esc(chunk)?;
        chunk = rest;
        let hi = if let Some(after_dash) = chunk.strip_prefix('-') {
            let (hi, rest) = get_esc(after_dash)?;
            chunk = rest;
            if hi < lo {
                return Err(BadPattern);
            }
            hi
        } else {
            lo
        };
        if let Some(ch) = s_char
            && lo <= ch
            && ch <= hi
        {
            matched = true;
        }
        nrange += 1;
    }
    Ok((chunk, s_char.is_some() && matched != negated))
}

fn validate_chunk(chunk: &str) -> Result<(), BadPattern> {
    let _ = match_chunk(chunk, "")?;
    Ok(())
}

/// Reads a single (possibly backslash-escaped) character inside `[...]`.
fn get_esc(chunk: &str) -> Result<(char, &str), BadPattern> {
    if chunk.is_empty() || chunk.starts_with('-') || chunk.starts_with(']') {
        return Err(BadPattern);
    }
    if let Some(rest) = chunk.strip_prefix('\\') {
        let ch = rest.chars().next().ok_or(BadPattern)?;
        return Ok((ch, &rest[ch.len_utf8()..]));
    }
    let ch = chunk.chars().next().ok_or(BadPattern)?;
    Ok((ch, &chunk[ch.len_utf8()..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_go_path_match_cases() {
        let cases: &[(&str, &str, Result<bool, BadPattern>)] = &[
            ("abc", "abc", Ok(true)),
            ("*", "abc", Ok(true)),
            ("*c", "abc", Ok(true)),
            ("a*", "a", Ok(true)),
            ("a*", "abc", Ok(true)),
            ("a*", "ab/c", Ok(false)),
            ("a*/b", "abc/b", Ok(true)),
            ("a*/b", "a/c/b", Ok(false)),
            ("a*b*c*d*e*/f", "axbxcxdxe/f", Ok(true)),
            ("a*b*c*d*e*/f", "axbxcxdxexxx/f", Ok(true)),
            ("a*b*c*d*e*/f", "axbxcxdxe/xxx/f", Ok(false)),
            ("a*b*c*d*e*/f", "axbxcxdxexxx/fff", Ok(false)),
            ("ab[c]", "abc", Ok(true)),
            ("ab[b-d]", "abc", Ok(true)),
            ("ab[e-g]", "abc", Ok(false)),
            ("ab[^c]", "abc", Ok(false)),
            ("ab[^b-d]", "abc", Ok(false)),
            ("ab[^e-g]", "abc", Ok(true)),
            ("a\\*b", "a*b", Ok(true)),
            ("a\\*b", "ab", Ok(false)),
            ("a?b", "a☺b", Ok(true)),
            ("a[^a]b", "a☺b", Ok(true)),
            ("a???b", "a☺b", Ok(false)),
            ("a[^a][^a][^a]b", "a☺b", Ok(false)),
            ("[a-ζ]*", "α", Ok(true)),
            ("*[a-ζ]", "A", Ok(false)),
            ("a?b", "a/b", Ok(false)),
            ("a*b", "a/b", Ok(false)),
            ("[\\]a]", "]", Ok(true)),
            ("[\\-]", "-", Ok(true)),
            ("[x\\-]", "x", Ok(true)),
            ("[x\\-]", "-", Ok(true)),
            ("[x\\-]", "z", Ok(false)),
            ("[\\-x]", "x", Ok(true)),
            ("[\\-x]", "-", Ok(true)),
            ("[\\-x]", "a", Ok(false)),
            ("[]a]", "]", Err(BadPattern)),
            ("[-]", "-", Err(BadPattern)),
            ("[x-]", "x", Err(BadPattern)),
            ("[x-]", "-", Err(BadPattern)),
            ("[x-]", "z", Err(BadPattern)),
            ("[-x]", "x", Err(BadPattern)),
            ("[-x]", "-", Err(BadPattern)),
            ("[-x]", "a", Err(BadPattern)),
            ("\\", "a", Err(BadPattern)),
            ("[a-b-c]", "a", Err(BadPattern)),
            ("[", "a", Err(BadPattern)),
            ("[^", "a", Err(BadPattern)),
            ("[^bc", "a", Err(BadPattern)),
            ("a[", "a", Err(BadPattern)),
            ("a[", "ab", Err(BadPattern)),
            ("a[", "x", Err(BadPattern)),
            ("a/b[", "x", Err(BadPattern)),
            ("*x", "xxx", Ok(true)),
            ("/healthz", "/healthz", Ok(true)),
            ("/debug/*", "/debug/vars", Ok(true)),
            ("/debug/*", "/debug/pprof/heap", Ok(false)),
            ("/api/*/health", "/api/v1/health", Ok(true)),
        ];

        for &(pattern, name, want) in cases {
            assert_eq!(
                match_checked(pattern, name),
                want,
                "pattern={pattern:?}, name={name:?}"
            );
            assert_eq!(
                path_match(pattern, name),
                matches!(want, Ok(true)),
                "path_match({pattern:?}, {name:?})"
            );
        }
    }
}
