package o11yrum

import (
	"fmt"
	"hash/maphash"
	"net/http"
	"net/netip"
	"strings"
)

// proxyTrust decides which forwarding-header entries to believe. Walking
// from the nearest hop outwards, every hop on the trusted list may vouch
// for the one before it. The first hop that is not trusted is the client.
type proxyTrust struct {
	proxies       []netip.Prefix
	header        string
	countryHeader string
	countryFrom   []netip.Prefix
}

func newProxyTrust(cfg EdgeConfig) (proxyTrust, error) {
	p := proxyTrust{header: cfg.ForwardedHeader, countryHeader: cfg.Country.Header}
	var err error
	if p.proxies, err = parsePrefixes("edge.trusted_proxies", cfg.TrustedProxies); err != nil {
		return proxyTrust{}, err
	}
	if p.countryFrom, err = parsePrefixes("edge.country.trusted_from", cfg.Country.TrustedFrom); err != nil {
		return proxyTrust{}, err
	}
	return p, nil
}

func parsePrefixes(field string, cidrs []string) ([]netip.Prefix, error) {
	out := make([]netip.Prefix, 0, len(cidrs))
	for _, s := range cidrs {
		pfx, err := netip.ParsePrefix(s)
		if err != nil {
			return nil, fmt.Errorf("o11yrum: %s: %q is not a CIDR", field, s)
		}
		out = append(out, pfx.Masked())
	}
	return out, nil
}

// trusted reports whether a may vouch for the hop before it. A hop allowed
// to set the country header is a proxy too.
func (p proxyTrust) trusted(a netip.Addr) bool {
	return containsAddr(p.proxies, a) || containsAddr(p.countryFrom, a)
}

func containsAddr(prefixes []netip.Prefix, a netip.Addr) bool {
	for _, pfx := range prefixes {
		if pfx.Contains(a) {
			return true
		}
	}
	return false
}

// country returns the ISO 3166-1 alpha-2 code the operator's proxy put in
// the country header, only when the hop that received the client's
// connection is on the trusted_from list. Anyone else can forge it. XX
// (unknown) and codes that are not two letters, such as Cloudflare's T1
// for Tor, give "".
func (p proxyTrust) country(r *http.Request, receiver netip.Addr) string {
	if p.countryHeader == "" || !receiver.IsValid() || !containsAddr(p.countryFrom, receiver) {
		return ""
	}
	v := strings.ToUpper(strings.TrimSpace(r.Header.Get(p.countryHeader)))
	if len(v) != 2 || v == "XX" || v[0] < 'A' || v[0] > 'Z' || v[1] < 'A' || v[1] > 'Z' {
		return ""
	}
	return v
}

// resolve returns the client address and the hop that received the
// client's connection (invalid when the client connected directly). ok is
// false when the connection's own address cannot be parsed.
func (p proxyTrust) resolve(r *http.Request) (client, receiver netip.Addr, ok bool) {
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}, netip.Addr{}, false
	}
	client = ap.Addr().Unmap()
	if !p.trusted(client) {
		return client, netip.Addr{}, true
	}
	var entries []string
	for _, h := range r.Header.Values(p.header) {
		entries = append(entries, strings.Split(h, ",")...)
	}
	for i := len(entries) - 1; i >= 0; i-- {
		hop, ok := parseHop(strings.TrimSpace(entries[i]))
		if !ok {
			// Only trusted proxies wrote the entries to the right of this
			// one, so a malformed entry here ends what can be believed.
			return client, receiver, true
		}
		receiver, client = client, hop
		if !p.trusted(client) {
			return client, receiver, true
		}
	}
	return client, receiver, true
}

// parseHop reads one forwarding entry: an address, or an address with a
// port ("198.51.100.1:5555", "[2001:db8::1]:443").
func parseHop(s string) (netip.Addr, bool) {
	if a, err := netip.ParseAddr(s); err == nil {
		return a.Unmap(), true
	}
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.Addr().Unmap(), true
	}
	return netip.Addr{}, false
}

// clientKeyer turns an address into a rate-limit key. The seed is random
// per process, so a key cannot be matched to an address outside it.
type clientKeyer struct{ seed maphash.Seed }

func newClientKeyer() clientKeyer { return clientKeyer{seed: maphash.MakeSeed()} }

// key hashes addr. IPv6 addresses key by their /64, the smallest block a
// single subscriber is usually given.
func (k clientKeyer) key(addr netip.Addr) uint64 {
	if addr.Is6() {
		addr = netip.PrefixFrom(addr, 64).Masked().Addr()
	}
	return maphash.Bytes(k.seed, addr.AsSlice())
}
