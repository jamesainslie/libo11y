package o11yrum

// Session replay masking, URL and CSS stripping and the attribute lists.
// These mirror ts/packages/rum-replay/src/mask.ts, urls.ts, css.ts and
// policy.ts rule for rule, so the gateway and the collector make the same
// decision on every input; the shared vectors in conformance/rum-replay
// hold both to it. Where JavaScript and Go disagree on a primitive (string
// indexing, white space, case folding), the code below follows
// JavaScript:
//
//   - The rules only ever look at ASCII characters, so indexing UTF-8
//     bytes gives the same splits as indexing UTF-16 code units.
//   - White space for trim and \s is ECMAScript's (jsSpace), not
//     unicode.IsSpace: U+FEFF counts and U+0085 does not.
//   - Case-insensitive matches fold ASCII letters only, as a JavaScript
//     regular expression without the u flag does.

import (
	"strings"
	"unicode/utf8"
)

// maskText replaces every code point of s except ASCII space, tab, line
// feed, carriage return, form feed and vertical tab with "*", so layout
// survives and content does not. NBSP, NEL, the BOM and every other
// Unicode space are masked.
func maskText(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case ' ', '\t', '\n', '\r', '\f', '\v':
			b.WriteRune(r)
		default:
			b.WriteByte('*')
		}
	}
	return b.String()
}

// maskedAttributes carry text: masked unless the element's text is
// allowed.
var maskedAttributes = stringSet(
	"title", "alt", "placeholder", "label", "content", "summary", "abbr",
	"aria-label", "aria-description", "aria-placeholder", "aria-roledescription",
	"aria-valuetext", "aria-braillelabel", "aria-brailleroledescription",
)

// urlAttributes hold a URL, kept after stripURL (srcset after
// stripSrcset).
var urlAttributes = stringSet("href", "src", "srcset", "xlink:href", "poster")

// cssAttributes hold CSS, which may hold url(), kept after stripCSSURLs.
var cssAttributes = stringSet(
	"style", "fill", "stroke", "clip-path", "mask", "filter",
	"marker-start", "marker-mid", "marker-end",
)

// keptAttributes are kept unchanged. Every attribute on none of the four
// lists is removed: value, checked, selected, every on* handler, every
// data-* attribute but libo11y's markers, srcdoc, contenteditable and
// rrweb's rr_dataURL and rr_src among them.
var keptAttributes = map[string]bool{
	// structure, layout and state that is not user input
	"id":          true,
	"class":       true,
	"type":        true,
	"role":        true,
	"rel":         true,
	"media":       true,
	"sizes":       true,
	"width":       true,
	"height":      true,
	"hidden":      true,
	"disabled":    true,
	"readonly":    true,
	"required":    true,
	"multiple":    true,
	"dir":         true,
	"lang":        true,
	"colspan":     true,
	"rowspan":     true,
	"span":        true,
	"scope":       true,
	"tabindex":    true,
	"open":        true,
	"draggable":   true,
	"crossorigin": true,
	"as":          true,
	"charset":     true,
	"name":        true,
	"http-equiv":  true,
	"for":         true,
	"start":       true,
	"reversed":    true,
	"controls":    true,
	"loop":        true,
	"muted":       true,
	"playsinline": true,
	"size":        true,
	"cols":        true,
	"rows":        true,
	// ARIA state and relations, never ARIA text
	"aria-hidden":      true,
	"aria-expanded":    true,
	"aria-current":     true,
	"aria-disabled":    true,
	"aria-busy":        true,
	"aria-pressed":     true,
	"aria-haspopup":    true,
	"aria-live":        true,
	"aria-modal":       true,
	"aria-invalid":     true,
	"aria-required":    true,
	"aria-readonly":    true,
	"aria-level":       true,
	"aria-orientation": true,
	"aria-sort":        true,
	"aria-controls":    true,
	"aria-labelledby":  true,
	"aria-describedby": true,
	"aria-owns":        true,
	// libo11y's markers
	"data-o11y":        true,
	"data-o11y-mask":   true,
	"data-o11y-unmask": true,
	"data-o11y-block":  true,
	// SVG geometry and presentation
	"xmlns":               true,
	"xmlns:xlink":         true,
	"version":             true,
	"viewbox":             true,
	"preserveaspectratio": true,
	"d":                   true,
	"fill-rule":           true,
	"fill-opacity":        true,
	"clip-rule":           true,
	"stroke-width":        true,
	"stroke-linecap":      true,
	"stroke-linejoin":     true,
	"stroke-dasharray":    true,
	"stroke-dashoffset":   true,
	"stroke-miterlimit":   true,
	"stroke-opacity":      true,
	"opacity":             true,
	"transform":           true,
	"x":                   true,
	"y":                   true,
	"x1":                  true,
	"y1":                  true,
	"x2":                  true,
	"y2":                  true,
	"dx":                  true,
	"dy":                  true,
	"cx":                  true,
	"cy":                  true,
	"r":                   true,
	"rx":                  true,
	"ry":                  true,
	"fx":                  true,
	"fy":                  true,
	"points":              true,
	"offset":              true,
	"stop-color":          true,
	"stop-opacity":        true,
	"gradientunits":       true,
	"gradienttransform":   true,
	"patternunits":        true,
	"clippathunits":       true,
	"maskunits":           true,
	"text-anchor":         true,
	"dominant-baseline":   true,
	"font-size":           true,
	"font-weight":         true,
	"visibility":          true,
	"display":             true,
	"vector-effect":       true,
	"shape-rendering":     true,
	// rrweb's own serialization (rr_dataURL is canvas or image pixels and rr_src a hidden iframe URL: never kept)
	"rr_width":             true,
	"rr_height":            true,
	"rr_scrollleft":        true,
	"rr_scrolltop":         true,
	"rr_mediastate":        true,
	"rr_mediacurrenttime":  true,
	"rr_mediaplaybackrate": true,
	"rr_mediamuted":        true,
	"rr_medialoop":         true,
	"rr_mediavolume":       true,
	"rr_open_mode":         true,
}

