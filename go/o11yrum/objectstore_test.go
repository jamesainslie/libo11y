package o11yrum

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeScriptPath(t *testing.T) {
	for in, want := range map[string]string{
		"https://shop.example/assets/app-3f2a.js?v=1#x": "/assets/app-3f2a.js",
		"https://shop.example:8443/assets/app.js":       "/assets/app.js",
		"chrome-extension://abcdef/js/content.js":       "/js/content.js",
		"/assets/app.js":                                "/assets/app.js",
		"/assets/app.js?v=2":                            "/assets/app.js",
		"~/assets/app.js":                               "/assets/app.js",
		"assets/app.js":                                 "/assets/app.js",
		"index.android.bundle":                          "/index.android.bundle",
		"app:///index.android.bundle":                   "/index.android.bundle",
		"/a/../b/./c.js":                                "/b/c.js",
		"https://shop.example/a%20b.js":                 "/a b.js",
		"/a%20b.js":                                     "/a b.js",
		"":                                              "",
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
