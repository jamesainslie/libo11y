package o11yrum

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/sourcemap"
)

// Upload outcomes recorded in o11yrum.sourcemaps.uploads.
const (
	uploadStored       = "stored"
	uploadUnauthorized = "unauthorized"
	uploadRateLimited  = "rate_limited"
	uploadBadRequest   = "bad_request"
	uploadInvalid      = "invalid"
	uploadStoreError   = "store_error"
)

// storeRetryAfter is the Retry-After sent when the object store fails.
const storeRetryAfter = "5"

// serveUpload stores one source map. The map is checked by parsing it,
// stored under the key symbolication looks it up by, and never served
// back: the endpoint accepts only POST, and no other endpoint reads the
// store for a client.
//
// Authenticated uploads are not rate limited, so a build uploading many
// maps is never refused. Every failed authentication is charged to the
// client's rate limit, which bounds token guessing.
func (h *Handler) serveUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
		return
	}
	q := r.URL.Query()
	a := h.apps[q.Get("service")]
	if a == nil || a.uploadToken == nil || !bearerMatches(r.Header.Get("Authorization"), a.uploadToken) {
		h.refuseUpload(w, r, a)
		return
	}
	ctx := r.Context()
	label := a.cfg.ServiceName
	version, updateID := q.Get("version"), q.Get("update_id")
	script := normalizeScriptPath(q.Get("url"))
	if !validSegment(version) || (updateID != "" && !validSegment(updateID)) || script == "" {
		h.tel.upload(ctx, label, uploadBadRequest)
		http.Error(w, "version, url and optional update_id are required; version and update_id are [A-Za-z0-9._+-], up to 128 characters", http.StatusBadRequest)
		return
	}
	limit := h.cfg.Sourcemaps.MaxUploadBytes
	body, err := readCapped(r.Body, r.Header.Get("Content-Encoding"), limit, limit)
	if err != nil {
		h.tel.upload(ctx, label, uploadBadRequest)
		status := http.StatusBadRequest
		switch {
		case errors.Is(err, errTooLarge), errors.Is(err, errDecompressedTooLarge):
			status = http.StatusRequestEntityTooLarge
			err = fmt.Errorf("the source map is larger than %d bytes", limit)
		case errors.Is(err, errEncoding):
			status = http.StatusUnsupportedMediaType
		}
		http.Error(w, err.Error(), status)
		return
	}
	if _, err := sourcemap.Parse(body, sourcemap.Limits{}); err != nil {
		h.tel.upload(ctx, label, uploadInvalid)
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	key := sourcemapKey(a.namespace, version, updateID, script)
	if err := h.store.Put(ctx, key, body); err != nil {
		h.log.WarnContext(ctx, "o11yrum: storing a source map failed",
			slog.String(telApp, label), slog.Any("error", err))
		h.tel.upload(ctx, label, uploadStoreError)
		w.Header().Set("Retry-After", storeRetryAfter)
		http.Error(w, "store unavailable", http.StatusServiceUnavailable)
		return
	}
	h.symbols.invalidate(key)
	h.tel.upload(ctx, label, uploadStored)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"key": key})
}

// refuseUpload answers a failed authentication with 401, or 429 once the
// client has spent its rate limit. The response is the same for an
// unknown app, an app without uploads and a wrong token, so it reveals
// nothing about which apps exist.
func (h *Handler) refuseUpload(w http.ResponseWriter, r *http.Request, a *app) {
	label := appUnknown
	if a != nil {
		label = a.cfg.ServiceName
	}
	if key, _, ok := h.clientKey(r); ok {
		if allowed, wait := h.limit.allow(key); !allowed {
			h.tel.upload(r.Context(), label, uploadRateLimited)
			secs := max(1, int64(math.Ceil(wait.Seconds())))
			w.Header().Set("Retry-After", strconv.FormatInt(secs, 10))
			http.Error(w, http.StatusText(http.StatusTooManyRequests), http.StatusTooManyRequests)
			return
		}
	}
	h.tel.upload(r.Context(), label, uploadUnauthorized)
	w.Header().Set("WWW-Authenticate", "Bearer")
	http.Error(w, http.StatusText(http.StatusUnauthorized), http.StatusUnauthorized)
}

// bearerMatches compares the presented bearer token with the configured
// one in constant time, over their SHA-256 sums so the comparison does
// not leak the token's length either.
func bearerMatches(header string, want *[32]byte) bool {
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return false
	}
	got := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return subtle.ConstantTimeCompare(got[:], want[:]) == 1
}

// loadUploadToken reads an app's upload token file. The token is the
// file's content with surrounding white space removed.
func loadUploadToken(path string) (*[32]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("sourcemaps.upload_token_file: %w", err)
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return nil, fmt.Errorf("sourcemaps.upload_token_file %s is empty", path)
	}
	sum := sha256.Sum256([]byte(token))
	return &sum, nil
}