func stringSet(keys ...string) map[string]bool {
	m := make(map[string]bool, len(keys))
	for _, k := range keys {
		m[k] = true
	}
	return m
}

// asciiLower lowercases ASCII letters only, as the collector's lower()
// does. strings.ToLower would also fold U+212A KELVIN SIGN to "k".
func asciiLower(s string) string {
	for i := range len(s) {
		if c := s[i]; c >= 'A' && c <= 'Z' {
			b := []byte(s)
			for j := i; j < len(b); j++ {
				if b[j] >= 'A' && b[j] <= 'Z' {
					b[j] += 'a' - 'A'
				}
			}
			return string(b)
		}
	}
	return s
}

// jsSpace reports whether r is white space or a line terminator to
// ECMAScript, as String.prototype.trim and \s see it.
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, jsSpace) }

// isURLSpace is ASCII white space as HTML and CSS define it.
func isURLSpace(c byte) bool {
	return c == '\t' || c == '\n' || c == '\f' || c == '\r' || c == ' '
}

// cleanURL reads raw as a browser does: tab, line feed and carriage
// return removed, and C0 controls and spaces trimmed from both ends.
func cleanURL(raw string) string {
	s := raw
	if strings.ContainsAny(s, "\t\n\r") {
		s = strings.Map(func(r rune) rune {
			if r == '\t' || r == '\n' || r == '\r' {
				return -1
			}
			return r
		}, s)
	}
	start, end := 0, len(s)
	for start < end && s[start] <= 0x20 {
		start++
	}
	for end > start && s[end-1] <= 0x20 {
		end--
	}
	return s[start:end]
}

// isIDReference reports whether s is an in-document reference such as
// "#icon-cart" or "#:r1:": "#", a letter, "_" or ":", then at most 63
// letters, digits, "_", ":" or "-".
func isIDReference(s string) bool {
	if len(s) < 2 || len(s) > 65 || s[0] != '#' {
		return false
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		letter := c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c == '_' || c == ':'
		if !letter && (i == 1 || !(c >= '0' && c <= '9' || c == '-')) {
			return false
		}
	}
	return true
}

// urlScheme returns the scheme of url and the length of "scheme:", or
// false when url does not start with one.
func urlScheme(url string) (string, int, bool) {
	if url == "" || !isASCIILetter(url[0]) {
		return "", 0, false
	}
	for i := 1; i < len(url); i++ {
		c := url[i]
		switch {
		case c == ':':
			return url[:i], i + 1, true
		case isASCIILetter(c) || c >= '0' && c <= '9' || c == '+' || c == '.' || c == '-':
		default:
			return "", 0, false
		}
	}
	return "", 0, false
}

func isASCIILetter(c byte) bool { return c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' }

// validHost reports whether host is a host with an optional numeric
// port: a bracketed IPv6 literal, or a name without ":", "[" or "]".
func validHost(host string) bool {
	name := host
	if strings.HasPrefix(host, "[") {
		end := strings.IndexByte(host, ']')
		if end < 2 {
			return false
		}
		for i := 1; i < end; i++ {
			c := host[i]
			if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' || c == ':' || c == '.') {
				return false
			}
		}
		name = ""
		host = host[end+1:]
	} else {
		colon := strings.IndexByte(host, ':')
		if colon >= 0 {
			name, host = host[:colon], host[colon:]
		} else {
			name, host = host, ""
		}
		if name == "" || strings.ContainsAny(name, "[]") {
			return false
		}
	}
	if host == "" {
		return true
	}
	if host[0] != ':' {
		return false
	}
	for i := 1; i < len(host); i++ {
		if host[i] < '0' || host[i] > '9' {
			return false
		}
	}
	return true
}

