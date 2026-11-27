package o11yrum

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/stacktrace"
	"github.com/jamesainslie/libo11y/go/o11ytest"
)

const fixtureScript = "https://shop.example/assets/app.js"

var testSymCfg = SymbolicationConfig{CacheMaps: 4, CacheBytes: 1 << 26, NegativeTTL: time.Minute, MaxFrames: 50}

// uploadFixture returns a store holding the Bun-built fixture map for
// /assets/app.js of shop-web 1.4.2, and the column of the throw in the
// minified bundle.
func uploadFixture(t *testing.T, updateID string) (*memStore, int) {
	t.Helper()
	store := newMemStore()
	if err := store.Put(context.Background(), sourcemapKey("shop-web", "1.4.2", updateID, "/assets/app.js"), fixtureMap(t)); err != nil {
		t.Fatal(err)
	}
	js, err := os.ReadFile("internal/sourcemap/testdata/simple.js")
	if err != nil {
		t.Fatal(err)
	}
	return store, bytes.Index(js, []byte("throw")) + 1
}

func newTestSymbolicator(store ObjectStore, clock func() time.Time) *symbolicator {
	return newSymbolicator(store, testSymCfg, 4096, nil, clock)
}

// errorLogs builds one o11y.rum.error record of shop-web 1.4.2.
func errorLogs(excType, message, stack string) (plog.Logs, plog.LogRecord) {
	ld := plog.NewLogs()
	rl := ld.ResourceLogs().AppendEmpty()
	rl.Resource().Attributes().PutStr("service.name", "shop-web")
	rl.Resource().Attributes().PutStr("service.version", "1.4.2")
	lr := rl.ScopeLogs().AppendEmpty().LogRecords().AppendEmpty()
	lr.Attributes().PutStr("event.name", "o11y.rum.error")
	lr.Attributes().PutStr("exception.type", excType)
	lr.Attributes().PutStr("exception.message", message)
	if stack != "" {
		lr.Attributes().PutStr("exception.stacktrace", stack)
	}
	return ld, lr
}

func attrStr(t *testing.T, lr plog.LogRecord, k string) string {
	t.Helper()
	v, ok := lr.Attributes().Get(k)
	if !ok {
		t.Fatalf("no %s", k)
	}
	return v.Str()
}

func TestSymbolicateLogRecord(t *testing.T) {
	store, col := uploadFixture(t, "")
	s := newTestSymbolicator(store, time.Now)
	ld, lr := errorLogs("Error", "empty cart", fmt.Sprintf("Error: empty cart\n    at u (%s:1:%d)\n    at Array.map (<anonymous>)", fixtureScript, col))
	s.logs(context.Background(), "shop-web", "shop-web", ld)
	st := attrStr(t, lr, "exception.stacktrace")
	if !strings.HasPrefix(st, "Error: empty cart\n    at u (../app.ts:7:5)") || !strings.HasSuffix(st, "\n    at Array.map (<anonymous>)") {
		t.Fatalf("not symbolicated: %q", st)
	}
	if fp := attrStr(t, lr, "o11y.rum.error.fingerprint"); len(fp) != 32 {
		t.Fatalf("fingerprint %q", fp)
	}
}

func TestSymbolicateMissingMapKeepsStack(t *testing.T) {
	store, col := uploadFixture(t, "")
	clock := newTestClock()
	s := newTestSymbolicator(store, clock.Now)
	stack := fmt.Sprintf("Error: x\nu@%s:1:%d", fixtureScript, col)
	missingKey := sourcemapKey("shop-web", "9.9.9", "", "/assets/app.js")
	run := func() plog.LogRecord {
		ld, lr := errorLogs("Error", "x", stack)
		ld.ResourceLogs().At(0).Resource().Attributes().PutStr("service.version", "9.9.9")
		s.logs(context.Background(), "shop-web", "shop-web", ld)
		return lr
	}
	lr := run()
	if got := attrStr(t, lr, "exception.stacktrace"); got != stack {
		t.Fatalf("an unresolved stack was rewritten: %q", got)
	}
	if fp := attrStr(t, lr, "o11y.rum.error.fingerprint"); len(fp) != 32 {
		t.Fatalf("fingerprint %q", fp)
	}
	run()
	if n := store.getCount(missingKey); n != 1 {
		t.Fatalf("store read %d times within the negative TTL", n)
	}
	clock.advance(2 * time.Minute)
	run()
	if n := store.getCount(missingKey); n != 2 {
		t.Fatalf("store read %d times after the negative TTL", n)
	}
}

