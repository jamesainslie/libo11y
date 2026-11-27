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
	// metricLabels is the app's app_metric_labels.
	metricLabels map[string]bool
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
	labels := make(map[string]bool, len(app.AppMetricLabels))
	for _, k := range app.AppMetricLabels {
		labels[k] = true
	}
	return attrPolicy{
		allowPII:     app.PII == piiAllow,
		metricLabels: labels,
		maxAttrs:     lim.MaxAttributes,
		maxValueLen:  lim.MaxValueLength,
		maxArrayLen:  lim.MaxArrayLength,
		queryAllow:   allow,
	}
}

// apply filters m in place and returns how many attributes it removed.
// Truncating a value does not count as a removal. A key repeated on the
// wire keeps only its first value, because pdata keeps both and readers
// disagree on which one wins. The count cap never removes service.name.
func (p attrPolicy) apply(m pcommon.Map) int {
	removed := 0
	seen := make(map[string]bool, m.Len())
	m.RemoveIf(func(k string, v pcommon.Value) bool {
		if seen[k] || !p.keep(k, v) {
			removed++
			return true
		}
		seen[k] = true
		return false
	})
	if m.Len() > p.maxAttrs {
		budget := p.maxAttrs
		if seen[keyServiceName] {
			budget--
		}
		i := 0
		m.RemoveIf(func(k string, _ pcommon.Value) bool {
			if k == keyServiceName {
				return false
			}
			i++
			if i > budget {
				removed++
				return true
			}
			return false
		})
	}
	return removed
}

// urlForms says how each URL-bearing key is cleaned: true for a URL or a
// path with a query, false for a bare query string.
var urlForms = map[string]bool{
	keyURLFull:     true,
	"url.original": true,
	"http.url":     true,
	"http.target":  true,
	keyURLQuery:    false,
}

// sensitivityKey is the key looked up in the sensitivity table. HTTP
// header names are case-insensitive, so header attribute keys are
// lowercased: http.request.header.Authorization is still a secret.
func sensitivityKey(k string) string {
	if strings.HasPrefix(k, "http.request.header.") || strings.HasPrefix(k, "http.response.header.") {
		return strings.ToLower(k)
	}
	return k
}

// keep decides one attribute and normalises its value in place.
func (p attrPolicy) keep(k string, v pcommon.Value) bool {
	if gatewayOwned[k] {
		return false
	}
	switch rumspec.Sensitivities[sensitivityKey(k)] {
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
	full, isURL := urlForms[k]
	if isURL && v.Type() != pcommon.ValueTypeStr {
		return false // a URL that is not a string cannot be cleaned
	}
	switch v.Type() {
	case pcommon.ValueTypeMap, pcommon.ValueTypeBytes:
		return false
	case pcommon.ValueTypeStr:
		s := v.Str()
		if isURL {
			s = stripQuery(s, p.queryAllow, full)
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
	_, ok := templateOf(k)
	return ok
}

// templateOf returns the registry template attribute k instantiates.
func templateOf(k string) (string, bool) {
	for _, t := range rumspec.Templates {
		if len(k) > len(t)+1 && strings.HasPrefix(k, t+".") {
			return t, true
		}
	}
	return "", false
}

// specClasses returns the sensitivity and cardinality the specification
// gives k. A template instance, such as o11y.label.step, takes its
// template's classes.
func specClasses(k string) (rumspec.Sensitivity, rumspec.Cardinality) {
	key := sensitivityKey(k)
	if t, ok := templateOf(k); ok {
		key = t
	}
	return rumspec.Sensitivities[key], rumspec.Cardinalities[key]
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
// drops the fragment, which can carry tokens. full says raw is a URL (or a
// path with a query) rather than a bare query string; a URL also loses any
// user name and password.
func stripQuery(raw string, allow map[string]bool, full bool) string {
	base, query := "", raw
	if full {
		raw, _, _ = strings.Cut(raw, "#")
		var found bool
		base, query, found = strings.Cut(raw, "?")
		base = removeUserinfo(base)
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

// removeUserinfo drops the user[:password]@ part of a URL's authority.
func removeUserinfo(s string) string {
	scheme, rest, found := strings.Cut(s, "://")
	if !found {
		return s
	}
	end := strings.IndexAny(rest, "/?#")
	if end < 0 {
		end = len(rest)
	}
	at := strings.LastIndex(rest[:end], "@")
	if at < 0 {
		return s
	}
	return scheme + "://" + rest[at+1:]
}

// metricLabel reports whether an app metric point keeps the attribute k:
// the specification classifies it bounded or enum, or the app lists it in
// app_metric_labels. Keys the specification classifies PII, secret or
// unbounded are never kept, whatever the app's pii mode, because a label
// is copied into every series the gateway exports.
func (p attrPolicy) metricLabel(k string) bool {
	sens, card := specClasses(k)
	switch {
	case sens == rumspec.PII || sens == rumspec.Secret || card == rumspec.Unbounded:
		return false
	case card == rumspec.Enum || card == rumspec.Bounded:
		return true
	default:
		return p.metricLabels[k]
	}
}
