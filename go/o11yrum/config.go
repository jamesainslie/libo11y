package o11yrum

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is the gateway configuration, read from one YAML file. Zero
// numeric fields take the documented defaults.
type Config struct {
	Edge   EdgeConfig   `yaml:"edge"`
	Limits LimitsConfig `yaml:"limits"`
	Apps   []AppConfig  `yaml:"apps"`

	dir string // directory of the file LoadConfig read, for relative paths
}

// EdgeConfig holds the checks applied to every request before decoding.
type EdgeConfig struct {
	// MaxBodyBytes caps the request body as sent. Default 524288 (512 KiB).
	MaxBodyBytes int64 `yaml:"max_body_bytes"`
	// MaxDecompressedBytes caps the body after gzip. Default 5242880 (5 MiB).
	MaxDecompressedBytes int64 `yaml:"max_decompressed_bytes"`
	// RateLimitPerMinute is the request budget of one client. Default 60.
	RateLimitPerMinute int `yaml:"rate_limit_per_minute"`
	// MaxTrackedClients bounds the rate limiter's memory. Default 100000.
	MaxTrackedClients int `yaml:"max_tracked_clients"`
	// TrustedProxies lists the CIDRs whose forwarding header is believed.
	TrustedProxies []string `yaml:"trusted_proxies"`
	// ForwardedHeader names the forwarding header. Default X-Forwarded-For.
	ForwardedHeader string `yaml:"forwarded_header"`
}

// LimitsConfig caps what one record may carry.
type LimitsConfig struct {
	// MaxAttributes caps the attributes of one record. Default 128.
	MaxAttributes int `yaml:"max_attributes"`
	// MaxValueLength caps a string value in bytes. Default 4096.
	MaxValueLength int `yaml:"max_value_length"`
	// MaxArrayLength caps the elements of an array value. Default 128.
	MaxArrayLength int `yaml:"max_array_length"`
	// MaxSpanEvents caps the events of one span. Default 128.
	MaxSpanEvents int `yaml:"max_span_events"`
	// MaxSpanLinks caps the links of one span. Default 128.
	MaxSpanLinks int `yaml:"max_span_links"`
}

// AppConfig registers one app, identified by its service.name.
type AppConfig struct {
	// ServiceName is the resource service.name the app sends.
	ServiceName string `yaml:"service_name"`
	// Origins lists the browser origins allowed to send for the app, as
	// scheme://host[:port].
	Origins []string `yaml:"origins"`
	// AllowMissingOrigin accepts requests with no Origin header, as React
	// Native apps send.
	AllowMissingOrigin bool `yaml:"allow_missing_origin"`
	// ClientToken, when set, must match the client_token query parameter.
	// It is public: it identifies an app, it does not authenticate one.
	ClientToken string `yaml:"client_token"`
	// Disabled refuses every request for the app.
	Disabled bool `yaml:"disabled"`
	// PII is "drop" (the default), which removes attributes the
	// specification classifies as PII, or "allow". Secrets are always
	// removed.
	PII string `yaml:"pii"`
	// QueryAllowList names the URL query parameters kept in url.full and
	// url.query. Every other parameter is removed.
	QueryAllowList []string `yaml:"query_allow_list"`
}

// PII modes.
const (
	piiDrop  = "drop"
	piiAllow = "allow"
)

// defaultLimits returns the LimitsConfig defaults.
func defaultLimits() LimitsConfig {
	return LimitsConfig{
		MaxAttributes:  128,
		MaxValueLength: 4096,
		MaxArrayLength: 128,
		MaxSpanEvents:  128,
		MaxSpanLinks:   128,
	}
}

// ParseConfig decodes a gateway configuration strictly (an unknown key is
// an error), applies defaults and validates it.
func ParseConfig(raw []byte) (*Config, error) {
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	var cfg Config
	if err := dec.Decode(&cfg); err != nil && !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("o11yrum: config: %w", err)
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("o11yrum: config: the file must hold one YAML document")
	}
	cfg.applyDefaults()
	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("o11yrum: config: %w", err)
	}
	return &cfg, nil
}

// LoadConfig reads and parses the configuration at path. Relative paths in
// the file resolve against its directory.
func LoadConfig(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("o11yrum: config: %w", err)
	}
	cfg, err := ParseConfig(raw)
	if err != nil {
		return nil, err
	}
	cfg.dir = filepath.Dir(path)
	return cfg, nil
}

// resolvePath returns p unchanged when absolute or when the config was not
// read from a file, else joined to the config's directory.
func (c *Config) resolvePath(p string) string {
	if p == "" || filepath.IsAbs(p) || c.dir == "" {
		return p
	}
	return filepath.Join(c.dir, p)
}

