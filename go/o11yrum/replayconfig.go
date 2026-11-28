package o11yrum

import (
	"errors"
	"fmt"
	"regexp"
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
}

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
	} {
		if f.v <= 0 {
			return fmt.Errorf("%s must be positive", f.name)
		}
	}
	if r.MaxDecompressedBytes < r.MaxBodyBytes {
		return errors.New("replay.max_decompressed_bytes must be at least max_body_bytes")
	}
	return nil
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

// replayStore checks the object store can hold recordings. Replay needs
// List and Delete for the read API, erasure and retention.
func replayStore(store ObjectStore) error {
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
