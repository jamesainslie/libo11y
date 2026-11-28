// Package sourcemap parses version 3 source maps and resolves generated
// positions to original ones. It holds only what lookups need: the
// sources, the names and the decoded mappings, never sourcesContent.
package sourcemap

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"strings"
)

// Position is an original source position.
type Position struct {
	Source string
	Line   int // 1-based
	Column int // 1-based
	Name   string
}

// Limits bounds the memory one parsed map may take.
type Limits struct {
	// MaxSegments caps the mapping segments plus the generated lines.
	// Default 5000000 when zero.
	MaxSegments int
}

const defaultMaxSegments = 5_000_000

var (
	// ErrIndexMap refuses an index map, which has sections instead of
	// mappings.
	ErrIndexMap = errors.New("sourcemap: index maps with sections are not supported")
	// ErrTooLarge refuses a map with more segments and lines than the
	// limit.
	ErrTooLarge = errors.New("sourcemap: too many mappings")
	// ErrInvalid refuses anything that is not a well-formed version 3 map.
	ErrInvalid = errors.New("sourcemap: invalid source map")
)

// segment is one decoded mapping, with every index made absolute.
type segment struct {
	genCol  int32
	src     int32 // -1 when the segment maps to no source
	srcLine int32
	srcCol  int32
	name    int32 // -1 when absent
}

// segmentBytes and lineBytes are what one segment and one generated line
// take in memory, for Size.
const (
	segmentBytes = 20
	lineBytes    = 4
)

// Map is a parsed source map. It is safe for concurrent lookups.
type Map struct {
	sources []string
	names   []string
	// segs holds every segment, line after line, each line sorted by
	// generated column. Line i is segs[lines[i]:lines[i+1]], and lines has
	// one more entry than there are generated lines.
	segs  []segment
	lines []int32
	size  int64
}

type rawMap struct {
	Version    int             `json:"version"`
	SourceRoot string          `json:"sourceRoot"`
	Sources    []string        `json:"sources"`
	Names      []string        `json:"names"`
	Mappings   string          `json:"mappings"`
	Sections   json.RawMessage `json:"sections"`
}

// Parse decodes a version 3 source map. A leading ")]}'" line, which some
// servers add against cross-site script inclusion, is ignored.
func Parse(data []byte, lim Limits) (*Map, error) {
	if lim.MaxSegments <= 0 {
		lim.MaxSegments = defaultMaxSegments
	}
	data = bytes.TrimPrefix(data, []byte(")]}'"))
	var raw rawMap
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if raw.Sections != nil {
		return nil, ErrIndexMap
	}
	if raw.Version != 3 {
		return nil, fmt.Errorf("%w: version %d", ErrInvalid, raw.Version)
	}
	m := &Map{sources: make([]string, len(raw.Sources)), names: raw.Names}
	if err := m.decodeMappings(raw.Mappings, lim.MaxSegments); err != nil {
		return nil, err
	}
	// Growth leaves spare capacity that Size would not count.
	m.segs = slices.Clip(m.segs)
	m.lines = slices.Clip(m.lines)
	for i, s := range raw.Sources {
		m.sources[i] = joinRoot(raw.SourceRoot, s)
	}
	m.size = int64(len(m.segs))*segmentBytes + int64(len(m.lines))*lineBytes
	for _, s := range m.sources {
		m.size += int64(len(s))
	}
	for _, s := range m.names {
		m.size += int64(len(s))
	}
	return m, nil
}

// joinRoot prefixes a relative source with the map's sourceRoot.
func joinRoot(root, src string) string {
	if root == "" || strings.Contains(src, "://") || strings.HasPrefix(src, "/") {
		return src
	}
	if strings.HasSuffix(root, "/") {
		return root + src
	}
	return root + "/" + src
}

// b64 maps a base64 digit to its value, or -1.
var b64 = func() (t [256]int8) {
	for i := range t {
		t[i] = -1
	}
	for i, c := range "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/" {
		t[c] = int8(i)
	}
	return t
}()