func TestSymbolicateUsesUpdateID(t *testing.T) {
	store, col := uploadFixture(t, "u1")
	s := newTestSymbolicator(store, time.Now)
	stack := fmt.Sprintf("Error: x\n    at u (%s:1:%d)", fixtureScript, col)
	for name, tc := range map[string]struct {
		resource, record string
		resolved         bool
	}{
		"none":            {"", "", false},
		"resource":        {"u1", "", true},
		"record":          {"", "u1", true},
		"record wins":     {"u1", "u2", false},
		"other on record": {"u2", "u1", true},
	} {
		t.Run(name, func(t *testing.T) {
			ld, lr := errorLogs("Error", "x", stack)
			if tc.resource != "" {
				ld.ResourceLogs().At(0).Resource().Attributes().PutStr(keyUpdateID, tc.resource)
			}
			if tc.record != "" {
				lr.Attributes().PutStr(keyUpdateID, tc.record)
			}
			s.logs(context.Background(), "shop-web", "shop-web", ld)
			if got := strings.Contains(attrStr(t, lr, "exception.stacktrace"), "app.ts"); got != tc.resolved {
				t.Fatalf("resolved %v, want %v", got, tc.resolved)
			}
		})
	}
}

func TestCallerCallSiteNames(t *testing.T) {
	// Column 1 maps to src/app.ts:2:3, the token "reduce"; column 11 maps
	// to src/app.ts:9:10, the token "computeTotal". Frame 1 called frame
	// 0's function at column 11, so frame 0 is computeTotal.
	store := newMemStore()
	_ = store.Put(context.Background(), sourcemapKey("shop-web", "1.4.2", "", "/assets/app.js"),
		[]byte(`{"version":3,"sources":["src/app.ts"],"names":["reduce","computeTotal"],"mappings":"AACEA,UAOOC"}`))
	s := newTestSymbolicator(store, time.Now)
	ld, lr := errorLogs("TypeError", "x", fmt.Sprintf("TypeError: x\n    at t (%[1]s:1:1)\n    at u (%[1]s:1:11)", fixtureScript))
	s.logs(context.Background(), "shop-web", "shop-web", ld)
	want := "TypeError: x\n    at computeTotal (src/app.ts:2:3)\n    at u (src/app.ts:9:10)"
	if got := attrStr(t, lr, "exception.stacktrace"); got != want {
		t.Fatalf("%q\nwant %q", got, want)
	}
}

func TestFingerprint(t *testing.T) {
	frames := func(lines ...int) []stacktrace.Frame {
		return []stacktrace.Frame{
			{Function: "computeTotal", URL: "src/app.ts", Line: lines[0], Column: lines[1]},
			{Function: "checkout", URL: "webpack:///./src/app.ts", Line: lines[2], Column: lines[3]},
			{Raw: "    at Array.map (<anonymous>)"},
		}
	}
	a := fingerprint("TypeError", "x", frames(2, 10, 9, 3))
	if b := fingerprint("TypeError", "y is different", frames(3, 1, 12, 7)); a != b {
		t.Fatal("line, column and message changed the fingerprint of a stack with frames")
	}
	if fingerprint("RangeError", "x", frames(2, 10, 9, 3)) == a {
		t.Fatal("the exception type did not change the fingerprint")
	}
	other := frames(2, 10, 9, 3)
	other[0].Function = "applyDiscount"
	if fingerprint("TypeError", "x", other) == a {
		t.Fatal("a function name did not change the fingerprint")
	}
	// Without URL frames the message, digits folded, is the key.
	if fingerprint("Error", "order 123 failed", nil) != fingerprint("Error", "order 456 failed", nil) {
		t.Fatal("digits split the message fingerprint")
	}
	if fingerprint("Error", "order 123 failed", nil) == fingerprint("Error", "cart 123 failed", nil) {
		t.Fatal("different messages share a fingerprint")
	}
	if len(a) != 32 {
		t.Fatalf("fingerprint %q", a)
	}
	// Only the first five URL frames count.
	long := make([]stacktrace.Frame, 0, 7)
	for i := range 7 {
		long = append(long, stacktrace.Frame{Function: fmt.Sprintf("f%d", i), URL: "a.js", Line: 1, Column: 1})
	}
	changed := append([]stacktrace.Frame(nil), long...)
	changed[6].Function = "other"
	if fingerprint("E", "", long) != fingerprint("E", "", changed) {
		t.Fatal("a sixth frame changed the fingerprint")
	}
}

func TestFingerprintWithoutStack(t *testing.T) {
	s := newTestSymbolicator(newMemStore(), time.Now)
	ld1, lr1 := errorLogs("Error", "order 123 failed", "")
	ld2, lr2 := errorLogs("Error", "order 456 failed", "")
	s.logs(context.Background(), "shop-web", "shop-web", ld1)
	s.logs(context.Background(), "shop-web", "shop-web", ld2)
	if a, b := attrStr(t, lr1, keyErrorFingerprint), attrStr(t, lr2, keyErrorFingerprint); a != b || len(a) != 32 {
		t.Fatalf("%q %q", a, b)
	}
}

