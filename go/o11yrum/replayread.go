package o11yrum

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"
)

// minReadTokenLength is the shortest bearer token the read API accepts.
const minReadTokenLength = 16

// Read API operations and outcomes, for o11yrum.replay.reads.
const (
	readOpList   = "list"
	readOpGet    = "get"
	readOpDelete = "delete"
	readOpOther  = "other"

	readOK           = "ok"
	readUnauthorized = "unauthorized"
	readBadRequest   = "bad_request"
	readNotFound     = "not_found"
	readError        = "error"
)

// Read API routes. The patterns name the operation each serves.
const (
	routeList   = "GET /v1/replay/{service}/sessions/{session}"
	routeGet    = "GET /v1/replay/{service}/sessions/{session}/segments/{segment}"
	routeDelete = "DELETE /v1/replay/{service}/sessions/{session}"
)

var routeOps = map[string]string{routeList: readOpList, routeGet: readOpGet, routeDelete: readOpDelete}

// replayReader serves the replay read API. It is built once in NewHandler.
type replayReader struct {
	h   *Handler
	mux *http.ServeMux
	// tokens are the SHA-256 sums of the accepted bearer tokens. With
	// none, every request answers 401.
	tokens [][32]byte
}

// ReplayReadHandler returns the session replay read API, for a player
// backend to call server side:
//
//	GET    /v1/replay/{service}/sessions/{session}                    the session's segment metadata
//	GET    /v1/replay/{service}/sessions/{session}/segments/{segment} one gzipped segment
//	DELETE /v1/replay/{service}/sessions/{session}                    erase the session
//
// Every request needs Authorization: Bearer with a token from
// replay.read_token_file, and without that file every request answers
// 401. The read API is cluster-internal only. Serve it on its own
// listener, never on the address that serves ServeHTTP and never through
// the ingress that routes /_o11y/ to the gateway: ServeHTTP does not serve
// it. The o11yrum-gateway command serves it on replay.read_listen.
//
// A segment stored longer ago than replay.retention is never served, even
// while its objects remain. Erasure removes every object under the
// session, expired or not, for apps that record and for configured apps
// that have stopped, and is idempotent.
func (h *Handler) ReplayReadHandler() http.Handler { return h.reader }

// newReplayReader loads the read tokens and builds the routes.
func newReplayReader(h *Handler, tokenFile string) (*replayReader, error) {
	rr := &replayReader{h: h, mux: http.NewServeMux()}
	if tokenFile != "" {
		if err := checkReplayStore(h.store); err != nil {
			return nil, fmt.Errorf("%w (replay.read_token_file is set)", err)
		}
		var err error
		if rr.tokens, err = loadReadTokens(tokenFile); err != nil {
			return nil, fmt.Errorf("o11yrum: %w", err)
		}
	}
	rr.mux.HandleFunc(routeList, rr.list)
	rr.mux.HandleFunc(routeGet, rr.get)
	rr.mux.HandleFunc(routeDelete, rr.erase)
	return rr, nil
}

// loadReadTokens reads the token file: one token per line, blank lines and
// lines starting with # ignored. Errors name the file and line, never a
// token.
func loadReadTokens(path string) ([][32]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("replay.read_token_file: %w", err)
	}
	var sums [][32]byte
	sc := bufio.NewScanner(bytes.NewReader(raw))
	for line := 1; sc.Scan(); line++ {
		token := strings.TrimSpace(sc.Text())
		if token == "" || strings.HasPrefix(token, "#") {
			continue
		}
		if len(token) < minReadTokenLength {
			return nil, fmt.Errorf("replay.read_token_file %s: the token on line %d is shorter than %d characters", path, line, minReadTokenLength)
		}
		sums = append(sums, sha256.Sum256([]byte(token)))
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("replay.read_token_file %s: %w", path, err)
	}
	if len(sums) == 0 {
		return nil, fmt.Errorf("replay.read_token_file %s holds no token", path)
	}
	return sums, nil
}

