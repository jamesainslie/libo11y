package o11yrum

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// RemoteConfig is one app's remote configuration. The gateway does not
// read the document; the client SDK owns its keys.
type RemoteConfig struct {
	// Version identifies the document. It is sent as the ETag.
	Version string
	// Document is a JSON object.
	Document json.RawMessage
}

// ErrNoRemoteConfig is what a ConfigProvider returns for an app that has
// no remote configuration. The gateway answers 404.
var ErrNoRemoteConfig = errors.New("o11yrum: no remote configuration")

// ConfigProvider supplies remote configuration by service.name. Any error
// other than ErrNoRemoteConfig makes the gateway answer 503.
type ConfigProvider interface {
	// RemoteConfig returns the configuration of service, or
	// ErrNoRemoteConfig when it has none.
	RemoteConfig(ctx context.Context, service string) (RemoteConfig, error)
}

// FileConfigProvider serves each app's remote configuration from a JSON
// file. It re-reads a file at most every 10 seconds, and only when its size
// or modification time changed, which picks up a Kubernetes ConfigMap
// update. A file that stops parsing keeps the last good version.
type FileConfigProvider struct {
	mu    sync.Mutex
	now   func() time.Time
	files map[string]*configFile
	warn  func(service string, err error) // reports a failed reload; may be nil
}

var _ ConfigProvider = (*FileConfigProvider)(nil)

type configFile struct {
	path    string
	checked time.Time // last time the file was looked at
	modTime time.Time // of the last version read, good or bad
	size    int64
	current RemoteConfig
}

// reloadEvery is how often a file is checked for changes.
const reloadEvery = 10 * time.Second

// maxRemoteConfigBytes caps a remote configuration file. Clients fetch it
// on every page load.
const maxRemoteConfigBytes = 1 << 20

// NewFileConfigProvider reads files, a map from service.name to the path
// of its JSON object file. Every file must exist and hold a JSON object.
// now is the clock for reload checks; nil means time.Now.
func NewFileConfigProvider(files map[string]string, now func() time.Time) (*FileConfigProvider, error) {
	if now == nil {
		now = time.Now
	}
	p := &FileConfigProvider{now: now, files: make(map[string]*configFile, len(files))}
	for service, path := range files {
		f := &configFile{path: path}
		if err := f.load(now()); err != nil {
			return nil, fmt.Errorf("o11yrum: remote config for %s: %w", service, err)
		}
		p.files[service] = f
	}
	return p, nil
}

// RemoteConfig returns the current configuration of service, or
// ErrNoRemoteConfig.
func (p *FileConfigProvider) RemoteConfig(_ context.Context, service string) (RemoteConfig, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	f, ok := p.files[service]
	if !ok {
		return RemoteConfig{}, ErrNoRemoteConfig
	}
	now := p.now()
	if now.Sub(f.checked) >= reloadEvery {
		f.checked = now
		st, err := os.Stat(f.path)
		switch {
		case err != nil:
			p.report(service, err)
		case !st.ModTime().Equal(f.modTime) || st.Size() != f.size:
			if err := f.load(now); err != nil {
				p.report(service, err)
			}
		}
	}
	return f.current, nil
}

func (p *FileConfigProvider) report(service string, err error) {
	if p.warn != nil {
		p.warn(service, err)
	}
}

// load reads the file. On failure the current version stays, and the
// file's size and modification time are still recorded, so an unchanged
// broken file is not read again.
func (f *configFile) load(now time.Time) error {
	st, err := os.Stat(f.path)
	if err != nil {
		return err
	}
	f.modTime, f.size, f.checked = st.ModTime(), st.Size(), now
	if st.Size() > maxRemoteConfigBytes {
		return fmt.Errorf("%s is larger than %d bytes", f.path, maxRemoteConfigBytes)
	}
	raw, err := os.ReadFile(f.path)
	if err != nil {
		return err
	}
	if err := checkJSONObject(raw); err != nil {
		return fmt.Errorf("%s must hold a JSON object: %w", f.path, err)
	}
	sum := sha256.Sum256(raw)
	f.current = RemoteConfig{Version: hex.EncodeToString(sum[:8]), Document: json.RawMessage(raw)}
	return nil
}

