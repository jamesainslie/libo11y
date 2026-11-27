package o11yrum

import (
	"errors"
	"time"
)

// SymbolicationConfig bounds the source map cache and the work done per
// stack.
type SymbolicationConfig struct {
	// CacheMaps caps the parsed maps held in memory. Default 64.
	CacheMaps int `yaml:"cache_maps"`
	// CacheBytes caps the memory parsed maps may hold. Default 268435456
	// (256 MiB).
	CacheBytes int64 `yaml:"cache_bytes"`
	// NegativeTTL is how long a map found missing or invalid is not
	// looked up again. Default 60s.
	NegativeTTL time.Duration `yaml:"negative_ttl"`
	// MaxFrames caps the frames of one stack that are symbolicated and
	// kept. Default 50.
	MaxFrames int `yaml:"max_frames"`
}

func (c *SymbolicationConfig) applyDefaults() {
	setDefault(&c.CacheMaps, 64)
	setDefault(&c.CacheBytes, 256<<20)
	if c.NegativeTTL == 0 {
		c.NegativeTTL = time.Minute
	}
	setDefault(&c.MaxFrames, 50)
}

func (c SymbolicationConfig) validate() error {
	switch {
	case c.CacheMaps <= 0:
		return errors.New("symbolication.cache_maps must be positive")
	case c.CacheBytes <= 0:
		return errors.New("symbolication.cache_bytes must be positive")
	case c.NegativeTTL < 0:
		return errors.New("symbolication.negative_ttl must not be negative")
	case c.MaxFrames <= 0:
		return errors.New("symbolication.max_frames must be positive")
	}
	return nil
}

// symbolicator resolves minified stack frames through uploaded source
// maps. A nil symbolicator does nothing.
type symbolicator struct{}

// invalidate forgets what the cache holds for key, so a new upload is
// read on the next lookup.
func (s *symbolicator) invalidate(string) {
	if s == nil {
		return
	}
}
