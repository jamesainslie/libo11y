package o11yrum

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
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
	// store and symbols are nil without an object store.
	store   ObjectStore
	symbols *symbolicator
	// replaySlots holds one token per replay segment being handled.
	replaySlots chan struct{}
	// reader serves the replay read API on its own listener.
	reader *replayReader

	// derive is nil without WithMetricProducer.
	derive           *deriver
	unregisterDerive func() error
	closeOnce        sync.Once
	closeErr         error
}

// app is one configured app with its lookups prepared.
type app struct {
	cfg     AppConfig
	origins map[string]bool
	policy  attrPolicy
	// namespace is the key segment of the app's source maps, "" when the
	// app has none usable.
	namespace string
	// uploadToken is the SHA-256 of the app's upload token, nil when the
	// app accepts no uploads.
	uploadToken *[32]byte
	// replayNS is the key segment of the app's recordings, "" when the app
	// records none.
	replayNS string
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
	if h.store, err = objectStore(cfg, s.store); err != nil {
		return nil, err
	}
	if cfg.replayEnabled() {
		if err := checkReplayStore(h.store); err != nil {
			return nil, err
		}
	}
	h.replaySlots = make(chan struct{}, cfg.Replay.MaxConcurrent)
	if h.reader, err = newReplayReader(h, cfg.resolvePath(cfg.Replay.ReadTokenFile)); err != nil {
		return nil, err
	}
	if h.store != nil {
		h.symbols = newSymbolicator(h.store, cfg.Symbolication, symbolicatorDeps{
			maxValueLen: cfg.Limits.MaxValueLength,
			maxMapBytes: cfg.Sourcemaps.MaxUploadBytes,
			tel:         h.tel,
			log:         h.log,
			now:         s.now,
		})
	}
	for _, ac := range cfg.Apps {
		a := &app{cfg: ac, origins: map[string]bool{}, policy: newAttrPolicy(ac, cfg.Limits), namespace: ac.namespace()}
		for _, o := range ac.Origins {
			a.origins[o] = true
			h.origins[o] = true
		}
		if ac.Sourcemaps.UploadTokenFile != "" {
			if h.store == nil {
				return nil, fmt.Errorf("o11yrum: app %s: sourcemaps.upload_token_file needs an object store", ac.ServiceName)
			}
			if a.uploadToken, err = loadUploadToken(cfg.resolvePath(ac.Sourcemaps.UploadTokenFile)); err != nil {
				return nil, fmt.Errorf("o11yrum: app %s: %w", ac.ServiceName, err)
			}
		}
		if ac.Replay.Enabled {
			a.replayNS = ac.replayNamespace()
		}
		h.apps[ac.ServiceName] = a
	}
	if s.producer != nil {
		if h.derive, h.unregisterDerive, err = newDeriver(s.producer, s.sdk, cfg, s.now); err != nil {
			return nil, err
		}
	}
	return h, nil
}

// objectStore returns the store given through WithObjectStore, else the
// filesystem store the configuration names, else nil.
func objectStore(cfg *Config, given ObjectStore) (ObjectStore, error) {
	switch oc := cfg.ObjectStore; {
	case given != nil:
		return given, nil
	case oc.S3 != nil:
		return nil, errors.New("o11yrum: object_store.s3 needs a store built with the s3store package, passed through WithObjectStore")
	case oc.Filesystem != nil:
		return NewFileStore(cfg.resolvePath(oc.Filesystem.Root))
	}
	return nil, nil
}

// Close releases background resources. It is safe to call more than once.
func (h *Handler) Close() error {
	h.closeOnce.Do(func() {
		if h.unregisterDerive != nil {
			h.closeErr = h.unregisterDerive()
		}
	})
	return h.closeErr
}

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
	case pathPrefix + "metrics":
		h.ingest(w, r, SignalMetrics)
	case pathPrefix + "sourcemaps":
		if h.store == nil {
			http.NotFound(w, r)
			return
		}
		h.serveUpload(w, r)
	case pathPrefix + "replay":
		if h.store == nil {
			http.NotFound(w, r)
			return
		}
		h.serveReplay(w, r)
	default:
		http.NotFound(w, r)
	}
}