// applyDefaults fills zero fields. Negative values are left for validate
// to refuse.
func (c *Config) applyDefaults() {
	e := &c.Edge
	setDefault(&e.MaxBodyBytes, 512<<10)
	setDefault(&e.MaxDecompressedBytes, 5<<20)
	setDefault(&e.RateLimitPerMinute, 60)
	setDefault(&e.MaxTrackedClients, 100000)
	if e.ForwardedHeader == "" {
		e.ForwardedHeader = "X-Forwarded-For"
	}
	d := defaultLimits()
	l := &c.Limits
	setDefault(&l.MaxAttributes, d.MaxAttributes)
	setDefault(&l.MaxValueLength, d.MaxValueLength)
	setDefault(&l.MaxArrayLength, d.MaxArrayLength)
	setDefault(&l.MaxSpanEvents, d.MaxSpanEvents)
	setDefault(&l.MaxSpanLinks, d.MaxSpanLinks)
	for i := range c.Apps {
		if c.Apps[i].PII == "" {
			c.Apps[i].PII = piiDrop
		}
		for j, o := range c.Apps[i].Origins {
			c.Apps[i].Origins[j] = normalizeOrigin(o)
		}
	}
}

func setDefault[T int | int64](v *T, def T) {
	if *v == 0 {
		*v = def
	}
}

// validate returns the first problem found, in a fixed order.
func (c *Config) validate() error {
	if len(c.Apps) == 0 {
		return errors.New("no apps configured")
	}
	for _, f := range []struct {
		name string
		v    int64
	}{
		{"edge.rate_limit_per_minute", int64(c.Edge.RateLimitPerMinute)},
		{"edge.max_body_bytes", c.Edge.MaxBodyBytes},
		{"edge.max_tracked_clients", int64(c.Edge.MaxTrackedClients)},
		{"limits.max_attributes", int64(c.Limits.MaxAttributes)},
		{"limits.max_value_length", int64(c.Limits.MaxValueLength)},
		{"limits.max_array_length", int64(c.Limits.MaxArrayLength)},
		{"limits.max_span_events", int64(c.Limits.MaxSpanEvents)},
		{"limits.max_span_links", int64(c.Limits.MaxSpanLinks)},
	} {
		if f.v <= 0 {
			return fmt.Errorf("%s must be positive", f.name)
		}
	}
	if c.Edge.MaxDecompressedBytes < c.Edge.MaxBodyBytes {
		return errors.New("edge.max_decompressed_bytes must be at least max_body_bytes")
	}
	if strings.EqualFold(c.Edge.ForwardedHeader, "Forwarded") {
		return errors.New("edge.forwarded_header: the RFC 7239 Forwarded header is not supported; name an X-Forwarded-For style header")
	}
	for _, s := range c.Edge.TrustedProxies {
		if _, err := netip.ParsePrefix(s); err != nil {
			return fmt.Errorf("edge.trusted_proxies: %q is not a CIDR", s)
		}
	}
	seen := make(map[string]bool, len(c.Apps))
	for i, a := range c.Apps {
		if a.ServiceName == "" {
			return fmt.Errorf("app %d: service_name is empty", i)
		}
		if seen[a.ServiceName] {
			return fmt.Errorf("duplicate service_name %s", a.ServiceName)
		}
		seen[a.ServiceName] = true
		if len(a.Origins) == 0 && !a.AllowMissingOrigin {
			return fmt.Errorf("app %s: no origins (set allow_missing_origin for apps without one)", a.ServiceName)
		}
		for _, o := range a.Origins {
			if !validOrigin(o) {
				return fmt.Errorf("app %s: origin %q must be scheme://host[:port]", a.ServiceName, o)
			}
		}
		if a.PII != piiDrop && a.PII != piiAllow {
			return fmt.Errorf("app %s: pii %q must be drop or allow", a.ServiceName, a.PII)
		}
	}
	return nil
}

// validOrigin reports whether o is a bare scheme://host[:port].
func validOrigin(o string) bool {
	u, err := url.Parse(o)
	if err != nil {
		return false
	}
	return u.Scheme != "" && u.Host != "" && u.Path == "" && u.RawQuery == "" &&
		u.Fragment == "" && u.User == nil && !u.ForceQuery && u.Opaque == ""
}

// normalizeOrigin lowercases an origin and removes the scheme's default
// port, so configured origins and Origin headers compare as strings. The
// gateway applies it to both sides.
func normalizeOrigin(o string) string {
	o = strings.ToLower(strings.TrimSpace(o))
	switch {
	case strings.HasPrefix(o, "https://"):
		return strings.TrimSuffix(o, ":443")
	case strings.HasPrefix(o, "http://"):
		return strings.TrimSuffix(o, ":80")
	}
	return o
}

// clone returns a deep copy of c.
func (c *Config) clone() *Config {
	out := *c
	out.Edge.TrustedProxies = slices.Clone(c.Edge.TrustedProxies)
	out.Apps = make([]AppConfig, len(c.Apps))
	for i, a := range c.Apps {
		a.Origins = slices.Clone(a.Origins)
		a.QueryAllowList = slices.Clone(a.QueryAllowList)
		out.Apps[i] = a
	}
	return &out
}
