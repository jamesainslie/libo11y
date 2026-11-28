package o11yrum

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/rumspec"
)

// Config is the gateway configuration, read from one YAML file. Zero
// numeric fields take the documented defaults.
type Config struct {
	// Listen is the address the o11yrum-gateway command serves on.
	// Default :8080. The library ignores it.
	Listen string `yaml:"listen"`
	// Environment is the gateway's own deployment.environment.name:
	// production, staging, development or test. The o11yrum-gateway
	// command requires it. The library ignores it.
	Environment string `yaml:"environment"`
	// ShutdownDelay is how long the o11yrum-gateway command keeps serving
	// after a shutdown signal, with /readyz answering 503, before it stops
	// accepting connections and drains. It gives a load balancer that
	// probes /readyz time to stop sending traffic. Default 0. The library
	// ignores it.
	ShutdownDelay time.Duration `yaml:"shutdown_delay"`
	// Telemetry configures the gateway's own telemetry.
	Telemetry TelemetryConfig `yaml:"telemetry"`

	Edge        EdgeConfig        `yaml:"edge"`
	Limits      LimitsConfig      `yaml:"limits"`
	Apps        []AppConfig       `yaml:"apps"`
	Aggregation AggregationConfig `yaml:"aggregation"`
	Sinks       SinksConfig       `yaml:"sinks"`

	// ObjectStore is where uploaded source maps are kept. Without one the
	// gateway accepts no uploads and does not symbolicate.
	ObjectStore ObjectStoreConfig `yaml:"object_store"`
	// Sourcemaps configures the source map upload endpoint.
	Sourcemaps SourcemapsConfig `yaml:"sourcemaps"`
	// Symbolication configures how error stacks are symbolicated.
	Symbolication SymbolicationConfig `yaml:"symbolication"`
	// Replay configures the session replay endpoint.
	Replay ReplayConfig `yaml:"replay"`

	dir string // directory of the file LoadConfig read, for relative paths
}

// TelemetryConfig configures the gateway's own telemetry, which the
// standard OTEL_* environment variables route.
type TelemetryConfig struct {
	// ServiceName is the gateway's own service.name. Default
	// o11yrum-gateway.
	ServiceName string `yaml:"service_name"`
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
	// Country names the header a proxy puts the client's country in.
	Country CountryConfig `yaml:"country"`
	// ClockSkewThreshold is the smallest difference between the gateway's
	// clock and the client's send time that the gateway corrects
	// timestamps for. Default 1s.
	ClockSkewThreshold time.Duration `yaml:"clock_skew_threshold"`
}

