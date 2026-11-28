package o11yrum

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNormalizeScriptPath(t *testing.T) {
	for in, want := range map[string]string{
		"https://shop.example/assets/app-3f2a.js?v=1#x": "/assets/app-3f2a.js",
		"https://shop.example:8443/assets/app.js":       "/assets/app.js",
		"chrome-extension://abcdef/js/content.js":       "/js/content.js",
		"/assets/app.js":                "/assets/app.js",
		"/assets/app.js?v=2":            "/assets/app.js",
		"~/assets/app.js":               "/assets/app.js",
		"assets/app.js":                 "/assets/app.js",
		"index.android.bundle":          "/index.android.bundle",
		"app:///index.android.bundle":   "/index.android.bundle",
		"/a/../b/./c.js":                "/b/c.js",
		"https://shop.example/a%20b.js": "/a b.js",
		"/a%20b.js":                     "/a b.js",
		"":                              "",
	} {
		if got := normalizeScriptPath(in); got != want {
			t.Errorf("%q: %q, want %q", in, got, want)
		}
	}
}

func TestSourcemapKey(t *testing.T) {
	prefix := "sourcemaps/shop-web/1.4.2/_/"
	k := sourcemapKey("shop-web", "1.4.2", "", "/assets/app.js")
	if !strings.HasPrefix(k, prefix) || !strings.HasSuffix(k, ".map") || len(k) != len(prefix)+32+4 {
		t.Fatalf("key %q", k)
	}
	if sourcemapKey("shop-web", "1.4.2", "u1", "/assets/app.js") == k {
		t.Fatal("update id must change the key")
	}
	if sourcemapKey("shop-web", "1.4.2", "", "/assets/other.js") == k {
		t.Fatal("script path must change the key")
	}
	if sourcemapKey("shop-web", "1.4.2", "", "/assets/app.js") != k {
		t.Fatal("key is not deterministic")
	}
}

func TestValidSegment(t *testing.T) {
	for s, want := range map[string]bool{
		"1.4.2": true, "1.4.2+build.7": true, "shop-web": true, "0d1f5a4e-6b7c": true,
		"..": false, ".": false, ".hidden": false, "a/b": false, "": false, "a b": false,
		strings.Repeat("a", 128): true, strings.Repeat("a", 129): false,
	} {
		if validSegment(s) != want {
			t.Errorf("%q: want %v", s, want)
		}
	}
}

