package o11yrum

import (
	"time"

	o11y "github.com/jamesainslie/libo11y/go"
)

// Option configures NewHandler.
type Option func(*settings)

type settings struct {
	cfg   *Config
	sdk   *o11y.SDK
	sinks []Sink
	now   func() time.Time
}

// WithConfig sets the gateway configuration. NewHandler requires it.
func WithConfig(cfg *Config) Option {
	return func(s *settings) { s.cfg = cfg }
}

// WithSDK sets the libo11y SDK the gateway logs through. Without it the
// gateway logs to slog.Default.
func WithSDK(sdk *o11y.SDK) Option {
	return func(s *settings) { s.sdk = sdk }
}

// WithSinks adds sinks that receive every processed batch. It may be given
// more than once; the sinks accumulate.
func WithSinks(sinks ...Sink) Option {
	return func(s *settings) { s.sinks = append(s.sinks, sinks...) }
}

// WithClock sets the clock the gateway reads, for tests. nil keeps
// time.Now.
func WithClock(now func() time.Time) Option {
	return func(s *settings) {
		if now != nil {
			s.now = now
		}
	}
}
