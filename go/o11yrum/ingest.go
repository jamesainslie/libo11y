package o11yrum

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/ptrace/ptraceotlp"
)

// sinkTimeout bounds export. The context survives the client going away,
// because a beacon's sender never sees the response anyway.
const sinkTimeout = 10 * time.Second

// sinkRetryAfter is the Retry-After sent when a sink fails.
const sinkRetryAfter = 5 * time.Second

// rejection is a refused request: its status, the reason recorded in
// self-telemetry, and an optional Retry-After.
type rejection struct {
	status     int
	reason     string
	retryAfter time.Duration
}

// ingest runs one OTLP request through the pipeline: client address,
// rate limit, decoding, app admission, validation and export. Each stage
// is a method so later stages slot in without restructuring.
func (h *Handler) ingest(w http.ResponseWriter, r *http.Request, sig Signal) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		h.reject(w, r, h.origins, rejection{status: http.StatusMethodNotAllowed, reason: "method"})
		return
	}
	key, ok := h.clientKey(r)
	if !ok {
		h.reject(w, r, h.origins, rejection{status: http.StatusBadRequest, reason: "client_address"})
		return
	}
	if ok, wait := h.limit.allow(key); !ok {
		h.reject(w, r, h.origins, rejection{status: http.StatusTooManyRequests, reason: "rate_limited", retryAfter: wait})
		return
	}
	d, err := decodeBody(sig, r.Header.Get("Content-Type"), r.Header.Get("Content-Encoding"),
		r.Body, h.cfg.Edge.MaxBodyBytes, h.cfg.Edge.MaxDecompressedBytes)
	if err != nil {
		h.reject(w, r, h.origins, decodeRejection(err))
		return
	}
	service, err := batchService(sig, d)
	if err != nil {
		h.reject(w, r, h.origins, rejection{status: http.StatusBadRequest, reason: "mixed_service"})
		return
	}
	if service == "" { // an empty batch
		h.respond(w, r, h.origins, sig, d.json, nil)
		return
	}
	a, rej := h.admit(r, service)
	if rej != nil {
		h.reject(w, r, nil, *rej)
		return
	}
	v := &validator{policy: a.policy, limits: h.cfg.Limits}
	var drops dropCounts
	var remaining int
	b := Batch{Service: service, Signal: sig}
	switch sig {
	case SignalTraces:
		drops = v.traces(d.traces)
		remaining = d.traces.SpanCount()
		d.traces.MarkReadOnly()
		b.Traces = d.traces
	case SignalLogs:
		drops = v.logs(d.logs)
		remaining = d.logs.LogRecordCount()
		d.logs.MarkReadOnly()
		b.Logs = d.logs
	}
	if remaining > 0 {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), sinkTimeout)
		defer cancel()
		if err := exportAll(ctx, h.sinks, b); err != nil {
			h.log.WarnContext(ctx, "o11yrum: sink export failed",
				slog.String("o11yrum.app", service), slog.Any("error", err))
			h.reject(w, r, a.origins, rejection{status: http.StatusServiceUnavailable, reason: "sink", retryAfter: sinkRetryAfter})
			return
		}
	}
	h.respond(w, r, a.origins, sig, d.json, drops)
}

// clientKey resolves the client address and returns its rate-limit key.
// The address never leaves this function, which keeps the privacy
// invariant structural: no later stage can see it.
func (h *Handler) clientKey(r *http.Request) (uint64, bool) {
	client, _, ok := h.trust.resolve(r)
	if !ok {
		return 0, false
	}
	return h.keyer.key(client), true
}

var errMixedService = errors.New("resources disagree on service.name")

// batchService returns the one service.name every resource carries, or ""
// for a batch with no resources. A missing, non-string or differing value
// is an error.
func batchService(sig Signal, d decoded) (string, error) {
	var resources []pcommon.Resource
	switch sig {
	case SignalTraces:
		for i := range d.traces.ResourceSpans().Len() {
			resources = append(resources, d.traces.ResourceSpans().At(i).Resource())
		}
	case SignalLogs:
		for i := range d.logs.ResourceLogs().Len() {
			resources = append(resources, d.logs.ResourceLogs().At(i).Resource())
		}
	case SignalMetrics:
		for i := range d.metrics.ResourceMetrics().Len() {
			resources = append(resources, d.metrics.ResourceMetrics().At(i).Resource())
		}
	}
	service := ""
	for _, res := range resources {
		v, ok := res.Attributes().Get(keyServiceName)
		if !ok || v.Type() != pcommon.ValueTypeStr || v.Str() == "" {
			return "", errMixedService
		}
		if service != "" && v.Str() != service {
			return "", errMixedService
		}
		service = v.Str()
	}
	return service, nil
}

