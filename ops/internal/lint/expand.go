// Package lint checks the pack's queries and dashboards. PromQL is parsed
// with the Prometheus parser and checked against the metric catalog the
// gateway really exports. LogQL and TraceQL are checked for structure, so
// session and view IDs are only ever read as structured metadata or span
// attributes, never as index labels.
package lint

import (
	"fmt"
	"regexp"
)

// builtins are the variables Grafana defines on every dashboard, with the
// values they take when a query is checked outside Grafana.
var builtins = map[string]string{
	"__rate_interval": "5m",
	"__interval":      "1m",
	"__interval_ms":   "60000",
	"__range":         "1h",
	"__range_s":       "3600",
	"__range_ms":      "3600000",
	"__from":          "0",
	"__to":            "0",
	"__dashboard":     "dashboard",
	"__org":           "1",
	"__user":          "user",
}

// variableRef matches $name, ${name} and ${name:format}, with any
// number of formats. A $ followed by
// a digit, as in label_replace's "$1", is not a variable.
var variableRef = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::[A-Za-z]+)*\}|\$([A-Za-z_][A-Za-z0-9_]*)`)

// Expand replaces Grafana variables in a query: $name, ${name} and
// ${name:fmt}. The built-ins $__rate_interval, $__interval and $__range
// become 5m, 1m and 1h. Link URLs, which hold ${__data...} and
// ${__url_time_range}, are not queries and are never expanded. An unknown
// name is an error.
func Expand(q string, vars map[string]string) (string, error) {
	var unknown []string
	out := variableRef.ReplaceAllStringFunc(q, func(ref string) string {
		m := variableRef.FindStringSubmatch(ref)
		name := m[1] + m[2]
		if v, ok := vars[name]; ok {
			return v
		}
		if v, ok := builtins[name]; ok {
			return v
		}
		unknown = append(unknown, "$"+name)
		return ref
	})
	if len(unknown) > 0 {
		return "", fmt.Errorf("unknown variables %v in %q", unknown, q)
	}
	return out, nil
}