func TestFileStore(t *testing.T) {
	root := t.TempDir()
	s, err := NewFileStore(root)
	if err != nil {
		t.Fatal(err)
	}
	var _ ObjectStore = s
	ctx := context.Background()
	if _, err := s.Get(ctx, "sourcemaps/a/1/_/x.map"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if err := s.Put(ctx, "sourcemaps/a/1/_/x.map", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Get(ctx, "sourcemaps/a/1/_/x.map"); err != nil || string(got) != "{}" {
		t.Fatalf("%q %v", got, err)
	}
	if err := s.Put(ctx, "sourcemaps/a/1/_/x.map", []byte(`{"v":2}`)); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Get(ctx, "sourcemaps/a/1/_/x.map"); string(got) != `{"v":2}` {
		t.Fatalf("overwrite: %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, "sourcemaps", "a", "1", "_", "x.map")); err != nil {
		t.Fatalf("file layout: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(root, "sourcemaps", "a", "1", "_"))
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
	for _, bad := range []string{"../x", "/abs", "a/../../x", "a//b", "", "a/./b", `a\b`} {
		if err := s.Put(ctx, bad, nil); err == nil {
			t.Errorf("Put key %q accepted", bad)
		}
		if _, err := s.Get(ctx, bad); err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("Get key %q: %v", bad, err)
		}
	}
}

func TestNewFileStoreRefusesEmptyRoot(t *testing.T) {
	if _, err := NewFileStore(""); err == nil {
		t.Fatal("empty root accepted")
	}
}

func TestFileStoreListDelete(t *testing.T) {
	s, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, k := range []string{"replay/a/s1/000001.json.gz", "replay/a/s1/000000.json.gz", "replay/a/s2/000000.json.gz", "replay/a/s10/000000.json.gz", "sourcemaps/a/1/_/x.map"} {
		if err := s.Put(ctx, k, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	// A temporary file a concurrent Put leaves behind is not an object.
	if err := os.WriteFile(filepath.Join(s.root, "replay", "a", "s1", ".put-123"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := s.List(ctx, "replay/a/s1/", func(o ObjectInfo) error {
		got = append(got, o.Key)
		if o.Size != 1 || o.Modified.IsZero() {
			t.Errorf("%s: size %d modified %v", o.Key, o.Size, o.Modified)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"replay/a/s1/000000.json.gz", "replay/a/s1/000001.json.gz"}; !slices.Equal(got, want) {
		t.Fatalf("list %v, want %v", got, want)
	}
	got = nil
	if err := s.List(ctx, "replay/a/s", func(o ObjectInfo) error {
		got = append(got, o.Key)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"replay/a/s1/000000.json.gz", "replay/a/s1/000001.json.gz", "replay/a/s10/000000.json.gz", "replay/a/s2/000000.json.gz"}; !slices.Equal(got, want) {
		t.Fatalf("list of a partial segment %v, want %v (key order)", got, want)
	}
	got = nil
	if err := s.List(ctx, "", func(o ObjectInfo) error {
		got = append(got, o.Key)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 || !slices.IsSorted(got) {
		t.Fatalf("list of everything %v", got)
	}
	if err := s.Delete(ctx, "replay/a/s1/000000.json.gz"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "replay/a/s1/000000.json.gz"); err != nil {
		t.Fatalf("deleting a missing key: %v", err)
	}
	if _, err := s.Get(ctx, "replay/a/s1/000000.json.gz"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
	for _, bad := range []string{"../", "/abs/", "a/../../x", `a\b`, "a//"} {
		if err := s.List(ctx, bad, func(ObjectInfo) error { return nil }); err == nil {
			t.Errorf("List prefix %q accepted", bad)
		}
	}
	for _, bad := range []string{"../x", "/abs", "", "a/./b", `a\b`} {
		if err := s.Delete(ctx, bad); err == nil {
			t.Errorf("Delete key %q accepted", bad)
		}
	}
	var _ ObjectLister = s
	var _ ObjectDeleter = s
}

func TestFileStoreListEdges(t *testing.T) {
	s, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	calls := 0
	if err := s.List(ctx, "replay/none/", func(ObjectInfo) error { calls++; return nil }); err != nil || calls != 0 {
		t.Fatalf("empty prefix: %d calls, %v", calls, err)
	}
	for _, k := range []string{"replay/a/1", "replay/a/2", "replay/a/3"} {
		if err := s.Put(ctx, k, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	stop := errors.New("stop")
	calls = 0
	if err := s.List(ctx, "replay/", func(ObjectInfo) error { calls++; return stop }); !errors.Is(err, stop) || calls != 1 {
		t.Fatalf("fn error: %d calls, %v", calls, err)
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if err := s.List(cctx, "replay/", func(ObjectInfo) error { return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled context: %v", err)
	}
}

func TestFileStoreListThroughAFile(t *testing.T) {
	s, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := s.Put(ctx, "replay/ns/a.json", []byte("x")); err != nil {
		t.Fatal(err)
	}
	calls := 0
	if err := s.List(ctx, "replay/ns/a.json/", func(ObjectInfo) error { calls++; return nil }); err != nil || calls != 0 {
		t.Fatalf("%d calls, %v", calls, err)
	}
}

func TestFileStoreDeleteRemovesEmptyDirectories(t *testing.T) {
	root := t.TempDir()
	s, err := NewFileStore(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for _, k := range []string{"replay/a/s1/000000.json.gz", "replay/a/s1/000000.meta.json", "replay/a/s2/000000.json.gz"} {
		if err := s.Put(ctx, k, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Delete(ctx, "replay/a/s1/000000.json.gz"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "replay", "a", "s1")); err != nil {
		t.Fatalf("a directory still holding an object was removed: %v", err)
	}
	if err := s.Delete(ctx, "replay/a/s1/000000.meta.json"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "replay", "a", "s1")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the emptied directory remains: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "replay", "a", "s2")); err != nil {
		t.Fatalf("a sibling directory went: %v", err)
	}
	if err := s.Delete(ctx, "replay/a/s2/000000.json.gz"); err != nil {
		t.Fatal(err)
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
		t.Fatalf("root %v %v, want it empty and present", entries, err)
	}
	// Put recreates what Delete removed.
	if err := s.Put(ctx, "replay/a/s1/000001.json.gz", []byte("y")); err != nil {
		t.Fatal(err)
	}
}

func TestFileStorePutRacesDelete(t *testing.T) {
	s, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	var wg sync.WaitGroup
	errs := make(chan error, 400)
	for i := range 200 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			errs <- s.Put(ctx, fmt.Sprintf("replay/a/s/%06d.json.gz", i), []byte("x"))
		}()
		go func() {
			defer wg.Done()
			errs <- s.Delete(ctx, fmt.Sprintf("replay/a/s/%06d.json.gz", i))
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestFileStoreListsStaleTempFiles(t *testing.T) {
	root := t.TempDir()
	s, err := NewFileStore(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := s.Put(ctx, "replay/a/s1/000000.json.gz", []byte("x")); err != nil {
		t.Fatal(err)
	}
	// A Put that died left its temporary file; another is in flight.
	dir := filepath.Join(root, "replay", "a", "s1")
	for _, name := range []string{".put-1111", ".put-2222"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("segment"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(dir, ".put-1111"), old, old); err != nil {
		t.Fatal(err)
	}
	var keys []string
	if err := s.List(ctx, "replay/a/s1/", func(o ObjectInfo) error { keys = append(keys, o.Key); return nil }); err != nil {
		t.Fatal(err)
	}
	if want := []string{"replay/a/s1/.put-1111", "replay/a/s1/000000.json.gz"}; !slices.Equal(keys, want) {
		t.Fatalf("listed %v, want %v: a stale temporary file is listed, a fresh one is not", keys, want)
	}
	for _, k := range keys {
		if err := s.Delete(ctx, k); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, ".put-1111")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the stale temporary file survived: %v", err)
	}
}

func TestFileStoreDeleteKeepsSymlinkedDirectories(t *testing.T) {
	root, target := t.TempDir(), t.TempDir()
	if err := os.Symlink(target, filepath.Join(root, "replay")); err != nil {
		t.Fatal(err)
	}
	s, err := NewFileStore(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := os.MkdirAll(filepath.Join(target, "a"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "a", "x"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "replay/a/x"); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Lstat(filepath.Join(root, "replay")); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the symbolic link was removed: %v", err)
	}
}

func TestFileStoreDeleteWithRelativeRoot(t *testing.T) {
	t.Chdir(t.TempDir())
	s, err := NewFileStore(".")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := s.Put(ctx, "replay/a/s1/x", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "replay/a/s1/x"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat("replay"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("emptied directories remain under a relative root: %v", err)
	}
	if _, err := os.Stat("."); err != nil {
		t.Fatal(err)
	}
}
