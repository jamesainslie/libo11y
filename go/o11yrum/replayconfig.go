package o11yrum

import (
	"errors"
	"fmt"
	"net"
	"regexp"
	"time"
)

// ReplayConfig configures the session replay endpoint, POST
// /_o11y/v1/replay. Replay is off for every app until its
// apps[].replay.enabled is set.
type ReplayConfig struct {
	// MaxBodyBytes caps one segment upload as sent. Default 1048576
	// (1 MiB).
	MaxBodyBytes int64 `yaml:"max_body_bytes"`
	// MaxDecompressedBytes caps one segment upload after gzip. Default
	// 16777216 (16 MiB).
	MaxDecompressedBytes int64 `yaml:"max_decompressed_bytes"`
	// MaxEvents caps the rrweb events of one segment. Default 20000.
	MaxEvents int `yaml:"max_events"`
	// MaxConcurrent caps the segments one gateway decodes and scrubs at
	// once. A decoded segment takes many times its size in memory, so
	// this bounds the memory replay can use. A segment past the cap
	// answers 503 with Retry-After: 1. Default 8.
	MaxConcurrent int `yaml:"max_concurrent"`
	// Retention is how long a stored segment is kept. The read API never
	// serves a segment stored longer ago than this, even when deletion
	// lags, and the sweeper deletes replay objects older than this.
	// Default 720h (30 days).
	Retention time.Duration `yaml:"retention"`
	// SweepInterval is how often the gateway deletes replay objects past
	// the retention. The sweeper runs for any object store that can list
	// and delete, whether or not an app records now, so recordings kept
	// from before replay was switched off still expire. Nil takes the default,
	// 1h. Zero (sweep_interval: 0s) disables the sweeper, for a store
	// that expires objects itself, such as an S3 bucket with a lifecycle
	// rule on the replay/ prefix. The first pass runs one interval after
	// the handler starts.
	SweepInterval *time.Duration `yaml:"sweep_interval"`
	// ReadListen is the address the o11yrum-gateway command serves the
	// replay read API on: listing a session's segments, reading one and
	// erasing a session. Empty, the default, serves no read API. The read
	// API is cluster-internal only: it must never be exposed through the
	// public /_o11y/ path or the ingest address, so it cannot be the
	// listen address, and the ingress in front of the gateway must not
	// route to it. It needs ReadTokenFile. The library checks it against
	// Listen but does not serve it; see Handler.ReplayReadHandler.
	ReadListen string `yaml:"read_listen"`
	// ReadTokenFile holds the bearer tokens the read API accepts, one per
	// line. Blank lines and lines starting with # are ignored, and each
	// token must be at least 16 visible ASCII characters, with no space.
	// Without it, every read API
	// request answers 401.
	ReadTokenFile string `yaml:"read_token_file"`
}

// Replay retention defaults.
const (
	defaultReplayRetention = 720 * time.Hour
	defaultSweepInterval   = time.Hour
)

// AppReplay configures one app's session replay.
type AppReplay struct {
	// Enabled accepts replay segments for the app. Default false.
	Enabled bool `yaml:"enabled"`
	// Namespace is the object key segment the app's recordings are kept
	// under. Default service_name. It must match
	// [A-Za-z0-9][A-Za-z0-9._+-]*, up to 128 characters.
	Namespace string `yaml:"namespace"`
	// UnmaskedText keeps the text the app's client recorded. By default
	// the gateway masks all text whatever the client sent, so an app's
	// code-level unmask allow-list takes effect only once the operator
	// sets this too. Input values and the attribute allow-list are
	// enforced either way.
	UnmaskedText bool `yaml:"unmasked_text"`
}

// applyDefaults fills zero fields.
func (r *ReplayConfig) applyDefaults() {
	setDefault(&r.MaxBodyBytes, 1<<20)
	setDefault(&r.MaxDecompressedBytes, 16<<20)
	setDefault(&r.MaxEvents, 20000)
	setDefault(&r.MaxConcurrent, 8)
	if r.Retention == 0 {
		r.Retention = defaultReplayRetention
	}
	if r.SweepInterval == nil {
		every := defaultSweepInterval
		r.SweepInterval = &every
	}
}

// sweepEvery is the sweep interval, 0 when the sweeper is off.
func (r ReplayConfig) sweepEvery() time.Duration {
	if r.SweepInterval == nil {
		return defaultSweepInterval
	}
	return *r.SweepInterval
}

