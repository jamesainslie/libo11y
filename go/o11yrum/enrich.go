package o11yrum

import (
	"net/http"
	"net/netip"
	"strconv"
	"time"

	"go.opentelemetry.io/collector/pdata/pcommon"
	"go.opentelemetry.io/collector/pdata/plog"
	"go.opentelemetry.io/collector/pdata/ptrace"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/uaparse"
)

// clientInfo is what the gateway derives from the request itself. It never
// holds the client address.
type clientInfo struct {
	country string
	ua      uaparse.Result
	skew    time.Duration // gateway clock minus client send time; 0 when not corrected
}

// clientInfo reads the country header, the user agent and its client
// hints, and the sent_at query parameter (Unix milliseconds). receiver is
// the proxy hop that received the client's connection, never the client.
func (h *Handler) clientInfo(r *http.Request, receiver netip.Addr) clientInfo {
	ci := clientInfo{
		country: h.trust.country(r, receiver),
		ua: uaparse.Parse(uaparse.Hints{
			UA:         r.Header.Get("User-Agent"),
			CHMobile:   r.Header.Get("Sec-CH-UA-Mobile"),
			CHPlatform: r.Header.Get("Sec-CH-UA-Platform"),
		}),
	}
	if ms, err := strconv.ParseInt(r.URL.Query().Get("sent_at"), 10, 64); err == nil && ms > 0 {
		skew := h.now().Sub(time.UnixMilli(ms))
		if skew.Abs() >= h.cfg.Edge.ClockSkewThreshold {
			ci.skew = skew
		}
	}
	return ci
}

// enrich adds the request's client information to every resource of a
// validated batch and corrects its timestamps for clock skew.
func enrich(sig Signal, d decoded, ci clientInfo) {
	switch sig {
	case SignalTraces:
		for i := range d.traces.ResourceSpans().Len() {
			rs := d.traces.ResourceSpans().At(i)
			enrichResource(rs.Resource(), ci, tracesPlatform(rs))
		}
		if ci.skew != 0 {
			shiftTraces(d.traces, ci.skew)
		}
	case SignalLogs:
		for i := range d.logs.ResourceLogs().Len() {
			rl := d.logs.ResourceLogs().At(i)
			enrichResource(rl.Resource(), ci, logsPlatform(rl))
		}
		if ci.skew != 0 {
			shiftLogs(d.logs, ci.skew)
		}
	}
}

// enrichResource adds what the gateway derives from the request. Browser
// family and OS come from the user agent only for web pages and browser
// extensions; a React Native user agent names its HTTP library. A device
// class the client sent stays, unless the user agent is a bot.
func enrichResource(res pcommon.Resource, ci clientInfo, platform string) {
	attrs := res.Attributes()
	if ci.country != "" {
		attrs.PutStr(keyCountry, ci.country)
	}
	browser := platform == "" || platform == "web" || platform == "webext"
	if browser && ci.ua.Family != "" {
		attrs.PutStr(keyBrowserFamily, ci.ua.Family)
	}
	if browser && ci.ua.OS != "" {
		attrs.PutStr(keyOSName, ci.ua.OS)
	}
	if ci.ua.Device == "bot" {
		attrs.PutStr(keyDeviceClass, "bot")
	} else if _, ok := attrs.Get(keyDeviceClass); !ok && browser && ci.ua.Device != "" {
		attrs.PutStr(keyDeviceClass, ci.ua.Device)
	}
}

// tracesPlatform reads o11y.rum.platform from the resource, else from the
// first span that carries it.
func tracesPlatform(rs ptrace.ResourceSpans) string {
	if p, ok := platformOf(rs.Resource().Attributes()); ok {
		return p
	}
	for i := range rs.ScopeSpans().Len() {
		spans := rs.ScopeSpans().At(i).Spans()
		for j := range spans.Len() {
			if p, ok := platformOf(spans.At(j).Attributes()); ok {
				return p
			}
		}
	}
	return ""
}

// logsPlatform reads o11y.rum.platform from the resource, else from the
// first record that carries it.
func logsPlatform(rl plog.ResourceLogs) string {
	if p, ok := platformOf(rl.Resource().Attributes()); ok {
		return p
	}
	for i := range rl.ScopeLogs().Len() {
		records := rl.ScopeLogs().At(i).LogRecords()
		for j := range records.Len() {
			if p, ok := platformOf(records.At(j).Attributes()); ok {
				return p
			}
		}
	}
	return ""
}

func platformOf(m pcommon.Map) (string, bool) {
	v, ok := m.Get(keyPlatform)
	if !ok || v.Type() != pcommon.ValueTypeStr {
		return "", false
	}
	return v.Str(), true
}

// shiftTraces moves every span start, end and event timestamp by d.
func shiftTraces(td ptrace.Traces, d time.Duration) {
	for i := range td.ResourceSpans().Len() {
		scopes := td.ResourceSpans().At(i).ScopeSpans()
		for j := range scopes.Len() {
			spans := scopes.At(j).Spans()
			for k := range spans.Len() {
				s := spans.At(k)
				s.SetStartTimestamp(shift(s.StartTimestamp(), d))
				s.SetEndTimestamp(shift(s.EndTimestamp(), d))
				for e := range s.Events().Len() {
					ev := s.Events().At(e)
					ev.SetTimestamp(shift(ev.Timestamp(), d))
				}
			}
		}
	}
}

// shiftLogs moves every record's timestamp and observed timestamp by d.
func shiftLogs(ld plog.Logs, d time.Duration) {
	for i := range ld.ResourceLogs().Len() {
		scopes := ld.ResourceLogs().At(i).ScopeLogs()
		for j := range scopes.Len() {
			records := scopes.At(j).LogRecords()
			for k := range records.Len() {
				lr := records.At(k)
				lr.SetTimestamp(shift(lr.Timestamp(), d))
				lr.SetObservedTimestamp(shift(lr.ObservedTimestamp(), d))
			}
		}
	}
}

// shift moves a timestamp by d, leaving zero (unset) alone and refusing to
// go to or below zero.
func shift(ts pcommon.Timestamp, d time.Duration) pcommon.Timestamp {
	if ts == 0 {
		return 0
	}
	n := int64(ts) + int64(d) //nolint:gosec // OTLP timestamps fit in int64 until 2262
	if n <= 0 {
		return ts
	}
	return pcommon.Timestamp(n)
}
