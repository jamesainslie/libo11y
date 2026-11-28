package o11yrum

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

// Replay envelope bounds beyond the configured caps.
const (
	// maxReplayViews caps the views one segment lists.
	maxReplayViews = 200
	// maxReplayRequests caps the request spans one segment lists, as the
	// collector does.
	maxReplayRequests = 200
	// maxReplayIDLength caps a view ID.
	maxReplayIDLength = 128
)

var (
	recordingPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
	traceIDPattern   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	spanIDPattern    = regexp.MustCompile(`^[0-9a-f]{16}$`)
)

var (
	errEnvelope      = errors.New("malformed replay envelope")
	errTooManyEvents = errors.New("too many replay events")
)

// replayEnvelope is one decoded, validated segment: the envelope's own
// fields only, so an unknown field is never stored.
type replayEnvelope struct {
	recording string
	start     float64
	end       float64
	views     []any
	requests  []any
	events    []any
}

// serveReplay stores one session replay segment, POST /_o11y/v1/replay.
// It runs the edge and admission checks of the ingest path, scrubs the
// segment again whatever the client did (masking all text unless the
// operator set the app's replay.unmasked_text), corrects clock skew, and
// writes the segment and its metadata to the object store. Nothing here
// reads the client address beyond h.edge and h.clientInfo.
//
// Only kept sessions upload: the collector decides, since the gateway
// holds no session state.
func (h *Handler) serveReplay(w http.ResponseWriter, r *http.Request) {
	arrived := h.now()
	ctx := r.Context()
	q := r.URL.Query()
	service, session := q.Get("service"), q.Get("session")
	// The label is a configured app or "unknown", so it stays bounded.
	label := appUnknown
	if _, ok := h.apps[service]; ok {
		label = service
	}
	refuse := func(corsOrigins map[string]bool, rej rejection) {
		h.tel.replaySegment(ctx, label, outcomeRejected, rej.reason)
		h.reject(w, r, corsOrigins, rej)
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		refuse(h.origins, rejection{status: http.StatusMethodNotAllowed, reason: "method"})
		return
	}
	receiver, rej := h.edge(r)
	if rej != nil {
		refuse(h.origins, *rej)
		return
	}
	segment, ok := parseSegment(q.Get("segment"))
	if !ok || !validSessionID(session) {
		refuse(h.origins, rejection{status: http.StatusBadRequest, reason: "query"})
		return
	}
	a, rej := h.admitApp(r, service, false)
	if rej != nil {
		refuse(nil, *rej)
		return
	}
	if !a.cfg.Replay.Enabled {
		refuse(a.origins, rejection{status: http.StatusForbidden, reason: "replay_disabled"})
		return
	}
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		refuse(a.origins, rejection{status: http.StatusUnsupportedMediaType, reason: "content_type"})
		return
	}
	select {
	case h.replaySlots <- struct{}{}:
		defer func() { <-h.replaySlots }()
	default:
		refuse(a.origins, rejection{status: http.StatusServiceUnavailable, reason: "busy", retryAfter: time.Second})
		return
	}
	rc := h.cfg.Replay
	body, err := readCapped(r.Body, r.Header.Get("Content-Encoding"), rc.MaxBodyBytes, rc.MaxDecompressedBytes)
	if err != nil {
		refuse(a.origins, decodeRejection(err))
		return
	}
	env, err := decodeReplayEnvelope(body, rc.MaxEvents, h.cfg.Limits.MaxValueLength)
	switch {
	case errors.Is(err, errTooManyEvents):
		refuse(a.origins, rejection{status: http.StatusRequestEntityTooLarge, reason: "too_many_events"})
		return
	case err != nil:
		refuse(a.origins, rejection{status: http.StatusBadRequest, reason: "envelope"})
		return
	}
	mode := scrubStrict
	if a.cfg.Replay.UnmaskedText {
		mode = scrubTrust
	}
	events, dropped := scrubSegment(env.events, mode, a.policy.queryAllow)
	ci := h.clientInfo(r, receiver, arrived)
	offset := ci.skew.Milliseconds()
	env.shift(events, float64(offset))
	doc := map[string]any{
		"format":          1,
		"recording":       env.recording,
		"start":           env.start,
		"end":             env.end,
		"views":           env.views,
		"requests":        env.requests,
		"service":         service,
		"session":         session,
		"segment":         segment,
		"stored_at":       h.now().UnixMilli(),
		"clock_offset_ms": offset,
	}
	meta, gz, err := encodeReplay(doc, events)
	if err != nil {
		h.log.ErrorContext(ctx, "o11yrum: encoding a replay segment", slog.String(telApp, label), slog.Any("error", err))
		refuse(a.origins, rejection{status: http.StatusInternalServerError, reason: "encode"})
		return
	}
	// The segment goes first, so metadata never names a segment that is
	// not there. A retried upload overwrites both.
	for _, o := range []struct {
		key  string
		data []byte
	}{
		{replayKey(a.replayNS, session, segment), gz},
		{replayMetaKey(a.replayNS, session, segment), meta},
	} {
		if err := h.putReplay(ctx, o.key, o.data); err != nil {
			h.log.WarnContext(ctx, "o11yrum: storing a replay segment failed", slog.String(telApp, label), slog.Any("error", err))
			refuse(a.origins, rejection{status: http.StatusServiceUnavailable, reason: "store", retryAfter: storeRetryAfterDuration})
			return
		}
	}
	h.tel.replaySegment(ctx, label, outcomeAccepted, reasonOK)
	h.tel.replayBytes(ctx, label, int64(len(gz)))
	h.tel.replayDropped(ctx, label, dropped)
	setCORS(w, r, a.origins)
	w.WriteHeader(http.StatusNoContent)
}