// validate refuses caps that are not positive or that contradict each
// other.
func (r ReplayConfig) validate() error {
	for _, f := range []struct {
		name string
		v    int64
	}{
		{"replay.max_body_bytes", r.MaxBodyBytes},
		{"replay.max_decompressed_bytes", r.MaxDecompressedBytes},
		{"replay.max_events", int64(r.MaxEvents)},
		{"replay.max_concurrent", int64(r.MaxConcurrent)},
	} {
		if f.v <= 0 {
			return fmt.Errorf("%s must be positive", f.name)
		}
	}
	if r.MaxDecompressedBytes < r.MaxBodyBytes {
		return errors.New("replay.max_decompressed_bytes must be at least max_body_bytes")
	}
	if r.Retention <= 0 {
		return errors.New("replay.retention must be positive")
	}
	if r.sweepEvery() < 0 {
		return errors.New("replay.sweep_interval must not be negative")
	}
	return nil
}

// validateRead checks the read listener against the ingest address
// listen. The read API serves recordings and erases them, so it must
// never share the public listener.
func (r ReplayConfig) validateRead(listen string) error {
	if r.ReadListen == "" {
		return nil
	}
	if r.ReadTokenFile == "" {
		return errors.New("replay.read_listen needs replay.read_token_file")
	}
	rh, rp, err := net.SplitHostPort(r.ReadListen)
	if err != nil {
		return fmt.Errorf("replay.read_listen %q: %w", r.ReadListen, err)
	}
	lh, lp, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("listen %q: %w", listen, err)
	}
	if rp == lp && rp != "0" && (rh == lh || wildcardHost(rh) || wildcardHost(lh)) {
		return fmt.Errorf("replay.read_listen %q overlaps listen %q: the read API must have its own address, never the ingest one", r.ReadListen, listen)
	}
	return nil
}

// wildcardHost reports whether a listen host binds every interface.
func wildcardHost(h string) bool {
	if h == "" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsUnspecified()
}

// replayNamespace returns the key segment the app's recordings are kept
// under, or "" when the app has none usable.
func (a AppConfig) replayNamespace() string {
	if a.Replay.Namespace != "" {
		return a.Replay.Namespace
	}
	if validSegment(a.ServiceName) {
		return a.ServiceName
	}
	return ""
}

// validateAppReplay checks that an app recording replays has a usable
// namespace.
func validateAppReplay(a AppConfig) error {
	r := a.Replay
	if r.Namespace != "" && !validSegment(r.Namespace) {
		return fmt.Errorf("replay.namespace %q must match %s", r.Namespace, segmentPattern)
	}
	if r.Enabled && a.replayNamespace() == "" {
		return fmt.Errorf("service_name %q cannot be an object key segment; set replay.namespace", a.ServiceName)
	}
	return nil
}

// sessionIDPattern is a session.id as the RUM clients mint it: a
// lowercase UUID.
var sessionIDPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// validSessionID reports whether s is a lowercase UUID, which makes it a
// safe object key segment.
func validSessionID(s string) bool { return sessionIDPattern.MatchString(s) }

// maxReplaySegment is the largest segment index a key can hold.
const maxReplaySegment = 999999

// replayPrefix is the key prefix of one session's recording.
func replayPrefix(namespace, session string) string {
	return "replay/" + namespace + "/" + session + "/"
}

// replayKey is the object key of one stored segment.
func replayKey(namespace, session string, segment int) string {
	return fmt.Sprintf("%s%06d.json.gz", replayPrefix(namespace, session), segment)
}

// replayMetaKey is the object key of one segment's metadata.
func replayMetaKey(namespace, session string, segment int) string {
	return fmt.Sprintf("%s%06d.meta.json", replayPrefix(namespace, session), segment)
}

// replayEnabled reports whether any app records replays.
func (c *Config) replayEnabled() bool {
	for _, a := range c.Apps {
		if a.Replay.Enabled {
			return true
		}
	}
	return false
}

// checkReplayStore checks the object store can hold recordings. Replay needs
// List and Delete for the read API, erasure and retention.
func checkReplayStore(store ObjectStore) error {
	if store == nil {
		return errors.New("o11yrum: replay needs an object store")
	}
	if _, ok := store.(ObjectLister); !ok {
		return errors.New("o11yrum: replay needs an object store with List and Delete")
	}
	if _, ok := store.(ObjectDeleter); !ok {
		return errors.New("o11yrum: replay needs an object store with List and Delete")
	}
	return nil
}