func TestSymbolicateLeavesOtherRecords(t *testing.T) {
	s := newTestSymbolicator(newMemStore(), time.Now)
	ld := sampleLogs()
	s.logs(context.Background(), "shop-web", "shop-web", ld)
	if _, ok := ld.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0).Attributes().Get(keyErrorFingerprint); ok {
		t.Fatal("a session start got a fingerprint")
	}
}

func TestSymbolicateSpanExceptionEvents(t *testing.T) {
	store, col := uploadFixture(t, "")
	s := newTestSymbolicator(store, time.Now)
	td := ptrace.NewTraces()
	rs := td.ResourceSpans().AppendEmpty()
	rs.Resource().Attributes().PutStr("service.version", "1.4.2")
	span := rs.ScopeSpans().AppendEmpty().Spans().AppendEmpty()
	ev := span.Events().AppendEmpty()
	ev.SetName("exception")
	ev.Attributes().PutStr("exception.type", "Error")
	ev.Attributes().PutStr("exception.stacktrace", fmt.Sprintf("Error: empty cart\n    at u (%s:1:%d)", fixtureScript, col))
	other := span.Events().AppendEmpty()
	other.SetName("click")
	other.Attributes().PutStr("exception.stacktrace", "not an exception event")
	s.traces(context.Background(), "shop-web", "shop-web", td)
	st, _ := ev.Attributes().Get("exception.stacktrace")
	if !strings.Contains(st.Str(), "app.ts:7:5") {
		t.Fatalf("not symbolicated: %q", st.Str())
	}
	if _, ok := ev.Attributes().Get(keyErrorFingerprint); !ok {
		t.Fatal("no fingerprint on the exception event")
	}
	if _, ok := other.Attributes().Get(keyErrorFingerprint); ok {
		t.Fatal("a non-exception event was touched")
	}
}

func TestSymbolicateBounds(t *testing.T) {
	store, col := uploadFixture(t, "")
	s := newSymbolicator(store, SymbolicationConfig{CacheMaps: 4, CacheBytes: 1 << 26, NegativeTTL: time.Minute, MaxFrames: 50}, 120, nil, time.Now)
	var b strings.Builder
	b.WriteString("Error: x")
	for range 10 {
		fmt.Fprintf(&b, "\n    at u (%s:1:%d)", fixtureScript, col)
	}
	ld, lr := errorLogs("Error", "x", b.String())
	s.logs(context.Background(), "shop-web", "shop-web", ld)
	st := attrStr(t, lr, "exception.stacktrace")
	if len(st) > 120 || !strings.Contains(st, "app.ts") || strings.HasSuffix(st, "(") {
		t.Fatalf("%d bytes: %q", len(st), st)
	}
	// Stacks naming many scripts load a bounded number of maps.
	b.Reset()
	b.WriteString("Error: x")
	for i := range 20 {
		fmt.Fprintf(&b, "\n    at u (https://shop.example/assets/s%d.js:1:1)", i)
	}
	ld, _ = errorLogs("Error", "x", b.String())
	s.logs(context.Background(), "shop-web", "shop-web", ld)
	store.mu.Lock()
	reads := 0
	for _, n := range store.gets {
		reads += n
	}
	store.mu.Unlock()
	if reads > maxMapsPerStack+1 { // +1 for the fixture read above
		t.Fatalf("%d store reads for one stack", reads)
	}
}

func TestSymbolicateSkipsInvalidVersion(t *testing.T) {
	store, col := uploadFixture(t, "")
	s := newTestSymbolicator(store, time.Now)
	ld, lr := errorLogs("Error", "x", fmt.Sprintf("Error: x\n    at u (%s:1:%d)", fixtureScript, col))
	ld.ResourceLogs().At(0).Resource().Attributes().PutStr("service.version", "../1.4.2")
	s.logs(context.Background(), "shop-web", "shop-web", ld)
	if strings.Contains(attrStr(t, lr, "exception.stacktrace"), "app.ts") {
		t.Fatal("symbolicated with an invalid version")
	}
	if len(store.gets) != 0 {
		t.Fatalf("store read: %v", store.gets)
	}
}

