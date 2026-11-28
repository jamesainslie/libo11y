package lint

import (
	"encoding/json"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"

	"github.com/jamesainslie/libo11y/ops/internal/dash"
)

var (
	dashboardUID = regexp.MustCompile(`^libo11y-[a-z0-9-]{1,32}$`)
	dashLinkUID  = regexp.MustCompile(`/d/([A-Za-z0-9_-]+)`)
)

// datasourceVars are the datasource variables the pack uses, by the UID a
// panel writes for each.
var datasourceVars = map[string]string{
	"${prometheus}": "prometheus",
	"${loki}":       "loki",
	"${tempo}":      "tempo",
}

// grafanaBuiltinUID is the UID of Grafana's own annotation datasource.
const grafanaBuiltinUID = "-- Grafana --"

// queryKeys are target fields that hold a query.
var queryKeys = []string{"expr", "query"}

const emDash = "\u2014"

// CheckDashboard checks the shape rules of one dashboard's JSON: its UID
// and schema version; unique panel IDs and non-overlapping grid positions
// inside 24 columns; datasources only through the pack's datasource
// variables, each defined; unique refIds per panel; only defined
// variables in queries; dashboard links only to UIDs in uids; and no em
// dash anywhere.
func CheckDashboard(raw []byte, uids map[string]bool) []error {
	var d map[string]any
	if err := json.Unmarshal(raw, &d); err != nil {
		return []error{fmt.Errorf("dashboard JSON: %w", err)}
	}
	uid, _ := d["uid"].(string)
	ck := dashChecker{uid: uid, vars: map[string]string{}}
	if !dashboardUID.MatchString(uid) {
		ck.errorf("uid %q does not match %s", uid, dashboardUID)
	}
	if v, _ := d["schemaVersion"].(float64); v != dash.SchemaVersion {
		ck.errorf("schemaVersion %v, want %d", d["schemaVersion"], dash.SchemaVersion)
	}
	if t, ok := d["templating"].(map[string]any); ok {
		for _, v := range asList(t["list"]) {
			m, _ := v.(map[string]any)
			name, _ := m["name"].(string)
			typ, _ := m["type"].(string)
			ck.vars[name] = typ
		}
	}
	ck.panels(asList(d["panels"]))
	ck.walk(d, "", uids)
	return ck.errs
}

type dashChecker struct {
	uid  string
	vars map[string]string // variable name -> type
	errs []error
	ids  map[float64]bool
	grid []rect
}

type rect struct {
	title      string
	x, y, w, h float64
}

func (ck *dashChecker) errorf(format string, a ...any) {
	ck.errs = append(ck.errs, fmt.Errorf("%s: "+format, append([]any{ck.uid}, a...)...))
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func (ck *dashChecker) panels(panels []any) {
	if ck.ids == nil {
		ck.ids = map[float64]bool{}
	}
	for _, p := range panels {
		m, ok := p.(map[string]any)
		if !ok {
			continue
		}
		title, _ := m["title"].(string)
		id, _ := m["id"].(float64)
		if ck.ids[id] {
			ck.errorf("panel id %v is used twice", id)
		}
		ck.ids[id] = true
		ck.gridPos(title, m["gridPos"])
		refs := map[string]bool{}
		for _, t := range asList(m["targets"]) {
			tm, _ := t.(map[string]any)
			ref, _ := tm["refId"].(string)
			if refs[ref] {
				ck.errorf("panel %q: refId %q is used twice", title, ref)
			}
			refs[ref] = true
			for _, k := range queryKeys {
				if q, ok := tm[k].(string); ok {
					ck.queryVars(title, q)
				}
			}
		}
		ck.panels(asList(m["panels"])) // a collapsed row holds its panels
	}
}

func (ck *dashChecker) gridPos(title string, v any) {
	g, _ := v.(map[string]any)
	num := func(k string) float64 { f, _ := g[k].(float64); return f }
	r := rect{title, num("x"), num("y"), num("w"), num("h")}
	if r.w <= 0 || r.h <= 0 || r.x < 0 || r.x+r.w > 24 {
		ck.errorf("panel %q: gridPos %+v does not fit in 24 columns", title, g)
	}
	for _, o := range ck.grid {
		if r.x < o.x+o.w && o.x < r.x+r.w && r.y < o.y+o.h && o.y < r.y+r.h {
			ck.errorf("panels %q and %q overlap", o.title, title)
		}
	}
	ck.grid = append(ck.grid, r)
}

func (ck *dashChecker) queryVars(title, q string) {
	for _, m := range variableRef.FindAllStringSubmatch(q, -1) {
		name := m[1] + m[2]
		if _, ok := ck.vars[name]; !ok && !isBuiltin(name) {
			ck.errorf("panel %q: query uses $%s, which is not a variable of the dashboard", title, name)
		}
	}
}

// walk visits every value: datasource references, link URLs and strings.
func (ck *dashChecker) walk(v any, key string, uids map[string]bool) {
	switch v := v.(type) {
	case map[string]any:
		for _, k := range slices.Sorted(maps.Keys(v)) {
			x := v[k]
			if strings.Contains(k, emDash) {
				ck.errorf("key %q contains an em dash", k)
			}
			if k == "datasource" {
				ck.datasource(x)
			}
			ck.walk(x, k, uids)
		}
	case []any:
		for _, x := range v {
			ck.walk(x, key, uids)
		}
	case string:
		if strings.Contains(v, emDash) {
			ck.errorf("%q contains an em dash", v)
		}
		if key == "url" {
			for _, m := range dashLinkUID.FindAllStringSubmatch(v, -1) {
				if !uids[m[1]] {
					ck.errorf("link %q names dashboard %s, which the pack does not have", v, m[1])
				}
			}
		}
	}
}

func (ck *dashChecker) datasource(v any) {
	if v == nil {
		return // the panel default, which Grafana resolves to the dashboard default
	}
	m, ok := v.(map[string]any)
	if !ok {
		ck.errorf("datasource %v is not an object; use one of %v", v, slices.Sorted(maps.Keys(datasourceVars)))
		return
	}
	uid, _ := m["uid"].(string)
	if uid == grafanaBuiltinUID {
		return
	}
	name, ok := datasourceVars[uid]
	if !ok {
		ck.errorf("datasource uid %q; use one of %v", uid, slices.Sorted(maps.Keys(datasourceVars)))
		return
	}
	if ck.vars[name] != "datasource" {
		ck.errorf("datasource %s needs a datasource variable named %s", uid, name)
	}
}

// isBuiltin reports whether name is a variable Grafana defines itself.
func isBuiltin(name string) bool {
	_, ok := builtins[name]
	return ok
}
