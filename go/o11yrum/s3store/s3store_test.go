package s3store

import (
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/jamesainslie/libo11y/go/o11yrum"
)

const noSuchKey = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>`

// fakeS3 is a path-style S3 endpoint that keeps objects in memory and
// records the headers of each PUT.
type fakeS3 struct {
	mu      sync.Mutex
	objects map[string][]byte
	puts    []http.Header
	fail    bool
	deletes int
	pages   int
}

// listPageSize is the fake's ListObjectsV2 page size, small so a test
// crosses pages.
const listPageSize = 2

// list answers ListObjectsV2 for the bucket in the path, in key order,
// paged at listPageSize keys. The continuation token is the last key of
// the previous page. f.mu is held.
func (f *fakeS3) list(w http.ResponseWriter, r *http.Request) {
	f.pages++
	bucket := "/" + strings.Trim(r.URL.Path, "/") + "/"
	q := r.URL.Query()
	prefix, after := q.Get("prefix"), q.Get("continuation-token")
	var keys []string
	for p := range f.objects {
		if k, ok := strings.CutPrefix(p, bucket); ok && strings.HasPrefix(k, prefix) && k > after {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	truncated := len(keys) > listPageSize
	if truncated {
		keys = keys[:listPageSize]
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`)
	fmt.Fprintf(&b, "<Name>%s</Name><Prefix>%s</Prefix><KeyCount>%d</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>%t</IsTruncated>",
		strings.Trim(bucket, "/"), prefix, len(keys), truncated)
	for _, k := range keys {
		fmt.Fprintf(&b, "<Contents><Key>%s</Key><LastModified>2026-11-27T10:00:00.000Z</LastModified><Size>%d</Size></Contents>",
			k, len(f.objects[bucket+k]))
	}
	if truncated {
		fmt.Fprintf(&b, "<NextContinuationToken>%s</NextContinuationToken>", keys[len(keys)-1])
	}
	b.WriteString("</ListBucketResult>")
	w.Header().Set("Content-Type", "application/xml")
	_, _ = io.WriteString(w, b.String())
}