// authorized reports whether the request carries one of the tokens. Every
// token is compared, in constant time over SHA-256 sums, so the answer's
// timing does not depend on which token matched or on its length.
func (rr *replayReader) authorized(r *http.Request) bool {
	scheme, token, ok := strings.Cut(r.Header.Get("Authorization"), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || len(rr.tokens) == 0 {
		return false
	}
	got := sha256.Sum256([]byte(strings.TrimSpace(token)))
	match := 0
	for _, want := range rr.tokens {
		match |= subtle.ConstantTimeCompare(got[:], want[:])
	}
	return match == 1
}

// ServeHTTP authenticates every request before routing it, so nothing on
// the listener, not even which routes exist, answers without a token.
func (rr *replayReader) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, pattern := rr.mux.Handler(r)
	op, ok := routeOps[pattern]
	if !ok {
		op = readOpOther
	}
	if !rr.authorized(r) {
		rr.h.tel.replayRead(r.Context(), op, readUnauthorized)
		w.Header().Set("WWW-Authenticate", `Bearer realm="o11yrum-replay"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if op == readOpOther {
		rr.h.tel.replayRead(r.Context(), op, readNotFound)
	}
	rr.mux.ServeHTTP(w, r)
}

// session resolves the service and session path values to the session's
// key prefix. erase is true for erasure, which also serves configured apps
// that have stopped recording. It answers the refusal itself and returns
// ok false.
func (rr *replayReader) session(w http.ResponseWriter, r *http.Request, op string, erase bool) (prefix string, ok bool) {
	service, session := r.PathValue("service"), r.PathValue("session")
	if !validSessionID(session) {
		rr.refuse(w, r, op, http.StatusBadRequest, "session must be a lowercase UUID")
		return "", false
	}
	a := rr.h.apps[service]
	ns := ""
	switch {
	case a == nil:
	case a.cfg.Replay.Enabled:
		ns = a.replayNS
	case erase:
		ns = a.cfg.replayNamespace()
	}
	if ns == "" {
		rr.refuse(w, r, op, http.StatusNotFound, "not found")
		return "", false
	}
	return replayPrefix(ns, session), true
}

// refuse answers a refusal and counts it.
func (rr *replayReader) refuse(w http.ResponseWriter, r *http.Request, op string, status int, msg string) {
	outcome := readError
	switch status {
	case http.StatusBadRequest:
		outcome = readBadRequest
	case http.StatusNotFound:
		outcome = readNotFound
	case http.StatusServiceUnavailable:
		w.Header().Set("Retry-After", storeRetryAfter)
	}
	rr.h.tel.replayRead(r.Context(), op, outcome)
	http.Error(w, msg, status)
}

// storeFailed logs a store error without the session or any token, and
// answers 503.
func (rr *replayReader) storeFailed(w http.ResponseWriter, r *http.Request, op string, err error) {
	rr.h.log.WarnContext(r.Context(), "o11yrum: replay read API store operation failed",
		slog.String(telOperation, op), slog.String(telApp, r.PathValue("service")), slog.Any("error", err))
	rr.refuse(w, r, op, http.StatusServiceUnavailable, "store unavailable")
}

// replayMeta is the part of a segment's metadata the read API checks.
type replayMeta struct {
	Segment  *int64 `json:"segment"`
	StoredAt *int64 `json:"stored_at"`
}

// fresh reports whether a stored metadata object parses and is inside the
// retention at now. Anything else fails closed.
func (rr *replayReader) fresh(raw []byte, now time.Time) (segment int64, ok bool) {
	var m replayMeta
	if err := json.Unmarshal(raw, &m); err != nil || m.Segment == nil || m.StoredAt == nil {
		return 0, false
	}
	cutoff := now.Add(-rr.h.cfg.Replay.Retention).UnixMilli()
	return *m.Segment, *m.StoredAt > cutoff
}

// list answers a session's unexpired segment metadata, sorted by segment.
func (rr *replayReader) list(w http.ResponseWriter, r *http.Request) {
	prefix, ok := rr.session(w, r, readOpList, false)
	if !ok {
		return
	}
	ctx := r.Context()
	var keys []string
	err := rr.h.listReplay(ctx, prefix, func(o ObjectInfo) error {
		if strings.HasSuffix(o.Key, ".meta.json") {
			keys = append(keys, o.Key)
		}
		return nil
	})
	if err != nil {
		rr.storeFailed(w, r, readOpList, err)
		return
	}
	type entry struct {
		segment int64
		raw     json.RawMessage
	}
	now := rr.h.now()
	var segs []entry
	for _, key := range keys {
		raw, err := rr.h.getReplay(ctx, key)
		if errors.Is(err, ErrNotFound) {
			continue // deleted since it was listed
		}
		if err != nil {
			rr.storeFailed(w, r, readOpList, err)
			return
		}
		if seg, ok := rr.fresh(raw, now); ok {
			segs = append(segs, entry{segment: seg, raw: raw})
		}
	}
	if len(segs) == 0 {
		rr.refuse(w, r, readOpList, http.StatusNotFound, "not found")
		return
	}
	slices.SortFunc(segs, func(a, b entry) int { return int(a.segment - b.segment) })
	out := make([]json.RawMessage, len(segs))
	for i, s := range segs {
		out[i] = s.raw
	}
	rr.writeJSON(w, r, readOpList, http.StatusOK, map[string]any{
		"service": r.PathValue("service"), "session": r.PathValue("session"), "segments": out,
	})
}

// get answers one unexpired segment as stored: a gzipped JSON envelope.
// The store labels objects application/json whatever they hold, so the
// encoding is set here.
func (rr *replayReader) get(w http.ResponseWriter, r *http.Request) {
	prefix, ok := rr.session(w, r, readOpGet, false)
	if !ok {
		return
	}
	segment, ok := parseSegment(r.PathValue("segment"))
	if !ok {
		rr.refuse(w, r, readOpGet, http.StatusBadRequest, "segment must be 0 to 999999")
		return
	}
	ctx := r.Context()
	// The metadata is read first: it holds stored_at, so a segment whose
	// metadata is missing, unreadable or expired is never served.
	meta, err := rr.h.getReplay(ctx, fmt.Sprintf("%s%06d.meta.json", prefix, segment))
	if err == nil {
		var data []byte
		if seg, fresh := rr.fresh(meta, rr.h.now()); !fresh || seg != int64(segment) {
			err = ErrNotFound
		} else if data, err = rr.h.getReplay(ctx, fmt.Sprintf("%s%06d.json.gz", prefix, segment)); err == nil {
			h := w.Header()
			h.Set("Content-Type", "application/json")
			h.Set("Content-Encoding", "gzip")
			h.Set("Content-Length", strconv.Itoa(len(data)))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
			rr.h.tel.replayRead(ctx, readOpGet, readOK)
			return
		}
	}
	if errors.Is(err, ErrNotFound) {
		rr.refuse(w, r, readOpGet, http.StatusNotFound, "not found")
		return
	}
	rr.storeFailed(w, r, readOpGet, err)
}

// erase deletes every object under the session, expired or not, and
// answers how many it removed and which segments they held. It is the
// primitive for a subject access or erasure request. Erasing a session
// with nothing stored answers 200 with deleted 0. On a store error it
// answers 503 with what it removed so far; a retry finishes the job.
func (rr *replayReader) erase(w http.ResponseWriter, r *http.Request) {
	prefix, ok := rr.session(w, r, readOpDelete, true)
	if !ok {
		return
	}
	ctx := r.Context()
	var keys []string
	if err := rr.h.listReplay(ctx, prefix, func(o ObjectInfo) error {
		keys = append(keys, o.Key)
		return nil
	}); err != nil {
		rr.storeFailed(w, r, readOpDelete, err)
		return
	}
	deleted := 0
	segments := []int{}
	var failed error
	for _, key := range keys {
		if err := rr.h.deleteReplay(ctx, key); err != nil {
			failed = err
			continue
		}
		deleted++
		if name, ok := strings.CutSuffix(strings.TrimPrefix(key, prefix), ".json.gz"); ok {
			if n, ok := parseSegment(name); ok {
				segments = append(segments, n)
			}
		}
	}
	slices.Sort(segments)
	body := map[string]any{
		"service": r.PathValue("service"), "session": r.PathValue("session"),
		"deleted": deleted, "segments": segments,
	}
	if failed != nil {
		rr.h.log.WarnContext(ctx, "o11yrum: replay erasure incomplete",
			slog.String(telApp, r.PathValue("service")), slog.Int("o11yrum.deleted", deleted),
			slog.Int("o11yrum.remaining", len(keys)-deleted), slog.Any("error", failed))
		w.Header().Set("Retry-After", storeRetryAfter)
		rr.writeJSON(w, r, readOpDelete, http.StatusServiceUnavailable, body)
		return
	}
	rr.writeJSON(w, r, readOpDelete, http.StatusOK, body)
}

// writeJSON answers v as JSON and counts the request.
func (rr *replayReader) writeJSON(w http.ResponseWriter, r *http.Request, op string, status int, v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		rr.refuse(w, r, op, http.StatusInternalServerError, "encoding failed")
		return
	}
	outcome := readOK
	if status != http.StatusOK {
		outcome = readError
	}
	rr.h.tel.replayRead(r.Context(), op, outcome)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

// listReplay lists replay objects, timing it.
func (h *Handler) listReplay(ctx context.Context, prefix string, fn func(ObjectInfo) error) error {
	start := time.Now()
	err := h.store.(ObjectLister).List(ctx, prefix, fn)
	h.tel.replayStore(ctx, "list", storeOutcome(err), time.Since(start))
	return err
}

// getReplay reads one replay object, timing it. A missing object is not a
// store error.
func (h *Handler) getReplay(ctx context.Context, key string) ([]byte, error) {
	start := time.Now()
	data, err := h.store.Get(ctx, key)
	outcome := storeOutcome(err)
	if errors.Is(err, ErrNotFound) {
		outcome = sinkOK
	}
	h.tel.replayStore(ctx, "get", outcome, time.Since(start))
	return data, err
}

// deleteReplay deletes one replay object, timing it.
func (h *Handler) deleteReplay(ctx context.Context, key string) error {
	start := time.Now()
	err := h.store.(ObjectDeleter).Delete(ctx, key)
	h.tel.replayStore(ctx, "delete", storeOutcome(err), time.Since(start))
	return err
}

// storeOutcome is the o11yrum.outcome of one store operation.
func storeOutcome(err error) string {
	if err != nil {
		return sinkError
	}
	return sinkOK
}
