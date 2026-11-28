package o11yrum

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
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
	// CacheTTL is how long a parsed map is used before the store is read
	// again. Default 10m. It bounds how long a gateway replica that did
	// not receive an upload keeps using the map the upload replaced.
	CacheTTL time.Duration `yaml:"cache_ttl"`
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
	if c.CacheTTL == 0 {
		c.CacheTTL = 10 * time.Minute
	}
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
	case c.CacheTTL < 0:
		return errors.New("symbolication.cache_ttl must not be negative")
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
	frameSkipped  = "skipped"  // no usable version, no position, or over the batch's load budget
)

// The load budget of one batch. Script URLs come from clients, so without
// it one batch of many records naming many scripts could turn into
// thousands of store reads on the request's goroutine. Maps already in
// memory cost nothing against it.
const (
	maxLoadsPerBatch   = 16              // distinct maps one batch may read from the store
	defaultBatchBudget = 2 * time.Second // after this, no new read starts
	storeReadTimeout   = 2 * time.Second // bounds one read
)

// symbolicator resolves minified stack frames through uploaded source
// maps and fingerprints errors. A nil symbolicator does nothing.
type symbolicator struct {
	cache       *mapCache
	tel         *telemetry
	maxFrames   int
	maxValueLen int
	batchBudget time.Duration
}

// symbolicatorDeps are what a symbolicator needs besides its store and
// configuration. Zero fields take a working default.
type symbolicatorDeps struct {
	// maxValueLen caps a rewritten stack, as the attribute policy caps
	// every string value. Zero leaves it uncapped.
	maxValueLen int
	// maxMapBytes caps an object read from the store. Zero leaves it
	// uncapped.
	maxMapBytes int64
	tel         *telemetry
	log         *slog.Logger
	now         func() time.Time
}

// newSymbolicator reads maps from store.
func newSymbolicator(store ObjectStore, cfg SymbolicationConfig, d symbolicatorDeps) *symbolicator {
	if d.tel == nil {
		d.tel = newTelemetry(nil, nil)
	}
	if d.now == nil {
		d.now = time.Now
	}
	c := newMapCache(store, cfg, d.maxMapBytes, d.now)
	c.log = d.log
	return &symbolicator{
		cache:       c,
		tel:         d.tel,
		maxFrames:   cfg.MaxFrames,
		maxValueLen: d.maxValueLen,
		batchBudget: defaultBatchBudget,
	}
}

// loadBudget is one batch's allowance of store reads.
type loadBudget struct {
	loaded   map[string]bool
	deadline time.Time
}

func (s *symbolicator) newBudget() *loadBudget {
	// Wall time, not the handler's clock: the budget bounds real latency.
	return &loadBudget{loaded: map[string]bool{}, deadline: time.Now().Add(s.batchBudget)}
}