// CountryConfig names the header carrying the client's country as an ISO
// 3166-1 alpha-2 code, such as Cloudflare's CF-IPCountry, and the hops
// allowed to set it.
type CountryConfig struct {
	// Header names the country header. Empty disables country enrichment.
	Header string `yaml:"header"`
	// TrustedFrom lists the CIDRs of the hop that sets the header. The
	// header is believed only when the hop that received the client's
	// connection is on this list. These hops also count as trusted
	// proxies when reading the forwarding header.
	TrustedFrom []string `yaml:"trusted_from"`
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

// AggregationConfig bounds the metrics the gateway derives.
type AggregationConfig struct {
	// MaxSeriesPerMetric caps the attribute sets one app may hold in one
	// derived metric. Measurements past it go to the app's overflow series,
	// marked otel.metric.overflow=true. Default 2000.
	MaxSeriesPerMetric int `yaml:"max_series_per_metric"`
	// MaxMetricsPerApp caps the distinct metrics one app may send to
	// /_o11y/v1/metrics. Data points of further metrics are dropped as
	// metric_limit. Default 200.
	MaxMetricsPerApp int `yaml:"max_metrics_per_app"`
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
	// RemoteConfigFile is a JSON object file served to the app's clients
	// from /_o11y/v1/config. A relative path resolves against the
	// configuration file's directory. Empty means the app has none.
	RemoteConfigFile string `yaml:"remote_config_file"`
	// Metrics are operator-defined metrics derived from the app's events.
	Metrics []MetricDefinition `yaml:"metrics"`
	// AppMetricLabels lists the data point attributes, beyond those the
	// specification classifies bounded or enum, that the app's metrics
	// keep. Every other attribute of an app metric point is dropped. A
	// listed key must have a bounded set of values. Keys the specification
	// classifies PII, secret or unbounded are refused here and dropped
	// whatever the pii mode.
	AppMetricLabels []string `yaml:"app_metric_labels"`
	// Sourcemaps configures the app's source map uploads and lookups.
	Sourcemaps AppSourcemaps `yaml:"sourcemaps"`
	// Replay configures the app's session replay.
	Replay AppReplay `yaml:"replay"`
}

// AppSourcemaps configures one app's source maps.
type AppSourcemaps struct {
	// Namespace is the object key segment the app's maps are kept under.
	// Default service_name. Two apps that ship the same bundles, such as
	// a canary, may share one. It must match [A-Za-z0-9][A-Za-z0-9._+-]*,
	// up to 128 characters.
	Namespace string `yaml:"namespace"`
	// UploadTokenFile holds the bearer token that authorises uploads for
	// the app. A relative path resolves against the configuration file's
	// directory. Empty means the app accepts no uploads.
	UploadTokenFile string `yaml:"upload_token_file"`
}

// SourcemapsConfig configures the source map upload endpoint.
type SourcemapsConfig struct {
	// MaxUploadBytes caps one uploaded map, before and after gzip.
	// Default 33554432 (32 MiB).
	MaxUploadBytes int64 `yaml:"max_upload_bytes"`
}

// ObjectStoreConfig selects the object store. Set at most one field.
type ObjectStoreConfig struct {
	// Filesystem keeps objects as files under a directory.
	Filesystem *FilesystemStoreConfig `yaml:"filesystem"`
	// S3 keeps objects in an S3 bucket. The library cannot build this
	// store itself: pass one built with the s3store package through
	// WithObjectStore, as the o11yrum-gateway command does.
	S3 *S3StoreConfig `yaml:"s3"`
}

// FilesystemStoreConfig locates the filesystem object store.
type FilesystemStoreConfig struct {
	// Root is the directory objects are kept under. A relative path
	// resolves against the configuration file's directory.
	Root string `yaml:"root"`
}

// S3StoreConfig mirrors s3store.Config field for field. It lives here
// because s3store imports o11yrum, so o11yrum cannot import s3store; the
// command converts one to the other.
type S3StoreConfig struct {
	Bucket       string `yaml:"bucket"`
	Prefix       string `yaml:"prefix"`
	Region       string `yaml:"region"`
	Endpoint     string `yaml:"endpoint"`
	UsePathStyle bool   `yaml:"use_path_style"`
}

// namespace returns the key segment the app's source maps are kept
// under, or "" when the app has none usable.
func (a AppConfig) namespace() string {
	if a.Sourcemaps.Namespace != "" {
		return a.Sourcemaps.Namespace
	}
	if validSegment(a.ServiceName) {
		return a.ServiceName
	}
	return ""
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
	if c.Listen == "" {
		c.Listen = ":8080"
	}
	if c.Telemetry.ServiceName == "" {
		c.Telemetry.ServiceName = "o11yrum-gateway"
	}
	e := &c.Edge
	setDefault(&e.MaxBodyBytes, 512<<10)
	setDefault(&e.MaxDecompressedBytes, 5<<20)
	setDefault(&e.RateLimitPerMinute, 60)
	setDefault(&e.MaxTrackedClients, 100000)
	if e.ForwardedHeader == "" {
		e.ForwardedHeader = "X-Forwarded-For"
	}
	if e.ClockSkewThreshold == 0 {
		e.ClockSkewThreshold = time.Second
	}
	d := defaultLimits()
	l := &c.Limits
	setDefault(&l.MaxAttributes, d.MaxAttributes)
	setDefault(&l.MaxValueLength, d.MaxValueLength)
	setDefault(&l.MaxArrayLength, d.MaxArrayLength)
	setDefault(&l.MaxSpanEvents, d.MaxSpanEvents)
	setDefault(&l.MaxSpanLinks, d.MaxSpanLinks)
	setDefault(&c.Aggregation.MaxSeriesPerMetric, 2000)
	setDefault(&c.Aggregation.MaxMetricsPerApp, 200)
	setDefault(&c.Sourcemaps.MaxUploadBytes, 32<<20)
	c.Symbolication.applyDefaults()
	c.Replay.applyDefaults()
	for i := range c.Apps {
		if c.Apps[i].PII == "" {
			c.Apps[i].PII = piiDrop
		}
		for j, o := range c.Apps[i].Origins {
			c.Apps[i].Origins[j] = normalizeOrigin(o)
		}
		applyMetricDefaults(c.Apps[i].Metrics)
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
		{"aggregation.max_series_per_metric", int64(c.Aggregation.MaxSeriesPerMetric)},
		{"aggregation.max_metrics_per_app", int64(c.Aggregation.MaxMetricsPerApp)},
		{"sourcemaps.max_upload_bytes", c.Sourcemaps.MaxUploadBytes},
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
	for _, s := range c.Edge.Country.TrustedFrom {
		if _, err := netip.ParsePrefix(s); err != nil {
			return fmt.Errorf("edge.country.trusted_from: %q is not a CIDR", s)
		}
	}
	if c.Edge.ClockSkewThreshold < 0 {
		return errors.New("edge.clock_skew_threshold must not be negative")
	}
	if c.ShutdownDelay < 0 {
		return errors.New("shutdown_delay must not be negative")
	}
	if err := c.ObjectStore.validate(); err != nil {
		return err
	}
	if err := c.Symbolication.validate(); err != nil {
		return err
	}
	if err := c.Replay.validate(); err != nil {
		return err
	}
	if err := c.Replay.validateRead(c.Listen); err != nil {
		return err
	}
	seen := make(map[string]bool, len(c.Apps))
	// The replay read API and erasure reach a recording through its
	// service's namespace, so two services sharing one would reach each
	// other's recordings.
	replayNS := make(map[string]string, len(c.Apps))
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
		if err := validateAppMetricLabels(a); err != nil {
			return fmt.Errorf("app %s: app_metric_labels: %w", a.ServiceName, err)
		}
		if err := validateAppSourcemaps(a); err != nil {
			return fmt.Errorf("app %s: %w", a.ServiceName, err)
		}
		if err := validateAppReplay(a); err != nil {
			return fmt.Errorf("app %s: %w", a.ServiceName, err)
		}
		if ns := a.replayNamespace(); ns != "" {
			if other, dup := replayNS[ns]; dup {
				return fmt.Errorf("app %s: replay namespace %s is also app %s's; each app needs its own", a.ServiceName, ns, other)
			}
			replayNS[ns] = a.ServiceName
		}
	}
	return validateMetrics(c.Apps)
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
	out.Edge.Country.TrustedFrom = slices.Clone(c.Edge.Country.TrustedFrom)
	out.Sinks.OTLP.Headers = maps.Clone(c.Sinks.OTLP.Headers)
	if c.ObjectStore.Filesystem != nil {
		fsc := *c.ObjectStore.Filesystem
		out.ObjectStore.Filesystem = &fsc
	}
	if c.ObjectStore.S3 != nil {
		s3c := *c.ObjectStore.S3
		out.ObjectStore.S3 = &s3c
	}
	if c.Replay.SweepInterval != nil {
		every := *c.Replay.SweepInterval
		out.Replay.SweepInterval = &every
	}
	out.Apps = make([]AppConfig, len(c.Apps))
	for i, a := range c.Apps {
		a.Origins = slices.Clone(a.Origins)
		a.QueryAllowList = slices.Clone(a.QueryAllowList)
		a.AppMetricLabels = slices.Clone(a.AppMetricLabels)
		a.Metrics = cloneMetrics(a.Metrics)
		out.Apps[i] = a
	}
	return &out
}

// validateAppMetricLabels refuses an allow-list entry the gateway would
// drop anyway, so an operator learns at load time instead of from missing
// labels.
func validateAppMetricLabels(a AppConfig) error {
	seen := make(map[string]bool, len(a.AppMetricLabels))
	for _, k := range a.AppMetricLabels {
		sens, card := specClasses(k)
		switch {
		case k == "":
			return errors.New("empty key")
		case len(k) > maxAppLabelLen:
			return fmt.Errorf("%.32s... is longer than %d bytes", k, maxAppLabelLen)
		case seen[k]:
			return fmt.Errorf("duplicate key %s", k)
		case gatewayOwned[k] || k == keyServiceName || k == keyOverflow:
			return fmt.Errorf("%s is set by the gateway", k)
		case sens == rumspec.Secret:
			return fmt.Errorf("%s is classified secret by the specification and is always dropped", k)
		case sens == rumspec.PII:
			return fmt.Errorf("%s is classified PII by the specification and is always dropped", k)
		case card == rumspec.Unbounded:
			return fmt.Errorf("%s is unbounded by the specification and is always dropped", k)
		case strings.HasPrefix(k, "o11y.") && rumspec.Types[k] == "" && !isTemplateKey(k):
			return fmt.Errorf("%s is not defined by the specification, which alone mints o11y.* keys", k)
		}
		seen[k] = true
	}
	return nil
}

// validate refuses an object store configuration that names both stores
// or leaves the chosen one unlocated.
func (o ObjectStoreConfig) validate() error {
	switch {
	case o.Filesystem != nil && o.S3 != nil:
		return errors.New("object_store: set exactly one of filesystem and s3")
	case o.Filesystem != nil && o.Filesystem.Root == "":
		return errors.New("object_store.filesystem.root is empty")
	case o.S3 != nil && o.S3.Bucket == "":
		return errors.New("object_store.s3.bucket is empty")
	}
	return nil
}

// validateAppSourcemaps checks the app's namespace is a usable key
// segment, and that an app accepting uploads has one.
func validateAppSourcemaps(a AppConfig) error {
	sm := a.Sourcemaps
	if sm.Namespace != "" && !validSegment(sm.Namespace) {
		return fmt.Errorf("sourcemaps.namespace %q must match %s", sm.Namespace, segmentPattern)
	}
	if sm.UploadTokenFile != "" && a.namespace() == "" {
		return fmt.Errorf("service_name %q cannot be an object key segment; set sourcemaps.namespace", a.ServiceName)
	}
	return nil
}
