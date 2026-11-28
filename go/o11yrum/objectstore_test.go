package o11yrum

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
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