// allow reports whether key may be read from the store. A key the batch
// already read is always allowed, because the cache now answers it.
func (b *loadBudget) allow(key string) bool {
	if b.loaded[key] {
		return true
	}
	if len(b.loaded) >= maxLoadsPerBatch || !time.Now().Before(b.deadline) {
		return false
	}
	b.loaded[key] = true
	return true
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
	tally, budget := frameTally{}, s.newBudget()
	for i := range ld.ResourceLogs().Len() {
		rl := ld.ResourceLogs().At(i)
		rel := releaseOf(namespace, rl.Resource())
		for j := range rl.ScopeLogs().Len() {
			records := rl.ScopeLogs().At(j).LogRecords()
			for k := range records.Len() {
				lr := records.At(k)
				_, hasStack := lr.Attributes().Get(keyExcStacktrace)
				if hasStack || eventName(lr) == eventRUMError {
					s.resolve(ctx, rel.withRecord(lr.Attributes()), lr.Attributes(), tally, budget)
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
	tally, budget := frameTally{}, s.newBudget()
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
						s.resolve(ctx, spanRel.withRecord(ev.Attributes()), ev.Attributes(), tally, budget)
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
func (s *symbolicator) resolve(ctx context.Context, rel release, attrs pcommon.Map, tally frameTally, budget *loadBudget) {
	var frames []stacktrace.Frame
	if v, ok := attrs.Get(keyExcStacktrace); ok && v.Type() == pcommon.ValueTypeStr {
		tr := stacktrace.Parse(v.Str(), s.maxFrames)
		if s.symbolicate(ctx, rel, &tr, tally, budget) {
			v.SetStr(truncateLines(tr.String(), s.maxValueLen))
		}
		frames = tr.Frames
	}
	attrs.PutStr(keyErrorFingerprint, fingerprint(strAttr(attrs, keyExcType), strAttr(attrs, keyExcMessage), frames))
}

// symbolicate resolves tr's frames in place and reports whether any
// resolved.
func (s *symbolicator) symbolicate(ctx context.Context, rel release, tr *stacktrace.Trace, tally frameTally, budget *loadBudget) bool {
	if !validSegment(rel.version) || (rel.updateID != "" && !validSegment(rel.updateID)) || rel.namespace == "" {
		tally[frameSkipped] += int64(len(tr.Frames))
		return false
	}
	resolved := make([]bool, len(tr.Frames))
	names := make([]string, len(tr.Frames)) // the name mapped at each frame's own position
	anyResolved := false
	for i, f := range tr.Frames {
		if f.URL == "" || f.Line == 0 || f.Column == 0 {
			tally[frameSkipped]++
			continue
		}
		key := sourcemapKey(rel.namespace, rel.version, rel.updateID, normalizeScriptPath(f.URL))
		m, err, cached := s.cache.lookup(key)
		if !cached {
			if !budget.allow(key) {
				tally[frameSkipped]++
				continue
			}
			m, err = s.cache.get(ctx, key)
		}
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
	store    ObjectStore
	now      func() time.Time
	ttl      time.Duration // of negative entries
	posTTL   time.Duration // of parsed maps
	maxN     int
	maxB     int64
	maxNeg   int
	maxBytes int64        // of one object; 0 for no cap
	log      *slog.Logger // nil discards store errors
	// lastLogged is when a store error was last logged, in Unix
	// nanoseconds, so a failing store logs once a minute.
	lastLogged atomic.Int64

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
	key   string
	m     *sourcemap.Map
	size  int64
	until time.Time
}

type negativeEntry struct {
	until  time.Time
	broken bool // unreadable or invalid, rather than missing
	elem   *list.Element
}

// errBrokenMap is returned for a key remembered as unreadable or invalid.
var errBrokenMap = errors.New("o11yrum: source map unreadable or invalid")

// storeErrorLogInterval spaces the warnings a failing store logs.
const storeErrorLogInterval = time.Minute

// newMapCache reads from store. maxBytes caps one object read; 0 leaves
// it uncapped.
func newMapCache(store ObjectStore, cfg SymbolicationConfig, maxBytes int64, now func() time.Time) *mapCache {
	return &mapCache{
		store:    store,
		now:      now,
		ttl:      cfg.NegativeTTL,
		posTTL:   cfg.CacheTTL,
		maxN:     cfg.CacheMaps,
		maxB:     cfg.CacheBytes,
		maxNeg:   maxNegativeEntries(cfg.CacheMaps),
		maxBytes: maxBytes,
		lru:      list.New(),
		entries:  map[string]*list.Element{},
		missing:  map[string]negativeEntry{},
		negLRU:   list.New(),
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
		e := el.Value.(*cacheEntry)
		if c.posTTL <= 0 || c.now().Before(e.until) {
			c.lru.MoveToFront(el)
			return e.m, nil, true
		}
		c.evict(el)
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
		c.logStoreError(err)
		return nil, fmt.Errorf("o11yrum: reading source map: %w", err)
	case c.maxBytes > 0 && int64(len(raw)) > c.maxBytes:
		c.remember(key, gen, nil, true)
		return nil, fmt.Errorf("o11yrum: source map %s is larger than %d bytes", key, c.maxBytes)
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
	c.entries[key] = c.lru.PushFront(&cacheEntry{key: key, m: m, size: size, until: c.now().Add(c.posTTL)})
	c.bytes += size
	for c.lru.Len() > c.maxN || c.bytes > c.maxB {
		c.evict(c.lru.Back())
	}
}

// logStoreError warns about a failing store at most once a minute, so an
// outage is visible without a line per frame.
func (c *mapCache) logStoreError(err error) {
	if c.log == nil {
		return
	}
	now := time.Now().UnixNano()
	last := c.lastLogged.Load()
	if now-last < int64(storeErrorLogInterval) || !c.lastLogged.CompareAndSwap(last, now) {
		return
	}
	c.log.Warn("o11yrum: reading a source map from the object store failed", slog.Any("error", err))
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
