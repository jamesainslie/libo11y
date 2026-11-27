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
	proxies []netip.Prefix
	header  string
}

func newProxyTrust(cfg EdgeConfig) (proxyTrust, error) {
	p := proxyTrust{header: cfg.ForwardedHeader}
	for _, s := range cfg.TrustedProxies {
		pfx, err := netip.ParsePrefix(s)
		if err != nil {
			return proxyTrust{}, fmt.Errorf("o11yrum: edge.trusted_proxies: %q is not a CIDR", s)
		}
		p.proxies = append(p.proxies, pfx.Masked())
	}
	return p, nil
}

func (p proxyTrust) trusted(a netip.Addr) bool {
	for _, pfx := range p.proxies {
		if pfx.Contains(a) {
			return true
		}
	}
	return false
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
