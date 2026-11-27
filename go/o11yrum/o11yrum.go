package o11yrum

import (
	"errors"
	"fmt"
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
	tel     *telemetry
	configs ConfigProvider
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
	// The handler keeps its own copy, with defaults applied, so a Config
	// built in code works like a parsed one and later changes to it cannot
	// race with requests.
	cfg := s.cfg.clone()
	cfg.applyDefaults()
	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("o11yrum: config: %w", err)
	}
	trust, err := newProxyTrust(cfg.Edge)
	if err != nil {
		return nil, err
	}
	h := &Handler{
		cfg:     cfg,
		apps:    make(map[string]*app, len(cfg.Apps)),
		origins: map[string]bool{},
		trust:   trust,
		keyer:   newClientKeyer(),
		limit:   newLimiter(cfg.Edge.RateLimitPerMinute, cfg.Edge.MaxTrackedClients, s.now),
		now:     s.now,
		log:     slog.Default(),
	}
	if s.sdk != nil {
		h.log = s.sdk.Logger()
		h.tel = newTelemetry(s.sdk.MeterProvider(), h.log)
	} else {
		h.tel = newTelemetry(nil, nil)
	}
	h.sinks = make([]Sink, len(s.sinks))
	for i, sink := range s.sinks {
		h.sinks[i] = timedSink{Sink: sink, tel: h.tel}
	}
	h.configs = s.configs
	if h.configs == nil {
		if h.configs, err = newRemoteConfigProvider(cfg, s.now, h.log); err != nil {
			return nil, err
		}
	}
	for _, ac := range cfg.Apps {
		a := &app{cfg: ac, origins: map[string]bool{}, policy: newAttrPolicy(ac, cfg.Limits)}
		for _, o := range ac.Origins {
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
	case pathPrefix + "config":
		h.serveConfig(w, r)
	default:
		http.NotFound(w, r)
	}
}
