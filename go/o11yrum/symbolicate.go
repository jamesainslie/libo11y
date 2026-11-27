package o11yrum

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	"golang.org/x/sync/singleflight"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/sourcemap"
	"github.com/jamesainslie/libo11y/go/o11yrum/internal/stacktrace"
)

// SymbolicationConfig bounds the source map cache and the work done per
// stack.
type SymbolicationConfig struct {
	// CacheMaps caps the parsed maps held in memory. Default 64.
	CacheMaps int `yaml:"cache_maps"`
	// CacheBytes caps the memory parsed maps may hold. Default 268435456
	// (256 MiB). A map larger than this is used but not kept.
	CacheBytes int64 `yaml:"cache_bytes"`
	// NegativeTTL is how long a map found missing, invalid or unreadable
	// is not looked up again. Default 60s. A new upload of the map ends
	// the wait at once.
	NegativeTTL time.Duration `yaml:"negative_ttl"`
	// MaxFrames caps the frames of one stack that are symbolicated and
	// kept. Default 50.
	MaxFrames int `yaml:"max_frames"`
}

func (c *SymbolicationConfig) applyDefaults() {
	setDefault(&c.CacheMaps, 64)
	setDefault(&c.CacheBytes, 256<<20)
	if c.NegativeTTL == 0 {
		c.NegativeTTL = time.Minute
	}
	setDefault(&c.MaxFrames, 50)
}

func (c SymbolicationConfig) validate() error {
	switch {
	case c.CacheMaps <= 0:
		return errors.New("symbolication.cache_maps must be positive")
	case c.CacheBytes <= 0:
		return errors.New("symbolication.cache_bytes must be positive")
	case c.NegativeTTL < 0:
		return errors.New("symbolication.negative_ttl must not be negative")
	case c.MaxFrames <= 0:
		return errors.New("symbolication.max_frames must be positive")
	}
	return nil
}

// Exception attributes and the span event that carries them.
const (
	keyExcType       = "exception.type"
	keyExcMessage    = "exception.message"
	keyExcStacktrace = "exception.stacktrace"
	keyServiceVer    = "service.version"
	eventException   = "exception"
)

// Frame results recorded in o11yrum.symbolication.frames.
const (
	frameHit      = "hit"      // resolved through a map
	frameUnmapped = "unmapped" // the map has no mapping at the position
	frameMiss     = "miss"     // no map for the script
	frameError    = "error"    // the map could not be read or parsed
	frameSkipped  = "skipped"  // no usable version, no position, or over the per-stack map budget
)

// maxMapsPerStack bounds the distinct maps one stack may load, so a stack
// naming many scripts cannot turn one record into many store reads.
const maxMapsPerStack = 8

// storeReadTimeout bounds one object store read on the ingest path.
const storeReadTimeout = 5 * time.Second

// symbolicator resolves minified stack frames through uploaded source
// maps and fingerprints errors. A nil symbolicator does nothing.
type symbolicator struct {
	cache       *mapCache
	tel         *telemetry
	maxFrames   int
	maxValueLen int
}

// newSymbolicator reads maps from store. maxValueLen caps a rewritten
// stack, as the attribute policy caps every string value. tel may be nil.
func newSymbolicator(store ObjectStore, cfg SymbolicationConfig, maxValueLen int, tel *telemetry, now func() time.Time) *symbolicator {
	if tel == nil {
		tel = newTelemetry(nil, nil)
	}
	return &symbolicator{
		cache:       newMapCache(store, cfg, now),
		tel:         tel,
		maxFrames:   cfg.MaxFrames,
		maxValueLen: maxValueLen,
	}
}

// invalidate forgets what the cache holds for key, so a new upload is
// read on the next lookup.
func (s *symbolicator) invalidate(key string) {
	if s == nil {
		return
	}
	s.cache.invalidate(key)
}

// release is the version and update a batch's stacks come from.
type release struct {
	namespace string
	version   string
	updateID  string
}

// releaseOf reads service.version and o11y.rum.app.update_id from a
// resource.
func releaseOf(namespace string, res pcommon.Resource) release {
	return release{
		namespace: namespace,
		version:   strAttr(res.Attributes(), keyServiceVer),
		updateID:  strAttr(res.Attributes(), keyUpdateID),
	}
}

