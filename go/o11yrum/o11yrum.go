package o11yrum

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// pathPrefix is where every gateway endpoint lives.
const pathPrefix = "/_o11y/v1/"

// Handler serves the gateway's endpoints under /_o11y/v1/.
type Handler struct {
	cfg     *Config
	apps    map[string]*app
	origins map[string]bool // union of every app's origins, for preflight
	trust   proxyTrust
	keyer   clientKeyer
	limit   *limiter
	sinks   []Sink
	now     func() time.Time
	log     *slog.Logger
}

// app is one configured app with its lookups prepared.
type app struct {
	cfg     AppConfig
	origins map[string]bool
	policy  attrPolicy
}

// NewHandler builds a gateway handler. WithConfig is required. Without
// WithSDK the gateway logs to slog.Default. Without any sink, traces and
// logs are dropped after processing.
func NewHandler(opts ...Option) (*Handler, error) {
	s := settings{now: time.Now}
	for _, o := range opts {
		o(&s)
	}
	if s.cfg == nil {
		return nil, errors.New("o11yrum: NewHandler needs WithConfig")
	}
	trust, err := newProxyTrust(s.cfg.Edge)
	if err != nil {
		return nil, err
	}
	h := &Handler{
		cfg:     s.cfg,
		apps:    make(map[string]*app, len(s.cfg.Apps)),
		origins: map[string]bool{},
		trust:   trust,
		keyer:   newClientKeyer(),
		limit:   newLimiter(s.cfg.Edge.RateLimitPerMinute, s.cfg.Edge.MaxTrackedClients, s.now),
		sinks:   s.sinks,
		now:     s.now,
		log:     slog.Default(),
	}
	if s.sdk != nil {
		h.log = s.sdk.Logger()
	}
	for _, ac := range s.cfg.Apps {
		a := &app{cfg: ac, origins: map[string]bool{}, policy: newAttrPolicy(ac, s.cfg.Limits)}
		for _, o := range ac.Origins {
			o = normalizeOrigin(o)
			a.origins[o] = true
			h.origins[o] = true
		}
		h.apps[ac.ServiceName] = a
	}
	return h, nil
}

// Close releases background resources. It is safe to call more than once.
func (h *Handler) Close() error { return nil }

// ServeHTTP routes a request to its endpoint.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, pathPrefix) {
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodOptions {
		h.preflight(w, r)
		return
	}
	switch r.URL.Path {
	case pathPrefix + "traces":
		h.ingest(w, r, SignalTraces)
	case pathPrefix + "logs":
		h.ingest(w, r, SignalLogs)
	default:
		http.NotFound(w, r)
	}
}
