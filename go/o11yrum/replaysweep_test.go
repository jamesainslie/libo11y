package o11yrum

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jamesainslie/libo11y/go/o11ytest"
)

// sweepFixture builds a handler over store with the given replay block
// and the real clock, since file modification times are real.
func sweepFixture(t *testing.T, store ObjectStore, replay string) (*Handler, *o11ytest.Recorder) {
	t.Helper()
	cfg, err := ParseConfig([]byte("replay: " + replay + "\n" + replayApp))
	if err != nil {
		t.Fatal(err)
	}
	rec := o11ytest.Start(t)
	h, err := NewHandler(WithConfig(cfg), WithObjectStore(store), WithSDK(rec.SDK))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.Close() })
	return h, rec
}

// seedSweep writes four replay objects and a source map, and backdates two
// of the replay objects past the default retention.
func seedSweep(t *testing.T, fs *FileStore) (expired, kept []string) {
	t.Helper()
	const other = "1c8f6d2f-7a3b-4d66-8c2f-2e3d4c5b6a70"
	expired = []string{replayKey("shop-web", replaySession, 0), replayMetaKey("shop-web", replaySession, 0)}
	kept = []string{replayKey("shop-web", other, 0), replayMetaKey("shop-web", other, 0), "sourcemaps/shop-web/1/_/x.map"}
	ctx := context.Background()
	for _, k := range append(slices.Clone(expired), kept...) {
		if err := fs.Put(ctx, k, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-31 * 24 * time.Hour)
	for _, k := range expired {
		if err := os.Chtimes(filepath.Join(fs.root, filepath.FromSlash(k)), old, old); err != nil {
			t.Fatal(err)
		}
	}
	// A source map older than the retention is not replay's to sweep.
	if err := os.Chtimes(filepath.Join(fs.root, "sourcemaps", "shop-web", "1", "_", "x.map"), old, old); err != nil {
		t.Fatal(err)
	}
	return expired, kept
}

func TestSweepReplayFileStore(t *testing.T) {
	fs, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	expired, kept := seedSweep(t, fs)
	h, rec := sweepFixture(t, fs, "{sweep_interval: 0s}")
	n, err := h.sweepReplay(context.Background())
	if err != nil || n != 2 {
		t.Fatalf("swept %d, %v; want 2", n, err)
	}
	ctx := context.Background()
	for _, k := range expired {
		if _, err := fs.Get(ctx, k); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s survived: %v", k, err)
		}
	}
	for _, k := range kept {
		if _, err := fs.Get(ctx, k); err != nil {
			t.Errorf("%s went: %v", k, err)
		}
	}
	swept := sumPoints(t, metricByName(t, rec.Metrics(), "o11yrum.replay.swept"))
	if got := swept[set(telOutcome, "ok")]; got != 2 {
		t.Errorf("swept ok %d, want 2", got)
	}
	// A second pass finds nothing.
	if n, err := h.sweepReplay(ctx); err != nil || n != 0 {
		t.Errorf("second pass %d, %v", n, err)
	}
}

func TestSweepReplayRetention(t *testing.T) {
	fs, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	seedSweep(t, fs)
	// With a retention of 40 days nothing has expired.
	h, _ := sweepFixture(t, fs, "{sweep_interval: 0s, retention: 960h}")
	if n, err := h.sweepReplay(context.Background()); err != nil || n != 0 {
		t.Fatalf("swept %d, %v; want 0", n, err)
	}
}

func TestSweepReplayDeleteFailures(t *testing.T) {
	fs, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	expired, _ := seedSweep(t, fs)
	store := &flakyStore{FileStore: fs, failDelete: func(k string) bool { return k == expired[0] }}
	h, rec := sweepFixture(t, store, "{sweep_interval: 0s}")
	n, err := h.sweepReplay(context.Background())
	if err != nil || n != 1 {
		t.Fatalf("swept %d, %v; want 1 and the pass to finish", n, err)
	}
	if _, err := fs.Get(context.Background(), expired[1]); !errors.Is(err, ErrNotFound) {
		t.Errorf("the object after the failure survived: %v", err)
	}
	swept := sumPoints(t, metricByName(t, rec.Metrics(), "o11yrum.replay.swept"))
	if swept[set(telOutcome, "ok")] != 1 || swept[set(telOutcome, "error")] != 1 {
		t.Errorf("swept %v", swept)
	}
	for _, l := range rec.Logs() {
		if strings.Contains(l.Record.Message+attrsOf(l), replaySession) {
			t.Errorf("a log names the session: %s", l.Record.Message+attrsOf(l))
		}
	}
}

