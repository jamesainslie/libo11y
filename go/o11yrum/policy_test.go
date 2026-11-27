package o11yrum

import (
	"reflect"
	"strings"
	"testing"

	"go.opentelemetry.io/collector/pdata/pcommon"
)

func TestAttrPolicy(t *testing.T) {
	lim := LimitsConfig{MaxAttributes: 128, MaxValueLength: 16, MaxArrayLength: 2, MaxSpanEvents: 8, MaxSpanLinks: 8}
	drop := newAttrPolicy(AppConfig{PII: "drop", QueryAllowList: []string{"page"}}, lim)
	allow := newAttrPolicy(AppConfig{PII: "allow"}, lim)
	urls := newAttrPolicy(AppConfig{PII: "drop", QueryAllowList: []string{"page"}}, LimitsConfig{MaxAttributes: 128, MaxValueLength: 64, MaxArrayLength: 2})
	for name, tc := range map[string]struct {
		p      attrPolicy
		set    func(pcommon.Map)
		want   map[string]any // remaining attributes as m.AsRaw()
		remove int
	}{
		"pii dropped by default":        {drop, func(m pcommon.Map) { m.PutStr("o11y.rum.element.text", "Pay now") }, map[string]any{}, 1},
		"pii kept when allowed":         {allow, func(m pcommon.Map) { m.PutStr("o11y.rum.element.text", "Pay now") }, map[string]any{"o11y.rum.element.text": "Pay now"}, 0},
		"secret always dropped":         {allow, func(m pcommon.Map) { m.PutStr("http.request.header.authorization", "Bearer x") }, map[string]any{}, 1},
		"unminted o11y key dropped":     {drop, func(m pcommon.Map) { m.PutStr("o11y.rum.made.up", "x") }, map[string]any{}, 1},
		"template key kept":             {drop, func(m pcommon.Map) { m.PutStr("o11y.label.team", "web") }, map[string]any{"o11y.label.team": "web"}, 0},
		"template value must be string": {drop, func(m pcommon.Map) { m.PutInt("o11y.label.team", 1) }, map[string]any{}, 1},
		"bare template prefix dropped":  {drop, func(m pcommon.Map) { m.PutStr("o11y.label.", "x") }, map[string]any{}, 1},
		"app key kept":                  {drop, func(m pcommon.Map) { m.PutStr("shop.cart.size", "3") }, map[string]any{"shop.cart.size": "3"}, 0},
		"enum member kept":              {drop, func(m pcommon.Map) { m.PutStr("o11y.rum.platform", "web") }, map[string]any{"o11y.rum.platform": "web"}, 0},
		"enum non-member dropped":       {drop, func(m pcommon.Map) { m.PutStr("o11y.rum.platform", "desktop") }, map[string]any{}, 1},
		"enum non-string dropped":       {drop, func(m pcommon.Map) { m.PutInt("o11y.rum.platform", 1) }, map[string]any{}, 1},
		"int type enforced":             {drop, func(m pcommon.Map) { m.PutStr("o11y.rum.summary.seq", "0") }, map[string]any{}, 1},
		"int accepted for double":       {drop, func(m pcommon.Map) { m.PutInt("o11y.rum.summary.lcp.value", 2) }, map[string]any{"o11y.rum.summary.lcp.value": 2.0}, 0},
		"string refused for double":     {drop, func(m pcommon.Map) { m.PutStr("o11y.rum.summary.lcp.value", "2") }, map[string]any{}, 1},
		"double kept":                   {drop, func(m pcommon.Map) { m.PutDouble("o11y.rum.summary.cls.value", 0.05) }, map[string]any{"o11y.rum.summary.cls.value": 0.05}, 0},
		"string type enforced":          {drop, func(m pcommon.Map) { m.PutInt("o11y.rum.view.name", 3) }, map[string]any{}, 1},
		"boolean type enforced":         {drop, func(m pcommon.Map) { m.PutStr("o11y.build.modified", "true") }, map[string]any{}, 1},
		"boolean kept":                  {drop, func(m pcommon.Map) { m.PutBool("o11y.build.modified", true) }, map[string]any{"o11y.build.modified": true}, 0},
		"negative count dropped":        {drop, func(m pcommon.Map) { m.PutInt("o11y.rum.summary.requests", -1) }, map[string]any{}, 1},
		"negative summary double":       {drop, func(m pcommon.Map) { m.PutDouble("o11y.rum.summary.time_on_view", -0.5) }, map[string]any{}, 1},
		"gateway-owned dropped": {drop, func(m pcommon.Map) {
			m.PutStr("o11y.rum.browser.family", "chrome")
			m.PutStr("client.address", "1.2.3.4")
		}, map[string]any{}, 2},
		"client address forms dropped": {allow, func(m pcommon.Map) {
			m.PutStr("network.peer.address", "1.2.3.4")
			m.PutStr("http.client_ip", "1.2.3.4")
		}, map[string]any{}, 2},
		"long string truncated": {drop, func(m pcommon.Map) { m.PutStr("shop.note", strings.Repeat("é", 10)) }, map[string]any{"shop.note": strings.Repeat("é", 8)}, 0},
		"array truncated": {drop, func(m pcommon.Map) {
			s := m.PutEmptySlice("shop.tags")
			s.AppendEmpty().SetStr("a")
			s.AppendEmpty().SetStr("b")
			s.AppendEmpty().SetStr("c")
		}, map[string]any{"shop.tags": []any{"a", "b"}}, 0},
		"array strings truncated":        {drop, func(m pcommon.Map) { m.PutEmptySlice("shop.tags").AppendEmpty().SetStr(strings.Repeat("x", 20)) }, map[string]any{"shop.tags": []any{strings.Repeat("x", 16)}}, 0},
		"nested array dropped":           {drop, func(m pcommon.Map) { m.PutEmptySlice("shop.tags").AppendEmpty().SetEmptySlice() }, map[string]any{}, 1},
		"map value dropped":              {drop, func(m pcommon.Map) { m.PutEmptyMap("shop.nested").PutStr("k", "v") }, map[string]any{}, 1},
		"bytes value dropped":            {drop, func(m pcommon.Map) { m.PutEmptyBytes("shop.blob").FromRaw([]byte{1}) }, map[string]any{}, 1},
		"query stripped":                 {urls, func(m pcommon.Map) { m.PutStr("url.full", "https://s/p?page=2&token=x#frag") }, map[string]any{"url.full": "https://s/p?page=2"}, 0},
		"query removed when none listed": {urls, func(m pcommon.Map) { m.PutStr("url.full", "https://s/p?token=x") }, map[string]any{"url.full": "https://s/p"}, 0},
		"fragment removed without query": {urls, func(m pcommon.Map) { m.PutStr("url.full", "https://s/p#access_token=x") }, map[string]any{"url.full": "https://s/p"}, 0},
		"url.query stripped":             {urls, func(m pcommon.Map) { m.PutStr("url.query", "token=x") }, map[string]any{"url.query": ""}, 0},
		"url.query keeps allowed":        {urls, func(m pcommon.Map) { m.PutStr("url.query", "token=x&page=3") }, map[string]any{"url.query": "page=3"}, 0},
	} {
		t.Run(name, func(t *testing.T) {
			m := pcommon.NewMap()
			tc.set(m)
			if got := tc.p.apply(m); got != tc.remove {
				t.Errorf("removed %d, want %d", got, tc.remove)
			}
			if got := m.AsRaw(); !rawEqual(got, tc.want) {
				t.Errorf("attributes %v, want %v", got, tc.want)
			}
		})
	}
}

