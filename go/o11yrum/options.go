package o11yrum

import (
	"time"

	o11y "github.com/jamesainslie/libo11y/go"
)

// Option configures NewHandler.
type Option func(*settings)

type settings struct {
	cfg     *Config
	sdk     *o11y.SDK
	sinks   []Sink
	now     func() time.Time
	configs ConfigProvider

	producer *MetricProducer
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
// more than once; the sinks accumulate. nil sinks are skipped.
func WithSinks(sinks ...Sink) Option {
	return func(s *settings) {
		for _, sink := range sinks {
			if sink != nil {
				s.sinks = append(s.sinks, sink)
			}
		}
	}
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

// WithConfigProvider sets where remote configuration comes from. Without
// it the gateway serves each app's remote_config_file.
func WithConfigProvider(p ConfigProvider) Option {
	return func(s *settings) { s.configs = p }
}
