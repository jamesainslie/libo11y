package o11yrum

import (
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
)

func TestResolveClient(t *testing.T) {
	p, err := newProxyTrust(EdgeConfig{TrustedProxies: []string{"10.0.0.0/8", "173.245.48.0/20"}, ForwardedHeader: "X-Forwarded-For"})
	if err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct {
		remote           string
		xff              []string
		client, receiver string
	}{
		"direct untrusted peer ignores the header": {"203.0.113.9:4000", []string{"198.51.100.1"}, "203.0.113.9", ""},
		"trusted peer without a header":            {"10.1.2.3:4000", nil, "10.1.2.3", ""},
		"through envoy":                            {"10.1.2.3:4000", []string{"198.51.100.1"}, "198.51.100.1", "10.1.2.3"},
		"through cloudflare and envoy":             {"10.1.2.3:4000", []string{"198.51.100.1, 173.245.48.7"}, "198.51.100.1", "173.245.48.7"},
		"forged left entries are skipped":          {"10.1.2.3:4000", []string{"1.1.1.1, 198.51.100.1, 173.245.48.7"}, "198.51.100.1", "173.245.48.7"},
		"repeated headers read in order":           {"10.1.2.3:4000", []string{"1.1.1.1, 198.51.100.1", "173.245.48.7"}, "198.51.100.1", "173.245.48.7"},
		"garbage stops the walk":                   {"10.1.2.3:4000", []string{"nonsense, 173.245.48.7"}, "173.245.48.7", "10.1.2.3"},
		"empty entry stops the walk":               {"10.1.2.3:4000", []string{", 173.245.48.7"}, "173.245.48.7", "10.1.2.3"},
		"every hop trusted":                        {"10.1.2.3:4000", []string{"10.9.9.9"}, "10.9.9.9", "10.1.2.3"},
		"ipv4-mapped peer":                         {"[::ffff:10.1.2.3]:4000", []string{"198.51.100.1"}, "198.51.100.1", "10.1.2.3"},
		"port in a hop":                            {"10.1.2.3:4000", []string{"198.51.100.1:5555"}, "198.51.100.1", "10.1.2.3"},
		"ipv6 hop with port":                       {"10.1.2.3:4000", []string{"[2001:db8::1]:443"}, "2001:db8::1", "10.1.2.3"},
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/_o11y/v1/logs", nil)
			r.RemoteAddr = tc.remote
			for _, v := range tc.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			client, receiver, ok := p.resolve(r)
			if !ok || client.String() != tc.client {
				t.Errorf("client %v (ok %v), want %s", client, ok, tc.client)
			}
			gotRecv := ""
			if receiver.IsValid() {
				gotRecv = receiver.String()
			}
			if gotRecv != tc.receiver {
				t.Errorf("receiver %q, want %q", gotRecv, tc.receiver)
			}
		})
	}
}

func TestResolveClientRefusesUnparseableRemote(t *testing.T) {
	p, err := newProxyTrust(EdgeConfig{ForwardedHeader: "X-Forwarded-For"})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/_o11y/v1/logs", nil)
	r.RemoteAddr = "pipe"
	if _, _, ok := p.resolve(r); ok {
		t.Fatal("an unparseable RemoteAddr resolved")
	}
}

func TestNewProxyTrustRefusesBadCIDR(t *testing.T) {
	if _, err := newProxyTrust(EdgeConfig{TrustedProxies: []string{"10.0.0.0/33"}}); err == nil {
		t.Fatal("a bad CIDR was accepted")
	}
}

func TestClientKeyGroupsIPv6By64(t *testing.T) {
	k := newClientKeyer()
	a := k.key(netip.MustParseAddr("2001:db8:1:2::1"))
	b := k.key(netip.MustParseAddr("2001:db8:1:2:ffff::9"))
	c := k.key(netip.MustParseAddr("2001:db8:1:3::1"))
	if a != b || a == c {
		t.Errorf("keys a=%d b=%d c=%d: want a==b!=c", a, b, c)
	}
	if k.key(netip.MustParseAddr("192.0.2.1")) == k.key(netip.MustParseAddr("192.0.2.2")) {
		t.Error("two IPv4 addresses share a key")
	}
}

func TestClientKeyIsPerProcess(t *testing.T) {
	addr := netip.MustParseAddr("192.0.2.1")
	first, second := newClientKeyer(), newClientKeyer()
	if first.key(addr) == second.key(addr) {
		t.Error("two keyers produced the same key, so the seed is not random")
	}
}

func TestCountryTrustedOnlyFromListedHop(t *testing.T) {
	p, err := newProxyTrust(EdgeConfig{
		TrustedProxies:  []string{"10.0.0.0/8"},
		ForwardedHeader: "X-Forwarded-For",
		Country:         CountryConfig{Header: "CF-IPCountry", TrustedFrom: []string{"173.245.48.0/20"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct{ remote, xff, header, want string }{
		"via cloudflare":       {"10.1.2.3:1", "198.51.100.1, 173.245.48.7", "de", "DE"},
		"padded":               {"10.1.2.3:1", "198.51.100.1, 173.245.48.7", " fr ", "FR"},
		"bypassing cloudflare": {"10.1.2.3:1", "198.51.100.1", "DE", ""},
		"direct connection":    {"173.245.48.7:1", "", "DE", ""},
		"unknown country":      {"10.1.2.3:1", "198.51.100.1, 173.245.48.7", "XX", ""},
		"tor":                  {"10.1.2.3:1", "198.51.100.1, 173.245.48.7", "T1", ""},
		"junk":                 {"10.1.2.3:1", "198.51.100.1, 173.245.48.7", "Germany", ""},
		"absent":               {"10.1.2.3:1", "198.51.100.1, 173.245.48.7", "", ""},
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", nil)
			r.RemoteAddr = tc.remote
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			r.Header.Set("CF-IPCountry", tc.header)
			_, receiver, _ := p.resolve(r)
			if got := p.country(r, receiver); got != tc.want {
				t.Errorf("country %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCountryDisabledWithoutHeader(t *testing.T) {
	p, err := newProxyTrust(EdgeConfig{
		ForwardedHeader: "X-Forwarded-For",
		Country:         CountryConfig{TrustedFrom: []string{"173.245.48.0/20"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("POST", "/", nil)
	r.RemoteAddr = "173.245.48.7:1"
	r.Header.Set("X-Forwarded-For", "198.51.100.1")
	r.Header.Set("CF-IPCountry", "DE")
	_, receiver, _ := p.resolve(r)
	if got := p.country(r, receiver); got != "" {
		t.Errorf("country %q with no header configured", got)
	}
}

func TestNewProxyTrustRefusesBadCountryCIDR(t *testing.T) {
	_, err := newProxyTrust(EdgeConfig{Country: CountryConfig{Header: "CF-IPCountry", TrustedFrom: []string{"nope"}}})
	if err == nil || !strings.Contains(err.Error(), "edge.country.trusted_from") {
		t.Fatalf("err = %v", err)
	}
}