func TestAttrPolicyCountCap(t *testing.T) {
	p := newAttrPolicy(AppConfig{PII: "drop"}, LimitsConfig{MaxAttributes: 2, MaxValueLength: 64, MaxArrayLength: 4})
	m := pcommon.NewMap()
	m.PutStr("a.one", "1")
	m.PutStr("a.two", "2")
	m.PutStr("a.three", "3")
	if got := p.apply(m); got != 1 || m.Len() != 2 {
		t.Fatalf("removed %d, len %d", got, m.Len())
	}
	if _, ok := m.Get("a.three"); ok {
		t.Fatal("the cap must keep the first attributes in order")
	}
}

func TestTruncateUTF8(t *testing.T) {
	for _, tc := range []struct {
		in   string
		n    int
		want string
	}{
		{"hello", 10, "hello"},
		{"hello", 3, "hel"},
		{"héllo", 2, "h"},
		{"héllo", 3, "hé"},
		{"€", 2, ""},
		{"", 0, ""},
	} {
		if got := truncateUTF8(tc.in, tc.n); got != tc.want {
			t.Errorf("truncateUTF8(%q, %d) = %q, want %q", tc.in, tc.n, got, tc.want)
		}
	}
}

// rawEqual compares two AsRaw maps, treating nil and empty as equal.
func rawEqual(a, b map[string]any) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return reflect.DeepEqual(a, b)
}