func TestSweepReplayListFailure(t *testing.T) {
	fs, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h, rec := sweepFixture(t, &flakyStore{FileStore: fs, failList: true}, "{sweep_interval: 0s}")
	if _, err := h.sweepReplay(context.Background()); err == nil {
		t.Fatal("a failing List did not end the pass with an error")
	}
	h.sweepOnce(context.Background())
	var warned bool
	for _, l := range rec.Logs() {
		warned = warned || strings.Contains(l.Record.Message, "sweep")
	}
	if !warned {
		t.Error("a failed pass was not logged")
	}
}

// blockingLister blocks List until its context ends, and says when it
// started.
type blockingLister struct {
	*FileStore
	started chan struct{}
	ended   chan error
}

func (s blockingLister) List(ctx context.Context, _ string, _ func(ObjectInfo) error) error {
	select {
	case s.started <- struct{}{}:
	default:
	}
	<-ctx.Done()
	s.ended <- ctx.Err()
	return ctx.Err()
}

func TestSweeperStopsOnClose(t *testing.T) {
	fs, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := blockingLister{FileStore: fs, started: make(chan struct{}, 1), ended: make(chan error, 8)}
	h, _ := sweepFixture(t, store, "{sweep_interval: 10ms}")
	if h.sweepStop == nil {
		t.Fatal("no sweeper started")
	}
	select {
	case <-store.started:
	case <-time.After(5 * time.Second):
		t.Fatal("no pass started")
	}
	start := time.Now()
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("Close took %v", d)
	}
	select {
	case err := <-store.ended:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("the pass ended with %v", err)
		}
	default:
		t.Fatal("Close returned before the pass ended")
	}
	if err := h.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}

func TestSweeperFirstPassWaitsAnInterval(t *testing.T) {
	fs, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	store := blockingLister{FileStore: fs, started: make(chan struct{}, 1), ended: make(chan error, 8)}
	_, _ = sweepFixture(t, store, "{sweep_interval: 1h}")
	select {
	case <-store.started:
		t.Fatal("a pass ran at start")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestSweeperOff(t *testing.T) {
	fs, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h, _ := sweepFixture(t, fs, "{sweep_interval: 0s}")
	if h.sweepStop != nil {
		t.Error("sweep_interval 0s started a sweeper")
	}
	// With no app recording, a store that can list and delete is still
	// swept, so what was stored before replay was switched off expires.
	cfg, err := ParseConfig([]byte("apps:\n  - service_name: a\n    origins: [https://a.example]\n"))
	if err != nil {
		t.Fatal(err)
	}
	h2, err := NewHandler(WithConfig(cfg), WithObjectStore(fs))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = h2.Close() }()
	if h2.sweepStop == nil {
		t.Error("a store left by replay is not swept once replay is off")
	}
	// A store that cannot list and delete, or no store, is not swept.
	for name, opt := range map[string]Option{"put-get store": WithObjectStore(putGetOnly{}), "no store": WithObjectStore(nil)} {
		h, err := NewHandler(WithConfig(cfg), opt)
		if err != nil {
			t.Fatal(err)
		}
		if h.sweepStop != nil {
			t.Errorf("%s: a sweeper started", name)
		}
		_ = h.Close()
	}
	// The default interval starts one.
	h3, _ := sweepFixture(t, fs, "{}")
	if h3.sweepStop == nil {
		t.Error("the default interval started no sweeper")
	}
}

// attrsOf renders a log record's attributes, for leak checks.
func attrsOf(l o11ytest.LogRecord) string {
	var b strings.Builder
	l.Record.Attrs(func(a slog.Attr) bool {
		b.WriteString(" " + a.String())
		return true
	})
	return b.String()
}