// splitAuthority returns the host of rest (which starts right after the
// slashes) without userinfo, false when it is not a valid host, and what
// follows the authority.
func splitAuthority(rest string) (host string, tail string, ok bool) {
	authority := rest
	if end := strings.IndexAny(rest, `/\?#`); end >= 0 {
		authority, tail = rest[:end], rest[end:]
	}
	host = authority
	if at := strings.LastIndexByte(authority, '@'); at >= 0 {
		host = authority[at+1:]
	}
	return host, tail, validHost(host)
}

// pathAndQuery returns the path of tail (up to "?" or "#", and before any
// ";") followed by the allowed part of its query.
func pathAndQuery(tail string, allow map[string]bool) string {
	pathEnd := strings.IndexAny(tail, "?#")
	full := tail
	if pathEnd >= 0 {
		full = tail[:pathEnd]
	}
	p, _, _ := strings.Cut(full, ";")
	if pathEnd < 0 || tail[pathEnd] != '?' {
		return p
	}
	query, _, _ := strings.Cut(tail[pathEnd+1:], "#")
	var kept []string
	start := 0
	for i := 0; i <= len(query); i++ {
		if i < len(query) && query[i] != '&' && query[i] != ';' {
			continue
		}
		piece := query[start:i]
		start = i + 1
		name, _, _ := strings.Cut(piece, "=")
		if allow[name] {
			kept = append(kept, piece)
		}
	}
	if len(kept) == 0 {
		return p
	}
	return p + "?" + strings.Join(kept, "&")
}

