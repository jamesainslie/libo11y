package o11yrum

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"net/http"
	"net/netip"
	"strconv"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog/plogotlp"
	"go.opentelemetry.io/collector/pdata/pmetric/pmetricotlp"
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
// rate limit, decoding, app admission, validation, enrichment and export.
// Each stage is a method so later stages slot in without restructuring.
func (h *Handler) ingest(w http.ResponseWriter, r *http.Request, sig Signal) {
	arrived := h.now()
	rep := newBatchReport()
	defer func() { h.tel.report(r.Context(), sig, rep) }()
	refuse := func(corsOrigins map[string]bool, rej rejection) {
		rep.reject(rej.reason)
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
	d, err := decodeBody(sig, r.Header.Get("Content-Type"), r.Header.Get("Content-Encoding"),
		r.Body, h.cfg.Edge.MaxBodyBytes, h.cfg.Edge.MaxDecompressedBytes)
	if err != nil {
		refuse(h.origins, decodeRejection(err))
		return
	}
	service, err := batchService(sig, d)
	if err != nil {
		reason := "mixed_service"
		if errors.Is(err, errMissingService) {
			reason = "missing_service"
		}
		refuse(h.origins, rejection{status: http.StatusBadRequest, reason: reason})
		return
	}
	if service == "" { // an empty batch
		rep.accept(nil)
		h.respond(w, r, h.origins, sig, d.json, nil)
		return
	}
	if _, ok := h.apps[service]; ok {
		rep.app = service
	}
	a, rej := h.admit(r, service)
	if rej != nil {
		refuse(nil, *rej)
		return
	}
	ci := h.clientInfo(r, receiver, arrived)
	v := &validator{policy: a.policy, limits: h.cfg.Limits}
	var drops dropCounts
	var remaining int
	b := Batch{Service: service, Signal: sig}
	switch sig {
	case SignalTraces:
		drops = v.traces(d.traces)
		enrich(sig, d, ci)
		remaining = d.traces.SpanCount()
		d.traces.MarkReadOnly()
		b.Traces = d.traces
	case SignalLogs:
		drops = v.logs(d.logs)
		enrich(sig, d, ci)
		remaining = d.logs.LogRecordCount()
		d.logs.MarkReadOnly()
		b.Logs = d.logs
	case SignalMetrics:
		// App metrics never reach the sinks: they are re-aggregated into
		// the gateway's own metrics, or dropped without a producer.
		drops = v.metrics(d.metrics)
		if h.derive == nil {
			drops[reasonNoProducer] += metricPoints(d.metrics)
			break
		}
		for reason, n := range h.derive.appMetrics(service, d.metrics) {
			drops[reason] += n
		}
	}
	rep.validated(drops, v.attrsRemoved)
	if remaining > 0 {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), sinkTimeout)
		defer cancel()
		if err := exportAll(ctx, h.sinks, b); err != nil {
			h.log.WarnContext(ctx, "o11yrum: sink export failed",
				slog.String("o11yrum.app", service), slog.Any("error", err))
			refuse(a.origins, rejection{status: http.StatusServiceUnavailable, reason: "sink", retryAfter: sinkRetryAfter})
			return
		}
		// Derivation runs only once the sinks hold the batch: a 503 makes
		// the client retry it, and counting it first would count it twice.
		h.derived(b)
	}
	rep.accept(drops)
	h.respond(w, r, a.origins, sig, d.json, drops)
}

// edge runs the checks every endpoint applies before reading the body:
// the client address and the rate limit. It returns the proxy hop that
// received the client's connection, for the country header.
func (h *Handler) edge(r *http.Request) (netip.Addr, *rejection) {
	key, receiver, ok := h.clientKey(r)
	if !ok {
		return netip.Addr{}, &rejection{status: http.StatusBadRequest, reason: "client_address"}
	}
	if ok, wait := h.limit.allow(key); !ok {
		return netip.Addr{}, &rejection{status: http.StatusTooManyRequests, reason: "rate_limited", retryAfter: wait}
	}
	return receiver, nil
}

// clientKey resolves the client address and returns its rate-limit key
// and the proxy hop that received the client's connection (invalid for a
// direct connection). The client address never leaves this function, which
// keeps the privacy invariant structural: no later stage can see it.
func (h *Handler) clientKey(r *http.Request) (key uint64, receiver netip.Addr, ok bool) {
	client, receiver, ok := h.trust.resolve(r)
	if !ok {
		return 0, netip.Addr{}, false
	}
	return h.keyer.key(client), receiver, true
}

var (
	errMixedService   = errors.New("resources disagree on service.name")
	errMissingService = errors.New("a resource has no single string service.name")
)

// batchService returns the one service.name every resource carries, or ""
// for a batch with no resources. A missing, repeated, non-string or
// differing value is an error. A repeated key matters because pdata keeps
// both values and readers disagree on which one wins.
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
		if !ok || v.Type() != pcommon.ValueTypeStr || v.Str() == "" || countKey(res.Attributes(), keyServiceName) > 1 {
			return "", errMissingService
		}
		if service != "" && v.Str() != service {
			return "", errMixedService
		}
		service = v.Str()
	}
	return service, nil
}

// countKey counts the occurrences of k in m. pdata keeps duplicate keys
// from the wire, so it can exceed one.
func countKey(m pcommon.Map, k string) int {
	n := 0
	for key := range m.All() {
		if key == k {
			n++
		}
	}
	return n
}

// admit identifies the app and checks the request may send for it.
func (h *Handler) admit(r *http.Request, service string) (*app, *rejection) {
	return h.admitApp(r, service, false)
}

// admitApp identifies the app and checks the request may use it. With
// originOptional, a request without an Origin header passes the origin
// check, as same-origin GETs send none.
func (h *Handler) admitApp(r *http.Request, service string, originOptional bool) (*app, *rejection) {
	a, ok := h.apps[service]
	if !ok {
		return nil, &rejection{status: http.StatusForbidden, reason: "unknown_service"}
	}
	if a.cfg.Disabled {
		return nil, &rejection{status: http.StatusForbidden, reason: "disabled"}
	}
	switch o := normalizeOrigin(r.Header.Get("Origin")); {
	case o == "" && !a.cfg.AllowMissingOrigin && !originOptional:
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
	case SignalMetrics:
		mr := pmetricotlp.NewExportResponse()
		if n := drops.total(); n > 0 {
			mr.PartialSuccess().SetRejectedDataPoints(n)
			mr.PartialSuccess().SetErrorMessage(drops.message())
		}
		resp = mr
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
	hdr.Set("Access-Control-Allow-Headers", "Content-Type, Content-Encoding, Authorization, If-None-Match")
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
