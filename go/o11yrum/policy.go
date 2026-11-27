package o11yrum

import (
	"math"
	"net/url"
	"slices"
	"strings"
	"unicode/utf8"

	"go.opentelemetry.io/collector/pdata/pcommon"

	"github.com/jamesainslie/libo11y/go/o11yrum/internal/rumspec"
)

// attrPolicy re-applies the specification's attribute rules to client
// input: sensitivity classes, the o11y.* minting rule, registry types and
// enum members, and the configured size caps. Clients apply the same rules,
// but the gateway cannot trust them to.
type attrPolicy struct {
	allowPII    bool
	maxAttrs    int
	maxValueLen int
	maxArrayLen int
	queryAllow  map[string]bool
}

// gatewayOwned lists keys only the gateway sets, or that would carry the
// client address. Client input never keeps them.
var gatewayOwned = map[string]bool{
	keyBrowserFamily:       true,
	keyCountry:             true,
	keyErrorFingerprint:    true,
	"client.address":       true,
	"client.port":          true,
	"network.peer.address": true,
	"network.peer.port":    true,
	"http.client_ip":       true,
	"user_agent.original":  true,
}

func newAttrPolicy(app AppConfig, lim LimitsConfig) attrPolicy {
	allow := make(map[string]bool, len(app.QueryAllowList))
	for _, k := range app.QueryAllowList {
		allow[k] = true
	}
	return attrPolicy{
		allowPII:    app.PII == piiAllow,
		maxAttrs:    lim.MaxAttributes,
		maxValueLen: lim.MaxValueLength,
		maxArrayLen: lim.MaxArrayLength,
		queryAllow:  allow,
	}
}

// apply filters m in place and returns how many attributes it removed.
// Truncating a value does not count as a removal.
func (p attrPolicy) apply(m pcommon.Map) int {
	removed := 0
	m.RemoveIf(func(k string, v pcommon.Value) bool {
		if !p.keep(k, v) {
			removed++
			return true
		}
		return false
	})
	if m.Len() > p.maxAttrs {
		i := 0
		m.RemoveIf(func(string, pcommon.Value) bool {
			i++
			if i > p.maxAttrs {
				removed++
				return true
			}
			return false
		})
	}
	return removed
}

// keep decides one attribute and normalises its value in place.
func (p attrPolicy) keep(k string, v pcommon.Value) bool {
	if gatewayOwned[k] {
		return false
	}
	switch rumspec.Sensitivities[k] {
	case rumspec.Secret:
		return false
	case rumspec.PII:
		if !p.allowPII {
			return false
		}
	}
	if typ, defined := rumspec.Types[k]; defined {
		if !typeOK(k, typ, v) {
			return false
		}
	} else if isTemplateKey(k) {
		if v.Type() != pcommon.ValueTypeStr {
			return false
		}
	} else if strings.HasPrefix(k, "o11y.") {
		return false // only the specification mints o11y.* keys
	}
	if strings.HasPrefix(k, "o11y.rum.summary.") && !nonNegative(v) {
		return false
	}
	switch v.Type() {
	case pcommon.ValueTypeMap, pcommon.ValueTypeBytes:
		return false
	case pcommon.ValueTypeStr:
		s := v.Str()
		switch k {
		case keyURLFull:
			s = stripQuery(s, p.queryAllow, true)
		case keyURLQuery:
			s = stripQuery(s, p.queryAllow, false)
		}
		v.SetStr(truncateUTF8(s, p.maxValueLen))
	case pcommon.ValueTypeSlice:
		return p.keepSlice(v.Slice())
	}
	return true
}

// keepSlice caps an array value and its strings. An array holding maps,
// arrays or bytes is dropped whole.
func (p attrPolicy) keepSlice(s pcommon.Slice) bool {
	if s.Len() > p.maxArrayLen {
		i := 0
		s.RemoveIf(func(pcommon.Value) bool { i++; return i > p.maxArrayLen })
	}
	for j := range s.Len() {
		e := s.At(j)
		switch e.Type() {
		case pcommon.ValueTypeStr:
			e.SetStr(truncateUTF8(e.Str(), p.maxValueLen))
		case pcommon.ValueTypeMap, pcommon.ValueTypeSlice, pcommon.ValueTypeBytes:
			return false
		}
	}
	return true
}

// typeOK checks a value against its registry type, widening an int to a
// double where the registry says double.
func typeOK(k, typ string, v pcommon.Value) bool {
	switch {
	case typ == "int":
		return v.Type() == pcommon.ValueTypeInt
	case typ == "double":
		switch v.Type() {
		case pcommon.ValueTypeDouble:
			return !math.IsNaN(v.Double()) && !math.IsInf(v.Double(), 0)
		case pcommon.ValueTypeInt:
			v.SetDouble(float64(v.Int()))
			return true
		}
		return false
	case typ == "boolean":
		return v.Type() == pcommon.ValueTypeBool
	case typ == "enum":
		return v.Type() == pcommon.ValueTypeStr && slices.Contains(rumspec.Enums[k], v.Str())
	case typ == "string" || strings.HasPrefix(typ, "template"):
		return v.Type() == pcommon.ValueTypeStr
	}
	return true
}

// nonNegative reports whether a numeric value is at least zero. Summary
// counts and durations are never negative; other types pass.
func nonNegative(v pcommon.Value) bool {
	switch v.Type() {
	case pcommon.ValueTypeInt:
		return v.Int() >= 0
	case pcommon.ValueTypeDouble:
		return v.Double() >= 0
	}
	return true
}

// isTemplateKey reports whether k is <template>.<name> for a registry
// template attribute.
func isTemplateKey(k string) bool {
	for _, t := range rumspec.Templates {
		if len(k) > len(t)+1 && strings.HasPrefix(k, t+".") {
			return true
		}
	}
	return false
}

// truncateUTF8 cuts s to at most n bytes without splitting a rune.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// stripQuery keeps only allow-listed query parameters, sorted, and always
// drops the fragment, which can carry tokens. full says raw is a URL rather
// than a bare query string.
func stripQuery(raw string, allow map[string]bool, full bool) string {
	base, query := "", raw
	if full {
		raw, _, _ = strings.Cut(raw, "#")
		var found bool
		base, query, found = strings.Cut(raw, "?")
		if !found {
			return base
		}
	}
	// ParseQuery returns every pair it could parse alongside its error, so a
	// malformed pair is dropped like a parameter missing from the allow-list.
	values, _ := url.ParseQuery(query)
	for k := range values {
		if !allow[k] {
			delete(values, k)
		}
	}
	enc := values.Encode()
	if !full {
		return enc
	}
	if enc == "" {
		return base
	}
	return base + "?" + enc
}