// stripURL returns raw with userinfo and the fragment removed and the
// query reduced to the parameters on allow, by the textual rules of the
// collector's stripUrl: no URL parser normalization. A scheme other than
// http or https, or an authority that is not a host with an optional
// numeric port, gives "". The path ends at its first ";". An in-document
// reference ("#icon") is kept whole. Relative URLs stay relative.
func stripURL(raw string, allow map[string]bool) string {
	url := cleanURL(raw)
	if isIDReference(url) {
		return url
	}
	if scheme, n, ok := urlScheme(url); ok {
		name := asciiLower(scheme)
		if name != "http" && name != "https" {
			return ""
		}
		rest := strings.TrimLeft(url[n:], `/\`)
		host, tail, ok := splitAuthority(rest)
		if !ok {
			return ""
		}
		return name + "://" + host + pathAndQuery(tail, allow)
	}
	if len(url) >= 2 && (url[0] == '/' || url[0] == '\\') && (url[1] == '/' || url[1] == '\\') {
		host, tail, ok := splitAuthority(url[2:])
		if !ok {
			return ""
		}
		return "//" + host + pathAndQuery(tail, allow)
	}
	return pathAndQuery(url, allow)
}

// isDescriptor reports whether d is a srcset descriptor: a width (320w),
// a pixel density (1.5x, 1e2x) or a height (200h).
func isDescriptor(d string) bool {
	if len(d) < 2 {
		return false
	}
	body, unit := d[:len(d)-1], d[len(d)-1]
	switch unit {
	case 'w', 'h':
		return allDigits(body)
	case 'x':
		mant, exp := body, ""
		if i := strings.IndexAny(body, "eE"); i >= 0 {
			mant, exp = body[:i], body[i+1:]
			if exp != "" && (exp[0] == '+' || exp[0] == '-') {
				exp = exp[1:]
			}
			if !allDigits(exp) {
				return false
			}
		}
		whole, frac, dot := strings.Cut(mant, ".")
		if !dot {
			return allDigits(whole)
		}
		// \d+\.?\d* or \.\d+
		return allDigits(whole) && (frac == "" || allDigits(frac)) || whole == "" && allDigits(frac)
	}
	return false
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// stripSrcset strips each candidate of a srcset value with stripURL and
// keeps only valid descriptors. The value is split as the HTML parser
// splits it: a URL runs to white space, so the commas of a data URL stay
// inside it. A candidate whose URL strips to "" is dropped.
func stripSrcset(raw string, allow map[string]bool) string {
	var out []string
	i := 0
	for i < len(raw) {
		for i < len(raw) && (isURLSpace(raw[i]) || raw[i] == ',') {
			i++
		}
		if i >= len(raw) {
			break
		}
		start := i
		for i < len(raw) && !isURLSpace(raw[i]) {
			i++
		}
		url := raw[start:i]
		descriptors := ""
		if strings.HasSuffix(url, ",") {
			url = strings.TrimRight(url, ",")
		} else {
			start, depth := i, 0
			for i < len(raw) {
				c := raw[i]
				if c == ',' && depth == 0 {
					break
				}
				if c == '(' {
					depth++
				} else if c == ')' && depth > 0 {
					depth--
				}
				i++
			}
			descriptors = raw[start:i]
		}
		stripped := stripURL(url, allow)
		if stripped == "" {
			continue
		}
		var kept []string
		for _, d := range strings.FieldsFunc(descriptors, func(r rune) bool { return r < utf8.RuneSelf && isURLSpace(byte(r)) }) {
			if isDescriptor(d) {
				kept = append(kept, d)
			}
		}
		if len(kept) > 0 {
			stripped += " " + strings.Join(kept, " ")
		}
		out = append(out, stripped)
	}
	return strings.Join(out, ", ")
}

// CSS URL stripping: style attributes, inlined stylesheets and CSSOM
// rule edits. A small scanner, following CSS Syntax closely enough that
// escapes cannot hide a URL from it, exactly as the collector's
// stripCssUrls:
//
//   - Comments are removed, since a URL in a comment is still data.
//   - A url() token, whatever its case and escapes (URL(, \75 rl(), has
//     its argument decoded, stripped by stripURL and written back as
//     url("...").
//   - A quoted string is decoded. It is taken as a URL when it follows
//     @import, starts (once tab, LF and CR are removed) with a URL scheme,
//     holds "?" or "#", or starts with "/" and holds no white space. A URL
//     string is stripped by stripURL and written back in double quotes.
//     Any other string is kept exactly as written.
//   - Everything else is copied unchanged.

// cssAt returns css[i], or 0 past the end. The scanner never treats NUL
// specially, so 0 is a safe stand-in for "no character".
func cssAt(css string, i int) byte {
	if i < 0 || i >= len(css) {
		return 0
	}
	return css[i]
}

func isHex(c byte) bool { return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' }

func isCSSSpace(c byte) bool { return isURLSpace(c) }

// cssCodePoint is the code point of a hex escape: U+FFFD for zero, a
// surrogate or one past U+10FFFF.
func cssCodePoint(hex string) string {
	n := 0
	for i := range len(hex) {
		c := hex[i]
		switch {
		case c >= '0' && c <= '9':
			n = n*16 + int(c-'0')
		case c >= 'a' && c <= 'f':
			n = n*16 + int(c-'a') + 10
		default:
			n = n*16 + int(c-'A') + 10
		}
	}
	if n == 0 || n >= 0xd800 && n <= 0xdfff || n > 0x10ffff {
		return "�"
	}
	return string(rune(n))
}

// readCSSEscape decodes the escape whose backslash is at css[i]. It
// returns the text and the index after it.
func readCSSEscape(css string, i int) (string, int) {
	j := i + 1
	if j >= len(css) {
		return "�", j
	}
	if isHex(css[j]) {
		start := j
		for j < len(css) && j-start < 6 && isHex(css[j]) {
			j++
		}
		hex := css[start:j]
		if cssAt(css, j) == '\r' && cssAt(css, j+1) == '\n' {
			j += 2
		} else if isCSSSpace(cssAt(css, j)) {
			j++
		}
		return cssCodePoint(hex), j
	}
	_, size := utf8.DecodeRuneInString(css[j:])
	return css[j : j+size], j + size
}

// isCSSEscape reports whether css[i] starts a valid escape: a backslash
// not followed by a newline.
func isCSSEscape(css string, i int) bool {
	if cssAt(css, i) != '\\' {
		return false
	}
	next := cssAt(css, i+1)
	return next != '\n' && next != '\r' && next != '\f'
}

func isCSSNameChar(c byte) bool {
	return isASCIILetter(c) || c >= '0' && c <= '9' || c == '_' || c == '-' || c >= 0x80
}

// readCSSString reads the string whose quote is at css[i]. It returns the
// decoded value and the index after it.
func readCSSString(css string, i int) (string, int) {
	quote := css[i]
	var value strings.Builder
	j := i + 1
	for j < len(css) {
		c := css[j]
		switch {
		case c == quote:
			return value.String(), j + 1
		case c == '\n':
			return value.String(), j
		case c == '\\':
			switch next := cssAt(css, j+1); {
			case j+1 >= len(css):
				j++
			case next == '\n' || next == '\f':
				j += 2
			case next == '\r':
				if cssAt(css, j+2) == '\n' {
					j += 3
				} else {
					j += 2
				}
			default:
				text, n := readCSSEscape(css, j)
				value.WriteString(text)
				j = n
			}
		default:
			value.WriteByte(c)
			j++
		}
	}
	return value.String(), j
}

// readCSSURLArgument reads the argument of url( starting at css[i], right
// after the parenthesis, through the closing one.
func readCSSURLArgument(css string, i int) (string, int) {
	j := i
	for j < len(css) && isCSSSpace(css[j]) {
		j++
	}
	var value string
	if c := cssAt(css, j); c == '"' || c == '\'' {
		value, j = readCSSString(css, j)
	} else {
		var b strings.Builder
		for j < len(css) && css[j] != ')' && !isCSSSpace(css[j]) {
			if css[j] == '\\' {
				text, n := readCSSEscape(css, j)
				b.WriteString(text)
				j = n
			} else {
				b.WriteByte(css[j])
				j++
			}
		}
		value = b.String()
	}
	// Whatever stands between the argument and ")" is not part of a valid
	// url() and is dropped.
	for j < len(css) && css[j] != ')' {
		j++
	}
	return value, min(j+1, len(css))
}

// cssQuote writes s as a double-quoted CSS string.
func cssQuote(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r < 0x20 || r == 0x7f:
			b.WriteByte('\\')
			b.WriteString(strconvHex(int(r)))
			b.WriteByte(' ')
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

// strconvHex is n in lowercase hexadecimal, as Number.prototype.toString(16)
// writes it.
func strconvHex(n int) string {
	const digits = "0123456789abcdef"
	if n < 16 {
		return digits[n : n+1]
	}
	return digits[n>>4:n>>4+1] + digits[n&15:n&15+1]
}

// cssURLScheme reports whether t starts with one of the schemes that make
// a quoted CSS string a URL even when it holds white space, ASCII case
// folded.
func cssURLScheme(t string) bool {
	scheme, _, ok := urlScheme(t)
	if !ok {
		return false
	}
	switch asciiLower(scheme) {
	case "http", "https", "data", "blob", "javascript", "file", "ftp", "ws", "wss", "mailto", "tel":
		return true
	}
	return false
}

// readsAsURL reports whether a decoded CSS string is a URL.
func readsAsURL(value string) bool {
	t := jsTrim(strings.NewReplacer("\t", "", "\n", "", "\r", "").Replace(value))
	if cssURLScheme(t) || strings.ContainsAny(t, "?#") {
		return true
	}
	return !strings.ContainsFunc(t, jsSpace) && strings.HasPrefix(t, "/")
}

// followsImport reports whether out ends with "@import" and optional
// white space, ASCII case folded.
func followsImport(out string) bool {
	t := strings.TrimRightFunc(out, jsSpace)
	const kw = "@import"
	return len(t) >= len(kw) && asciiLower(t[len(t)-len(kw):]) == kw
}

// stripCSSURLs returns css with every URL stripped by stripURL and its
// comments removed.
func stripCSSURLs(css string, allow map[string]bool) string {
	var out strings.Builder
	out.Grow(len(css))
	i := 0
	for i < len(css) {
		c := css[i]
		if c == '/' && cssAt(css, i+1) == '*' {
			end := strings.Index(css[i+2:], "*/")
			if end < 0 {
				i = len(css)
			} else {
				i += 2 + end + 2
			}
			continue
		}
		if c == '"' || c == '\'' {
			value, next := readCSSString(css, i)
			if followsImport(out.String()) || readsAsURL(value) {
				out.WriteString(cssQuote(stripURL(value, allow)))
			} else {
				out.WriteString(css[i:next])
			}
			i = next
			continue
		}
		if isCSSNameChar(c) || isCSSEscape(css, i) {
			j := i
			var name strings.Builder
			for j < len(css) {
				if isCSSEscape(css, j) {
					text, n := readCSSEscape(css, j)
					name.WriteString(text)
					j = n
				} else if isCSSNameChar(css[j]) {
					name.WriteByte(css[j])
					j++
				} else {
					break
				}
			}
			if cssAt(css, j) == '(' && asciiLower(name.String()) == "url" {
				value, next := readCSSURLArgument(css, j+1)
				out.WriteString("url(")
				out.WriteString(cssQuote(stripURL(value, allow)))
				out.WriteString(")")
				i = next
				continue
			}
			out.WriteString(css[i:j])
			i = j
			continue
		}
		out.WriteByte(c)
		i++
	}
	return out.String()
}