// storeRetryAfterDuration is storeRetryAfter as a duration, for reject.
const storeRetryAfterDuration = 5 * time.Second

// putReplay writes one replay object, timing it.
func (h *Handler) putReplay(ctx context.Context, key string, data []byte) error {
	start := time.Now()
	err := h.store.Put(ctx, key, data)
	outcome := sinkOK
	if err != nil {
		outcome = sinkError
	}
	h.tel.replayStore(ctx, "put", outcome, time.Since(start))
	return err
}

// parseSegment reads the segment query parameter: one to six ASCII
// digits.
func parseSegment(s string) (int, bool) {
	if s == "" || len(s) > 6 {
		return 0, false
	}
	for i := range len(s) {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.Atoi(s)
	return n, err == nil && n <= maxReplaySegment
}

// decodeReplayEnvelope decodes and validates one segment envelope. Numbers
// stay json.Number for the scrubber. An events array longer than
// maxEvents is errTooManyEvents; anything else wrong is errEnvelope.
func decodeReplayEnvelope(body []byte, maxEvents, maxName int) (replayEnvelope, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return replayEnvelope{}, errEnvelope
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return replayEnvelope{}, errEnvelope // trailing data
	}
	m, ok := isObj(raw)
	if !ok {
		return replayEnvelope{}, errEnvelope
	}
	var env replayEnvelope
	format, ok1 := toNum(m["format"])
	env.recording, _ = m["recording"].(string)
	var ok2, ok3 bool
	env.start, ok2 = toNum(m["start"])
	env.end, ok3 = toNum(m["end"])
	if !ok1 || format != 1 || !recordingPattern.MatchString(env.recording) || !ok2 || !ok3 || env.start > env.end {
		return replayEnvelope{}, errEnvelope
	}
	var err error
	view := func(v obj) (obj, bool) { return replayView(v, maxName) }
	if env.views, err = replayList(m["views"], maxReplayViews, view); err != nil {
		return replayEnvelope{}, err
	}
	if env.requests, err = replayList(m["requests"], maxReplayRequests, replayRequest); err != nil {
		return replayEnvelope{}, err
	}
	events, ok := m["events"].([]any)
	if !ok {
		return replayEnvelope{}, errEnvelope
	}
	if len(events) > maxEvents {
		return replayEnvelope{}, errTooManyEvents
	}
	for _, e := range events {
		em, ok := isObj(e)
		if !ok {
			return replayEnvelope{}, errEnvelope
		}
		_, okType := toNum(em["type"])
		_, okTime := toNum(em["timestamp"])
		if !okType || !okTime {
			return replayEnvelope{}, errEnvelope
		}
	}
	env.events = events
	return env, nil
}

// replayList validates an array of at most limit objects with item, which
// returns the object reduced to its allowed fields.
func replayList(v any, limit int, item func(obj) (obj, bool)) ([]any, error) {
	l, ok := v.([]any)
	if !ok || len(l) > limit {
		return nil, errEnvelope
	}
	out := make([]any, 0, len(l))
	for _, x := range l {
		m, ok := isObj(x)
		if !ok {
			return nil, errEnvelope
		}
		kept, ok := item(m)
		if !ok {
			return nil, errEnvelope
		}
		out = append(out, kept)
	}
	return out, nil
}

// replayView keeps a view's ID, name, start and optional span context.
// The name is the route template (o11y.rum.view.name, public), never a
// URL; it is capped like any attribute value.
func replayView(m obj, maxName int) (obj, bool) {
	id, _ := m["id"].(string)
	name, _ := m["name"].(string)
	at, ok := toNum(m["at"])
	if id == "" || len(id) > maxReplayIDLength || len(name) > maxName || !ok {
		return nil, false
	}
	out := obj{"id": id, "name": name, "at": at}
	for key, pattern := range map[string]*regexp.Regexp{"trace_id": traceIDPattern, "span_id": spanIDPattern} {
		v, present := m[key]
		if !present {
			continue
		}
		s, ok := v.(string)
		if !ok || !pattern.MatchString(s) {
			return nil, false
		}
		out[key] = s
	}
	return out, true
}

// replayRequest keeps a request span's context and start.
func replayRequest(m obj) (obj, bool) {
	trace, _ := m["trace_id"].(string)
	span, _ := m["span_id"].(string)
	at, ok := toNum(m["at"])
	if !traceIDPattern.MatchString(trace) || !spanIDPattern.MatchString(span) || !ok {
		return nil, false
	}
	return obj{"trace_id": trace, "span_id": span, "at": at}, true
}

// shift moves every timestamp of a segment by offset milliseconds: the
// envelope's start and end, each view's and request's at, and each kept
// event's timestamp.
func (e *replayEnvelope) shift(events []any, offset float64) {
	if offset == 0 {
		return
	}
	e.start += offset
	e.end += offset
	for _, list := range [][]any{e.views, e.requests} {
		for _, x := range list {
			m := x.(obj)
			m["at"] = m["at"].(float64) + offset
		}
	}
	for _, x := range events {
		m := x.(obj)
		m["timestamp"] = m["timestamp"].(float64) + offset
	}
}

// encodeReplay returns the segment's metadata object (doc with
// event_count and bytes, and without events) and the gzipped segment
// (doc with events).
func encodeReplay(doc map[string]any, events []any) (meta, gz []byte, err error) {
	doc["events"] = events
	raw, err := json.Marshal(doc)
	if err != nil {
		return nil, nil, err
	}
	if gz, err = gzipBytes(raw); err != nil {
		return nil, nil, err
	}
	delete(doc, "events")
	doc["event_count"] = len(events)
	doc["bytes"] = len(gz)
	if meta, err = json.Marshal(doc); err != nil {
		return nil, nil, err
	}
	return meta, gz, nil
}
