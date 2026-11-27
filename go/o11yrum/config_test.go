package o11yrum

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestParseConfigDefaults(t *testing.T) {
	cfg, err := ParseConfig([]byte("apps:\n  - service_name: shop-web\n    origins: [\"https://shop.example\"]\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Edge.MaxBodyBytes != 512<<10 || cfg.Edge.MaxDecompressedBytes != 5<<20 || cfg.Edge.RateLimitPerMinute != 60 {
		t.Errorf("edge defaults: %+v", cfg.Edge)
	}
	if cfg.Edge.ForwardedHeader != "X-Forwarded-For" || cfg.Edge.MaxTrackedClients != 100000 {
		t.Errorf("edge defaults: %+v", cfg.Edge)
	}
	if cfg.Limits != (LimitsConfig{MaxAttributes: 128, MaxValueLength: 4096, MaxArrayLength: 128, MaxSpanEvents: 128, MaxSpanLinks: 128}) {
		t.Errorf("limit defaults: %+v", cfg.Limits)
	}
	if cfg.Limits != defaultLimits() {
		t.Errorf("defaultLimits() disagrees with applyDefaults: %+v", defaultLimits())
	}
	if cfg.Edge.ClockSkewThreshold != time.Second {
		t.Errorf("clock skew threshold default %v", cfg.Edge.ClockSkewThreshold)
	}
	if cfg.Apps[0].PII != "drop" {
		t.Errorf("pii default %q", cfg.Apps[0].PII)
	}
}

func TestParseConfigRefuses(t *testing.T) {
	for name, tc := range map[string]struct{ yaml, want string }{
		"unknown key":      {"apps: []\nbogus: 1\n", "field bogus not found"},
		"no apps":          {"apps: []\n", "no apps"},
		"empty file":       {"", "no apps"},
		"duplicate app":    {"apps:\n  - {service_name: a, origins: [\"https://a\"]}\n  - {service_name: a, origins: [\"https://a\"]}\n", "duplicate service_name a"},
		"empty name":       {"apps:\n  - {origins: [\"https://a\"]}\n", "service_name is empty"},
		"bad origin":       {"apps:\n  - {service_name: a, origins: [\"https://a/path\"]}\n", "origin \"https://a/path\""},
		"origin query":     {"apps:\n  - {service_name: a, origins: [\"https://a?x=1\"]}\n", "origin \"https://a?x=1\""},
		"origin no host":   {"apps:\n  - {service_name: a, origins: [\"a.example\"]}\n", "origin \"a.example\""},
		"origin userinfo":  {"apps:\n  - {service_name: a, origins: [\"https://u@a\"]}\n", "origin \"https://u@a\""},
		"no origin":        {"apps:\n  - {service_name: a}\n", "no origins"},
		"bad pii":          {"apps:\n  - {service_name: a, origins: [\"https://a\"], pii: hash}\n", "pii \"hash\""},
		"bad cidr":         {"edge: {trusted_proxies: [\"10.0.0.0/33\"]}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n", "trusted_proxies"},
		"caps inverted":    {"edge: {max_body_bytes: 10, max_decompressed_bytes: 5}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n", "max_decompressed_bytes"},
		"second document":  {"apps: []\n---\napps: []\n", "one YAML document"},
		"negative rate":    {"edge: {rate_limit_per_minute: -1}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n", "rate_limit_per_minute"},
		"negative body":    {"edge: {max_body_bytes: -1}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n", "max_body_bytes"},
		"negative limit":   {"limits: {max_attributes: -1}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n", "max_attributes"},
		"negative tracked": {"edge: {max_tracked_clients: -1}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n", "max_tracked_clients"},
		"bad country cidr": {"edge: {country: {header: CF-IPCountry, trusted_from: [\"x\"]}}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n", "edge.country.trusted_from"},
		"negative skew":    {"edge: {clock_skew_threshold: -1s}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n", "clock_skew_threshold"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ParseConfig([]byte(tc.yaml))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestParseConfigAllowsMissingOriginWithoutOrigins(t *testing.T) {
	if _, err := ParseConfig([]byte("apps:\n  - {service_name: mobile, allow_missing_origin: true}\n")); err != nil {
		t.Fatal(err)
	}
}

func TestParseConfigNormalisesOrigins(t *testing.T) {
	cfg, err := LoadConfig(filepath.Join("testdata", "config", "valid.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if got, want := cfg.Apps[0].Origins, []string{"https://shop.example", "http://localhost:5173"}; !slices.Equal(got, want) {
		t.Errorf("origins %q, want %q", got, want)
	}
	if cfg.Apps[1].PII != "allow" || cfg.Apps[1].ClientToken != "pub-123" {
		t.Errorf("app 1: %+v", cfg.Apps[1])
	}
}

func TestNormalizeOrigin(t *testing.T) {
	for in, want := range map[string]string{
		"https://Shop.Example":      "https://shop.example",
		"https://shop.example:443":  "https://shop.example",
		"http://shop.example:80":    "http://shop.example",
		"https://shop.example:8443": "https://shop.example:8443",
		"http://shop.example:443":   "http://shop.example:443",
		"":                          "",
		"null":                      "null",
	} {
		if got := normalizeOrigin(in); got != want {
			t.Errorf("normalizeOrigin(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLoadConfigRecordsDirectory(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "gateway.yaml")
	if err := os.WriteFile(path, []byte("apps:\n  - {service_name: a, origins: [\"https://a\"]}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.dir != dir {
		t.Errorf("dir %q, want %q", cfg.dir, dir)
	}
	if got := cfg.resolvePath("maps"); got != filepath.Join(dir, "maps") {
		t.Errorf("resolvePath(maps) = %q", got)
	}
	if got := cfg.resolvePath("/abs"); got != "/abs" {
		t.Errorf("resolvePath(/abs) = %q", got)
	}
}

func TestLoadConfigMissingFile(t *testing.T) {
	if _, err := LoadConfig(filepath.Join(t.TempDir(), "nope.yaml")); err == nil {
		t.Fatal("LoadConfig of a missing file succeeded")
	}
}

func TestParseConfigCommandSettings(t *testing.T) {
	cfg, err := ParseConfig([]byte("apps:\n  - {service_name: a, origins: [\"https://a\"]}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != ":8080" || cfg.Telemetry.ServiceName != "o11yrum-gateway" || cfg.Environment != "" {
		t.Errorf("listen %q telemetry %+v environment %q", cfg.Listen, cfg.Telemetry, cfg.Environment)
	}
	cfg, err = ParseConfig([]byte("listen: 127.0.0.1:9000\nenvironment: staging\ntelemetry: {service_name: rum-gw}\napps:\n  - {service_name: a, origins: [\"https://a\"]}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Listen != "127.0.0.1:9000" || cfg.Telemetry.ServiceName != "rum-gw" || cfg.Environment != "staging" {
		t.Errorf("listen %q telemetry %+v environment %q", cfg.Listen, cfg.Telemetry, cfg.Environment)
	}
}
