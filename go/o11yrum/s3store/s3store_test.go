package s3store

import (
	"context"
	"errors"
	"io"
	"maps"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

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
			b, ok := f.objects[r.URL.Path]
			if !ok {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(http.StatusNotFound)
				_, _ = io.WriteString(w, noSuchKey)
				return
			}
			_, _ = w.Write(b)
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