// admit identifies the app and checks the request may send for it.
func (h *Handler) admit(r *http.Request, service string) (*app, *rejection) {
	a, ok := h.apps[service]
	if !ok {
		return nil, &rejection{status: http.StatusForbidden, reason: "unknown_service"}
	}
	if a.cfg.Disabled {
		return nil, &rejection{status: http.StatusForbidden, reason: "disabled"}
	}
	switch o := normalizeOrigin(r.Header.Get("Origin")); {
	case o == "" && !a.cfg.AllowMissingOrigin:
		return nil, &rejection{status: http.StatusForbidden, reason: "origin"}
	case o != "" && !a.origins[o]:
		return nil, &rejection{status: http.StatusForbidden, reason: "origin"}
	}
	// The token is public, so a plain comparison is enough.
	if a.cfg.ClientToken != "" && r.URL.Query().Get("client_token") != a.cfg.ClientToken {
		return nil, &rejection{status: http.StatusForbidden, reason: "client_token"}
	}
	return a, nil
}

// decodeRejection maps a decodeBody error to its response.
func decodeRejection(err error) rejection {
	switch {
	case errors.Is(err, errContentType):
		return rejection{status: http.StatusUnsupportedMediaType, reason: "content_type"}
	case errors.Is(err, errEncoding):
		return rejection{status: http.StatusUnsupportedMediaType, reason: "content_encoding"}
	case errors.Is(err, errTooLarge):
		return rejection{status: http.StatusRequestEntityTooLarge, reason: "too_large"}
	case errors.Is(err, errDecompressedTooLarge):
		return rejection{status: http.StatusRequestEntityTooLarge, reason: "decompressed_too_large"}
	default:
		return rejection{status: http.StatusBadRequest, reason: "decode"}
	}
}

// reject writes a refusal. CORS headers are set when the request's origin
// is in corsOrigins, so a browser can read the status and Retry-After;
// pass nil when the origin itself was refused.
func (h *Handler) reject(w http.ResponseWriter, r *http.Request, corsOrigins map[string]bool, rej rejection) {
	setCORS(w, r, corsOrigins)
	if rej.retryAfter > 0 {
		secs := max(1, int64(math.Ceil(rej.retryAfter.Seconds())))
		w.Header().Set("Retry-After", strconv.FormatInt(secs, 10))
	}
	http.Error(w, http.StatusText(rej.status), rej.status)
}

// respond writes the OTLP export response in the request's encoding, with
// a partial success when records were dropped.
func (h *Handler) respond(w http.ResponseWriter, r *http.Request, corsOrigins map[string]bool, sig Signal, isJSON bool, drops dropCounts) {
	var resp otlpResponse
	switch sig {
	case SignalTraces:
		tr := ptraceotlp.NewExportResponse()
		if n := drops.total(); n > 0 {
			tr.PartialSuccess().SetRejectedSpans(n)
			tr.PartialSuccess().SetErrorMessage(drops.message())
		}
		resp = tr
	default:
		lr := plogotlp.NewExportResponse()
		if n := drops.total(); n > 0 {
			lr.PartialSuccess().SetRejectedLogRecords(n)
			lr.PartialSuccess().SetErrorMessage(drops.message())
		}
		resp = lr
	}
	ctype := "application/x-protobuf"
	marshal := resp.MarshalProto
	if isJSON {
		ctype = "application/json"
		marshal = resp.MarshalJSON
	}
	body, err := marshal()
	if err != nil {
		h.log.ErrorContext(r.Context(), "o11yrum: encoding the export response", slog.Any("error", err))
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	setCORS(w, r, corsOrigins)
	w.Header().Set("Content-Type", ctype)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// otlpResponse is the marshalling half of the pdata export responses.
type otlpResponse interface {
	MarshalJSON() ([]byte, error)
	MarshalProto() ([]byte, error)
}

// preflight answers a CORS preflight for any origin some app allows.
func (h *Handler) preflight(w http.ResponseWriter, r *http.Request) {
	if !h.origins[normalizeOrigin(r.Header.Get("Origin"))] {
		http.Error(w, http.StatusText(http.StatusForbidden), http.StatusForbidden)
		return
	}
	setCORS(w, r, h.origins)
	hdr := w.Header()
	hdr.Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
	hdr.Set("Access-Control-Allow-Headers", "Content-Type, Content-Encoding, Authorization")
	hdr.Set("Access-Control-Max-Age", "86400")
	w.WriteHeader(http.StatusNoContent)
}

// setCORS allows the request's origin to read the response when it is in
// allowed. The header echoes the origin exactly as the browser sent it.
func setCORS(w http.ResponseWriter, r *http.Request, allowed map[string]bool) {
	origin := r.Header.Get("Origin")
	if origin == "" || !allowed[normalizeOrigin(origin)] {
		return
	}
	hdr := w.Header()
	hdr.Set("Access-Control-Allow-Origin", origin)
	hdr.Set("Access-Control-Expose-Headers", "Retry-After")
	hdr.Add("Vary", "Origin")
}