func newFake(t *testing.T) (*s3.Client, *fakeS3) {
	t.Helper()
	f := &fakeS3{objects: map[string][]byte{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.fail {
			w.Header().Set("Content-Type", "application/xml")
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`)
			return
		}
		switch r.Method {
		case http.MethodPut:
			b, _ := io.ReadAll(r.Body)
			f.objects[r.URL.Path] = b
			f.puts = append(f.puts, r.Header.Clone())
		case http.MethodGet:
			if r.URL.Query().Get("list-type") == "2" {
				f.list(w, r)
				return
			}
			b, ok := f.objects[r.URL.Path]
			if !ok {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, noSuchKey)
				return
			}
			_, _ = w.Write(b)
		case http.MethodDelete:
			f.deletes++
			delete(f.objects, r.URL.Path)
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	t.Cleanup(srv.Close)
	client := s3.New(s3.Options{
		Region:                     "us-east-1",
		BaseEndpoint:               aws.String(srv.URL),
		UsePathStyle:               true,
		Credentials:                aws.AnonymousCredentials{},
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
		RetryMaxAttempts:           1,
	})
	return client, f
}

func TestStoreRoundTrip(t *testing.T) {
	client, f := newFake(t)
	s := NewWithClient(client, "maps", "o11yrum/")
	ctx := context.Background()
	if _, err := s.Get(ctx, "sourcemaps/a/1/_/x.map"); !errors.Is(err, o11yrum.ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if err := s.Put(ctx, "sourcemaps/a/1/_/x.map", []byte(`{"version":3}`)); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	stored, ok := f.objects["/maps/o11yrum/sourcemaps/a/1/_/x.map"]
	keys := slices.Collect(maps.Keys(f.objects))
	put := f.puts[0]
	f.mu.Unlock()
	if !ok {
		t.Fatalf("stored under %v", keys)
	}
	if string(stored) != `{"version":3}` {
		t.Fatalf("stored body %q: a chunked or framed body means the checksum options were not applied", stored)
	}
	if ct := put.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content type %q", ct)
	}
	got, err := s.Get(ctx, "sourcemaps/a/1/_/x.map")
	if err != nil || string(got) != `{"version":3}` {
		t.Fatalf("%q %v", got, err)
	}
}

func TestStoreErrorsAreNotNotFound(t *testing.T) {
	client, f := newFake(t)
	f.fail = true
	s := NewWithClient(client, "maps", "")
	_, err := s.Get(context.Background(), "k")
	if err == nil || errors.Is(err, o11yrum.ErrNotFound) {
		t.Fatalf("access denied read as %v", err)
	}
	if !strings.Contains(err.Error(), "s3store") {
		t.Fatalf("error %q does not name the store", err)
	}
	if err := s.Put(context.Background(), "k", []byte("x")); err == nil {
		t.Fatal("failed put reported success")
	}
}

func TestStoreSatisfiesInterface(t *testing.T) {
	var _ o11yrum.ObjectStore = (*Store)(nil)
}

func TestNewValidates(t *testing.T) {
	if _, err := New(context.Background(), Config{}); err == nil {
		t.Fatal("empty bucket accepted")
	}
}

func TestNewUsesEndpointAndPathStyle(t *testing.T) {
	// Static credentials from the environment keep the default chain from
	// reaching for instance metadata; no request leaves the test.
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")
	t.Setenv("AWS_CONFIG_FILE", "/nonexistent")
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent")
	var path string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		if r.Header.Get("Authorization") == "" {
			t.Error("request was not signed")
		}
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()
	s, err := New(context.Background(), Config{Bucket: "maps", Prefix: "p/", Region: "eu-west-1", Endpoint: srv.URL, UsePathStyle: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(context.Background(), "k.map"); err != nil {
		t.Fatal(err)
	}
	if path != "/maps/p/k.map" {
		t.Fatalf("path %q", path)
	}
}

func TestStoreListAcrossPages(t *testing.T) {
	client, f := newFake(t)
	s := NewWithClient(client, "maps", "o11yrum/")
	ctx := context.Background()
	keys := []string{"replay/a/s1/000004", "replay/a/s1/000000", "replay/a/s1/000003", "replay/a/s1/000001", "replay/a/s1/000002"}
	for _, k := range keys {
		if err := s.Put(ctx, k, []byte("xyz")); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Put(ctx, "replay/a/s2/000000", []byte("x")); err != nil {
		t.Fatal(err)
	}
	var got []string
	err := s.List(ctx, "replay/a/s1/", func(o o11yrum.ObjectInfo) error {
		got = append(got, o.Key)
		if o.Size != 3 || !o.Modified.Equal(time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)) {
			t.Errorf("%s: size %d modified %v", o.Key, o.Size, o.Modified)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := slices.Clone(keys)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("list %v, want %v", got, want)
	}
	f.mu.Lock()
	pages := f.pages
	f.mu.Unlock()
	if pages != 3 {
		t.Fatalf("%d pages, want 3", pages)
	}
	stop := errors.New("stop")
	calls := 0
	if err := s.List(ctx, "replay/", func(o11yrum.ObjectInfo) error { calls++; return stop }); !errors.Is(err, stop) || calls != 1 {
		t.Fatalf("fn error: %d calls, %v", calls, err)
	}
	var _ o11yrum.ObjectLister = s
}

func TestStoreDelete(t *testing.T) {
	client, f := newFake(t)
	s := NewWithClient(client, "maps", "o11yrum/")
	ctx := context.Background()
	if err := s.Put(ctx, "replay/a/s1/000000", []byte("x")); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "replay/a/s1/000000"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, "replay/a/s1/000000"); !errors.Is(err, o11yrum.ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
	if err := s.Delete(ctx, "replay/a/s1/000000"); err != nil {
		t.Fatalf("deleting a missing key: %v", err)
	}
	f.mu.Lock()
	f.fail = true
	f.mu.Unlock()
	if err := s.Delete(ctx, "k"); err == nil || !strings.Contains(err.Error(), "s3store") {
		t.Fatalf("failed delete: %v", err)
	}
	if err := s.List(ctx, "", func(o11yrum.ObjectInfo) error { return nil }); err == nil || !strings.Contains(err.Error(), "s3store") {
		t.Fatalf("failed list: %v", err)
	}
	var _ o11yrum.ObjectDeleter = s
}