// decodeMappings decodes the mappings string into m.segs and m.lines.
func (m *Map) decodeMappings(s string, maxSegments int) error {
	m.lines = append(m.lines, 0)
	var genCol, src, srcLine, srcCol, name int64
	units := 0 // segments plus line breaks, against maxSegments
	lineStart := 0
	endLine := func() {
		sortLine(m.segs[lineStart:])
		lineStart = len(m.segs)
		m.lines = append(m.lines, int32(lineStart))
	}
	for i := 0; i < len(s); {
		switch s[i] {
		case ';':
			if units++; units > maxSegments {
				return ErrTooLarge
			}
			endLine()
			genCol = 0
			i++
			continue
		case ',':
			i++
			continue
		}
		var f [5]int64
		n := 0
		for i < len(s) && s[i] != ',' && s[i] != ';' {
			if n == len(f) {
				return fmt.Errorf("%w: segment with more than 5 fields", ErrInvalid)
			}
			v, next, err := vlq(s, i)
			if err != nil {
				return err
			}
			f[n], i = v, next
			n++
		}
		if n != 1 && n != 4 && n != 5 {
			return fmt.Errorf("%w: segment with %d fields", ErrInvalid, n)
		}
		genCol += f[0]
		if genCol < 0 || genCol > math.MaxInt32 {
			return fmt.Errorf("%w: generated column out of range", ErrInvalid)
		}
		seg := segment{genCol: int32(genCol), src: -1, name: -1}
		if n >= 4 {
			src += f[1]
			srcLine += f[2]
			srcCol += f[3]
			if src < 0 || src >= int64(len(m.sources)) || srcLine < 0 || srcCol < 0 ||
				srcLine > math.MaxInt32-1 || srcCol > math.MaxInt32-1 {
				return fmt.Errorf("%w: source position out of range", ErrInvalid)
			}
			seg.src, seg.srcLine, seg.srcCol = int32(src), int32(srcLine), int32(srcCol)
		}
		if n == 5 {
			name += f[4]
			if name < 0 || name >= int64(len(m.names)) {
				return fmt.Errorf("%w: name index out of range", ErrInvalid)
			}
			seg.name = int32(name)
		}
		if units++; units > maxSegments {
			return ErrTooLarge
		}
		m.segs = append(m.segs, seg)
	}
	endLine()
	return nil
}

// vlq decodes one base64 VLQ value starting at s[i] and returns it and
// the index after it. Values beyond 31 bits are refused.
func vlq(s string, i int) (int64, int, error) {
	var result int64
	var shift uint
	for {
		if i >= len(s) {
			return 0, i, fmt.Errorf("%w: truncated VLQ", ErrInvalid)
		}
		d := b64[s[i]]
		if d < 0 {
			return 0, i, fmt.Errorf("%w: bad base64 %q", ErrInvalid, s[i])
		}
		i++
		result |= int64(d&31) << shift
		if d&32 == 0 {
			break
		}
		shift += 5
		if shift > 30 {
			return 0, i, fmt.Errorf("%w: VLQ too long", ErrInvalid)
		}
	}
	if result&1 == 1 {
		return -(result >> 1), i, nil
	}
	return result >> 1, i, nil
}

func byGenCol(a, b segment) int { return cmp.Compare(a.genCol, b.genCol) }

// sortLine orders one line's segments by generated column. Bundlers emit
// them in order, so the check usually avoids the sort.
func sortLine(segs []segment) {
	if !slices.IsSortedFunc(segs, byGenCol) {
		slices.SortStableFunc(segs, byGenCol)
	}
}

// Lookup resolves a 1-based generated position, as stack traces report
// it, to the original position of the closest segment at or before it on
// the same line. It reports false when the line has no such segment or
// the segment maps to no source.
func (m *Map) Lookup(line, column int) (Position, bool) {
	l, c := line-1, column-1
	if l < 0 || l >= len(m.lines)-1 || c < 0 || c > math.MaxInt32 {
		return Position{}, false
	}
	segs := m.segs[m.lines[l]:m.lines[l+1]]
	i := sort.Search(len(segs), func(i int) bool { return segs[i].genCol > int32(c) }) - 1
	if i < 0 || segs[i].src < 0 {
		return Position{}, false
	}
	s := segs[i]
	p := Position{Source: m.sources[s.src], Line: int(s.srcLine) + 1, Column: int(s.srcCol) + 1}
	if s.name >= 0 {
		p.Name = m.names[s.name]
	}
	return p, true
}

// Size is the approximate memory the map holds, in bytes, for cache
// accounting.
func (m *Map) Size() int64 { return m.size }