// withRecord lets a record's own update ID win over the resource's.
func (r release) withRecord(attrs pcommon.Map) release {
	if id := strAttr(attrs, keyUpdateID); id != "" {
		r.updateID = id
	}
	return r
}

func strAttr(m pcommon.Map, k string) string {
	if v, ok := m.Get(k); ok && v.Type() == pcommon.ValueTypeStr {
		return v.Str()
	}
	return ""
}

// logs symbolicates and fingerprints the o11y.rum.error records of a
// batch, and any other record carrying exception.stacktrace. app labels
// self-telemetry; namespace locates the maps.
func (s *symbolicator) logs(ctx context.Context, app, namespace string, ld plog.Logs) {
	if s == nil {
		return
	}
	tally := frameTally{}
	for i := range ld.ResourceLogs().Len() {
		rl := ld.ResourceLogs().At(i)
		rel := releaseOf(namespace, rl.Resource())
		for j := range rl.ScopeLogs().Len() {
			records := rl.ScopeLogs().At(j).LogRecords()
			for k := range records.Len() {
				lr := records.At(k)
				_, hasStack := lr.Attributes().Get(keyExcStacktrace)
				if hasStack || eventName(lr) == eventRUMError {
					s.resolve(ctx, rel.withRecord(lr.Attributes()), lr.Attributes(), tally)
				}
			}
		}
	}
	s.record(ctx, app, tally)
}

// traces symbolicates and fingerprints span events named exception.
func (s *symbolicator) traces(ctx context.Context, app, namespace string, td ptrace.Traces) {
	if s == nil {
		return
	}
	tally := frameTally{}
	for i := range td.ResourceSpans().Len() {
		rs := td.ResourceSpans().At(i)
		rel := releaseOf(namespace, rs.Resource())
		for j := range rs.ScopeSpans().Len() {
			spans := rs.ScopeSpans().At(j).Spans()
			for k := range spans.Len() {
				span := spans.At(k)
				spanRel := rel.withRecord(span.Attributes())
				for e := range span.Events().Len() {
					ev := span.Events().At(e)
					if ev.Name() == eventException {
						s.resolve(ctx, spanRel.withRecord(ev.Attributes()), ev.Attributes(), tally)
					}
				}
			}
		}
	}
	s.record(ctx, app, tally)
}

// frameTally counts frame results across one batch.
type frameTally map[string]int64

func (s *symbolicator) record(ctx context.Context, app string, tally frameTally) {
	for result, n := range tally {
		s.tel.frames.Add(ctx, n, metric.WithAttributes(
			attribute.String(telApp, app), attribute.String(telResult, result)))
	}
}

// resolve symbolicates the exception.stacktrace in attrs, when there is
// one, and sets o11y.rum.error.fingerprint. The stack is rewritten only
// when at least one frame resolved, so an unresolved stack keeps its
// original shape.
func (s *symbolicator) resolve(ctx context.Context, rel release, attrs pcommon.Map, tally frameTally) {
	var frames []stacktrace.Frame
	if v, ok := attrs.Get(keyExcStacktrace); ok && v.Type() == pcommon.ValueTypeStr {
		tr := stacktrace.Parse(v.Str(), s.maxFrames)
		if s.symbolicate(ctx, rel, &tr, tally) {
			v.SetStr(truncateLines(tr.String(), s.maxValueLen))
		}
		frames = tr.Frames
	}
	attrs.PutStr(keyErrorFingerprint, fingerprint(strAttr(attrs, keyExcType), strAttr(attrs, keyExcMessage), frames))
}