// checkJSONObject reports whether raw is exactly one JSON object.
func checkJSONObject(raw []byte) error {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return err
	}
	if obj == nil {
		return errors.New("null is not an object")
	}
	return nil
}

// newRemoteConfigProvider builds the default provider from the apps'
// remote_config_file settings, with failed reloads logged to log.
func newRemoteConfigProvider(cfg *Config, now func() time.Time, log *slog.Logger) (*FileConfigProvider, error) {
	files := map[string]string{}
	for _, a := range cfg.Apps {
		if a.RemoteConfigFile != "" {
			files[a.ServiceName] = cfg.resolvePath(a.RemoteConfigFile)
		}
	}
	p, err := NewFileConfigProvider(files, now)
	if err != nil {
		return nil, err
	}
	p.warn = func(service string, err error) {
		log.Warn("o11yrum: reloading the remote configuration failed; serving the last good version",
			slog.String("o11yrum.app", service), slog.Any("error", err))
	}
	return p, nil
}

// remoteConfigBody is the JSON the config endpoint serves.
type remoteConfigBody struct {
	Version string          `json:"version"`
	Config  json.RawMessage `json:"config"`
}

// serveConfig answers GET /_o11y/v1/config?service=<service.name>.
func (h *Handler) serveConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, OPTIONS")
		h.reject(w, r, h.origins, rejection{status: http.StatusMethodNotAllowed, reason: "method"})
		return
	}
	if _, rej := h.edge(r); rej != nil {
		h.reject(w, r, h.origins, *rej)
		return
	}
	service := r.URL.Query().Get("service")
	if service == "" {
		h.reject(w, r, h.origins, rejection{status: http.StatusBadRequest, reason: "missing_service"})
		return
	}
	// A same-origin GET sends no Origin header, so only a present one is
	// checked.
	a, rej := h.admitApp(r, service, true)
	if rej != nil {
		h.reject(w, r, nil, *rej)
		return
	}
	rc, err := h.configs.RemoteConfig(r.Context(), service)
	switch {
	case errors.Is(err, ErrNoRemoteConfig):
		h.reject(w, r, a.origins, rejection{status: http.StatusNotFound, reason: "no_remote_config"})
		return
	case err != nil:
		h.log.WarnContext(r.Context(), "o11yrum: remote configuration lookup failed",
			slog.String("o11yrum.app", service), slog.Any("error", err))
		h.reject(w, r, a.origins, rejection{status: http.StatusServiceUnavailable, reason: "config_provider", retryAfter: sinkRetryAfter})
		return
	}
	setCORS(w, r, a.origins)
	hdr := w.Header()
	if hdr.Get("Access-Control-Allow-Origin") != "" {
		hdr.Set("Access-Control-Expose-Headers", "ETag, Retry-After")
	}
	etag := `"` + rc.Version + `"`
	hdr.Set("ETag", etag)
	hdr.Set("Cache-Control", "no-cache")
	if etagMatches(r.Header.Values("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	body, err := json.Marshal(remoteConfigBody{Version: rc.Version, Config: rc.Document})
	if err != nil {
		h.log.ErrorContext(r.Context(), "o11yrum: encoding the remote configuration",
			slog.String("o11yrum.app", service), slog.Any("error", err))
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	hdr.Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

// etagMatches applies If-None-Match's weak comparison: any listed tag,
// with or without W/, or *, matches.
func etagMatches(values []string, etag string) bool {
	for _, v := range values {
		for tag := range strings.SplitSeq(v, ",") {
			tag = strings.TrimSpace(tag)
			if tag == "*" || strings.TrimPrefix(tag, "W/") == etag {
				return true
			}
		}
	}
	return false
}