func TestCacheEvicts(t *testing.T) {
	store := newMemStore()
	raw := fixtureMap(t)
	keyA, keyB := "sourcemaps/a/1/_/a.map", "sourcemaps/a/1/_/b.map"
	_ = store.Put(context.Background(), keyA, raw)
	_ = store.Put(context.Background(), keyB, raw)
	c := newMapCache(store, SymbolicationConfig{CacheMaps: 1, CacheBytes: 1 << 26, NegativeTTL: time.Minute}, time.Now)
	ctx := context.Background()
	load := func(k string) {
		if m, err := c.get(ctx, k); err != nil || m == nil {
			t.Fatalf("get %s: %v %v", k, m, err)
		}
	}
	load(keyA)
	load(keyA)
	if n := store.getCount(keyA); n != 1 {
		t.Fatalf("%d reads of a cached map", n)
	}
	load(keyB)
	load(keyA)
	if n := store.getCount(keyA); n != 2 {
		t.Fatalf("%d reads of A after B evicted it", n)
	}
	c.invalidate(keyA)
	load(keyA)
	if n := store.getCount(keyA); n != 3 {
		t.Fatalf("%d reads of A after invalidate", n)
	}
	// A byte budget smaller than one map keeps nothing cached.
	tiny := newMapCache(store, SymbolicationConfig{CacheMaps: 8, CacheBytes: 1, NegativeTTL: time.Minute}, time.Now)
	for range 2 {
		if m, _ := tiny.get(ctx, keyB); m == nil {
			t.Fatal("an uncacheable map was not returned")
		}
	}
	if n := store.getCount(keyB); n != 3 {
		t.Fatalf("%d reads of B with a one-byte budget", n)
	}
}

func TestCacheNegativeEntriesAreBounded(t *testing.T) {
	c := newMapCache(newMemStore(), SymbolicationConfig{CacheMaps: 1, CacheBytes: 1 << 20, NegativeTTL: time.Hour}, time.Now)
	for i := range 10 * maxNegativeEntries(1) {
		_, _ = c.get(context.Background(), fmt.Sprintf("k%d", i))
	}
	c.mu.Lock()
	n := len(c.missing)
	c.mu.Unlock()
	if n > maxNegativeEntries(1) {
		t.Fatalf("%d negative entries", n)
	}
}

func TestCacheInvalidMapCountsAsErrorAndIsNotRefetched(t *testing.T) {
	store := newMemStore()
	_ = store.Put(context.Background(), "k", []byte("nope"))
	c := newMapCache(store, testSymCfg, time.Now)
	for range 3 {
		if _, err := c.get(context.Background(), "k"); err == nil {
			t.Fatal("an invalid map loaded")
		}
	}
	if n := store.getCount("k"); n != 1 {
		t.Fatalf("%d reads of an invalid map", n)
	}
}

func TestCacheConcurrentLoadsShareOneRead(t *testing.T) {
	store := newMemStore()
	_ = store.Put(context.Background(), "k", fixtureMap(t))
	c := newMapCache(store, testSymCfg, time.Now)
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			if m, err := c.get(context.Background(), "k"); err != nil || m == nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if n := store.getCount("k"); n > 2 {
		t.Fatalf("%d reads for concurrent loads", n)
	}
}

func TestIngestSymbolicates(t *testing.T) {
	rec := o11ytest.Start(t)
	sink := &recordingSink{}
	cfg, _ := writeConfig(t, uploadConfig)
	h, err := NewHandler(WithConfig(cfg), WithSDK(rec.SDK), WithSinks(sink))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = h.Close() }()
	if w := upload(h, http.MethodPost, validUpload, "Bearer secret-1", "", fixtureMap(t)); w.Code != http.StatusCreated {
		t.Fatalf("upload: %d", w.Code)
	}
	_, col := uploadFixture(t, "")
	ld, lr := errorLogs("Error", "empty cart", fmt.Sprintf("Error: empty cart\n    at u (%s:1:%d)", fixtureScript, col))
	lr.Attributes().PutStr("o11y.rum.error.source", "uncaught")
	lr.Attributes().PutStr("session.id", "s1")
	lr.Attributes().PutStr("o11y.rum.view.id", "v1")
	lr.Attributes().PutStr(keyErrorFingerprint, "client-chosen")
	w := send(h, http.MethodPost, "/_o11y/v1/logs", "application/json", "https://shop.example", "203.0.113.5:1000", logsBody(t, ld))
	if w.Code != http.StatusOK {
		t.Fatalf("ingest: %d %s", w.Code, w.Body)
	}
	if sink.count() != 1 {
		t.Fatalf("%d batches", sink.count())
	}
	got := sink.batches[0].Logs.ResourceLogs().At(0).ScopeLogs().At(0).LogRecords().At(0)
	if st := attrStr(t, got, "exception.stacktrace"); !strings.Contains(st, "app.ts:7:5") {
		t.Fatalf("not symbolicated: %q", st)
	}
	if fp := attrStr(t, got, keyErrorFingerprint); len(fp) != 32 {
		t.Fatalf("fingerprint %q", fp)
	}
	frames := sumPoints(t, metricByName(t, rec.Metrics(), "o11yrum.symbolication.frames"))
	if n := frames[set(telApp, "shop-web", telResult, "hit")]; n != 1 {
		t.Fatalf("hits %d: %v", n, frames)
	}
}