// symbolicate resolves tr's frames in place and reports whether any
// resolved.
func (s *symbolicator) symbolicate(ctx context.Context, rel release, tr *stacktrace.Trace, tally frameTally) bool {
	if !validSegment(rel.version) || (rel.updateID != "" && !validSegment(rel.updateID)) || rel.namespace == "" {
		tally[frameSkipped] += int64(len(tr.Frames))
		return false
	}
	resolved := make([]bool, len(tr.Frames))
	names := make([]string, len(tr.Frames)) // the name mapped at each frame's own position
	loaded := map[string]bool{}
	anyResolved := false
	for i, f := range tr.Frames {
		if f.URL == "" || f.Line == 0 || f.Column == 0 {
			tally[frameSkipped]++
			continue
		}
		key := sourcemapKey(rel.namespace, rel.version, rel.updateID, normalizeScriptPath(f.URL))
		if !loaded[key] && len(loaded) == maxMapsPerStack {
			tally[frameSkipped]++
			continue
		}
		loaded[key] = true
		m, err := s.cache.get(ctx, key)
		switch {
		case err != nil:
			tally[frameError]++
			continue
		case m == nil:
			tally[frameMiss]++
			continue
		}
		pos, ok := m.Lookup(f.Line, f.Column)
		if !ok {
			tally[frameUnmapped]++
			continue
		}
		tr.Frames[i].URL, tr.Frames[i].Line, tr.Frames[i].Column = pos.Source, pos.Line, pos.Column
		names[i], resolved[i], anyResolved = pos.Name, true, true
		tally[frameHit]++
	}
	// The name mapped at a call site is the original name of the function
	// called there, so frame i takes the name found at its caller, frame
	// i+1.
	for i := 0; i+1 < len(tr.Frames); i++ {
		if resolved[i] && resolved[i+1] && names[i+1] != "" {
			tr.Frames[i].Function = names[i+1]
		}
	}
	return anyResolved
}

// truncateLines cuts s to at most n bytes at a line boundary, so a
// rewritten stack never ends in half a frame. A first line longer than n
// is cut at a character boundary.
func truncateLines(s string, n int) string {
	if n <= 0 || len(s) <= n {
		return s
	}
	if i := strings.LastIndexByte(s[:n+1], '\n'); i > 0 {
		return s[:i]
	}
	return truncateUTF8(s, n)
}

// digits matches runs of digits, which fingerprints fold so that
// "order 123 failed" and "order 456 failed" group together.
var digits = regexp.MustCompile(`[0-9]+`)

// fingerprintFrames is how many frames with a URL a fingerprint covers.
const fingerprintFrames = 5

// fingerprint is the error's grouping key: a hash of the exception type
// and the script path and function of its first five frames with a URL.
// Lines, columns and the message are left out, so an edit elsewhere in a
// file or a message carrying an ID does not split a group. A stack with
// no URL frames falls back to the message with digits folded.
func fingerprint(excType, message string, frames []stacktrace.Frame) string {
	h := sha256.New()
	_, _ = io.WriteString(h, "o11yrum-fp-v1\n"+excType+"\n")
	n := 0
	for _, f := range frames {
		if f.URL == "" {
			continue
		}
		fn := f.Function
		if fn == "" {
			fn = "?"
		}
		_, _ = io.WriteString(h, normalizeScriptPath(f.URL)+"\n"+fn+"\n")
		if n++; n == fingerprintFrames {
			break
		}
	}
	if n == 0 {
		_, _ = io.WriteString(h, truncateUTF8(digits.ReplaceAllString(message, "0"), 256))
	}
	return hex.EncodeToString(h.Sum(nil)[:16])
}

// maxNegativeEntries bounds the remembered missing maps. Script URLs come
// from clients, so without a bound a client could grow the set forever.
func maxNegativeEntries(cacheMaps int) int { return max(1024, 16*cacheMaps) }

// mapCache holds parsed maps in a least recently used list bounded by
// count and bytes, and remembers missing or broken maps for a while.
// Concurrent loads of one key share one store read.
type mapCache struct {
	store  ObjectStore
	now    func() time.Time
	ttl    time.Duration
	maxN   int
	maxB   int64
	maxNeg int

	mu      sync.Mutex
	lru     *list.List // of *cacheEntry, most recent first
	entries map[string]*list.Element
	bytes   int64
	missing map[string]negativeEntry
	negLRU  *list.List // of string keys, oldest last
	loads   singleflight.Group
	// gen counts invalidations, so a load that started before one does
	// not cache what it read.
	gen uint64
}

type cacheEntry struct {
	key  string
	m    *sourcemap.Map
	size int64
}

type negativeEntry struct {
	until  time.Time
	broken bool // unreadable or invalid, rather than missing
	elem   *list.Element
}

// errBrokenMap is returned for a key remembered as unreadable or invalid.
var errBrokenMap = errors.New("o11yrum: source map unreadable or invalid")

func newMapCache(store ObjectStore, cfg SymbolicationConfig, now func() time.Time) *mapCache {
	return &mapCache{
		store:   store,
		now:     now,
		ttl:     cfg.NegativeTTL,
		maxN:    cfg.CacheMaps,
		maxB:    cfg.CacheBytes,
		maxNeg:  maxNegativeEntries(cfg.CacheMaps),
		lru:     list.New(),
		entries: map[string]*list.Element{},
		missing: map[string]negativeEntry{},
		negLRU:  list.New(),
	}
}

// get returns the parsed map under key, nil with no error when there is
// none, or an error when it cannot be read or parsed.
func (c *mapCache) get(ctx context.Context, key string) (*sourcemap.Map, error) {
	if m, err, ok := c.lookup(key); ok {
		return m, err
	}
	v, err, _ := c.loads.Do(key, func() (any, error) {
		if m, err, ok := c.lookup(key); ok {
			return m, err
		}
		return c.load(ctx, key)
	})
	m, _ := v.(*sourcemap.Map)
	return m, err
}

// lookup answers from memory when it can.
func (c *mapCache) lookup(key string) (*sourcemap.Map, error, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.entries[key]; ok {
		c.lru.MoveToFront(el)
		return el.Value.(*cacheEntry).m, nil, true
	}
	if neg, ok := c.missing[key]; ok {
		if c.now().Before(neg.until) {
			if neg.broken {
				return nil, errBrokenMap, true
			}
			return nil, nil, true
		}
		c.forgetNegative(key)
	}
	return nil, nil, false
}

// load reads and parses one map. The read is detached from the request,
// because other requests may be waiting on the same load, and bounded.
func (c *mapCache) load(ctx context.Context, key string) (*sourcemap.Map, error) {
	c.mu.Lock()
	gen := c.gen
	c.mu.Unlock()
	readCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), storeReadTimeout)
	defer cancel()
	raw, err := c.store.Get(readCtx, key)
	switch {
	case errors.Is(err, ErrNotFound):
		c.remember(key, gen, nil, false)
		return nil, nil
	case err != nil:
		c.remember(key, gen, nil, true)
		return nil, fmt.Errorf("o11yrum: reading source map: %w", err)
	}
	m, err := sourcemap.Parse(raw, sourcemap.Limits{})
	if err != nil {
		c.remember(key, gen, nil, true)
		return nil, err
	}
	c.remember(key, gen, m, false)
	return m, nil
}

// remember caches a load's result unless an invalidation happened while
// it loaded, which may have been for this key.
func (c *mapCache) remember(key string, gen uint64, m *sourcemap.Map, broken bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != gen {
		return
	}
	if m == nil {
		if c.ttl <= 0 {
			return
		}
		c.forgetNegative(key)
		for len(c.missing) >= c.maxNeg {
			c.forgetNegative(c.negLRU.Back().Value.(string))
		}
		c.missing[key] = negativeEntry{until: c.now().Add(c.ttl), broken: broken, elem: c.negLRU.PushFront(key)}
		return
	}
	size := m.Size()
	if size > c.maxB {
		return
	}
	c.entries[key] = c.lru.PushFront(&cacheEntry{key: key, m: m, size: size})
	c.bytes += size
	for c.lru.Len() > c.maxN || c.bytes > c.maxB {
		c.evict(c.lru.Back())
	}
}

func (c *mapCache) evict(el *list.Element) {
	e := el.Value.(*cacheEntry)
	c.lru.Remove(el)
	delete(c.entries, e.key)
	c.bytes -= e.size
}

func (c *mapCache) forgetNegative(key string) {
	if neg, ok := c.missing[key]; ok {
		c.negLRU.Remove(neg.elem)
		delete(c.missing, key)
	}
}

// invalidate drops both a cached map and a remembered absence of key.
func (c *mapCache) invalidate(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.entries[key]; ok {
		c.evict(el)
	}
	c.forgetNegative(key)
	c.gen++
}
