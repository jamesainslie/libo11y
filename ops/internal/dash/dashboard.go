// Package dash builds Grafana dashboard JSON from Go values. The output is
// deterministic, so generated dashboards diff cleanly and a drift test can
// compare them byte for byte.
package dash

import (
	"encoding/json"
	"fmt"
	"slices"
)

// SchemaVersion is the dashboard schema the pack targets, Grafana 11.0 or
// later.
const SchemaVersion = 39

// Variable is one templating variable.
type Variable struct {
	Name, Label, Type string // Type is datasource, query, textbox or custom
	Datasource        *Datasource
	// Query is the plugin type of a datasource variable, the
	// label_values() query of a query variable, and the comma-separated
	// values of a custom variable.
	Query             string
	Multi, IncludeAll bool
	AllValue          string
	Default           string
	Hide              int
}

// Dashboard is one Grafana dashboard.
type Dashboard struct {
	UID, Title, Description string
	Tags                    []string
	Variables               []Variable
	Rows                    [][]Panel // each inner slice fills 24 columns left to right
	Links                   []Link
}

// JSON renders the dashboard with sorted keys, a two-space indent and a
// trailing newline.
func (d Dashboard) JSON() ([]byte, error) {
	if d.UID == "" || d.Title == "" {
		return nil, fmt.Errorf("dash: a dashboard needs a uid and a title")
	}
	panels, err := layout(d.Rows)
	if err != nil {
		return nil, fmt.Errorf("dash: %s: %w", d.UID, err)
	}
	vars := make([]any, 0, len(d.Variables))
	for _, v := range d.Variables {
		r, err := v.render()
		if err != nil {
			return nil, fmt.Errorf("dash: %s: %w", d.UID, err)
		}
		vars = append(vars, r)
	}
	links := make([]any, 0, len(d.Links))
	for _, l := range d.Links {
		links = append(links, map[string]any{"title": l.Title, "url": l.URL, "type": "link", "targetBlank": false})
	}
	tags := slices.Clone(d.Tags)
	if !slices.Contains(tags, "libo11y") {
		tags = append([]string{"libo11y"}, tags...)
	}
	if panels == nil {
		panels = []any{}
	}
	v := map[string]any{
		"uid":           d.UID,
		"title":         d.Title,
		"description":   d.Description,
		"tags":          tags,
		"schemaVersion": SchemaVersion,
		"version":       1,
		"editable":      true,
		"graphTooltip":  1,
		"time":          map[string]any{"from": "now-6h", "to": "now"},
		"refresh":       "",
		"timezone":      "",
		"links":         links,
		"templating":    map[string]any{"list": vars},
		"annotations":   map[string]any{"list": []any{builtinAnnotation}},
		"panels":        panels,
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("dash: %s: %w", d.UID, err)
	}
	return append(b, '\n'), nil
}

// builtinAnnotation is Grafana's own annotations and alerts query, which
// every dashboard carries.
var builtinAnnotation = map[string]any{
	"builtIn":    1,
	"datasource": map[string]any{"type": "grafana", "uid": "-- Grafana --"},
	"enable":     true,
	"hide":       true,
	"iconColor":  "rgba(0, 211, 255, 1)",
	"name":       "Annotations & Alerts",
	"type":       "dashboard",
}

func (v Variable) render() (map[string]any, error) {
	out := map[string]any{"name": v.Name, "label": v.Label, "type": v.Type, "hide": v.Hide}
	current := map[string]any{}
	if v.Default != "" {
		current = map[string]any{"text": v.Default, "value": v.Default}
	}
	switch v.Type {
	case "datasource":
		out["query"] = v.Query
		out["current"] = map[string]any{}
		out["refresh"] = 1
	case "query":
		if v.Datasource == nil {
			return nil, fmt.Errorf("variable %s: a query variable needs a datasource", v.Name)
		}
		out["datasource"] = *v.Datasource
		out["definition"] = v.Query
		out["query"] = map[string]any{"query": v.Query, "refId": "Var"}
		out["refresh"] = 2
		out["multi"] = v.Multi
		out["includeAll"] = v.IncludeAll
		out["allValue"] = v.AllValue
		out["current"] = current
		out["sort"] = 1
	case "textbox":
		out["query"] = v.Default
		out["current"] = map[string]any{"text": v.Default, "value": v.Default}
	case "custom":
		out["query"] = v.Query
		out["multi"] = v.Multi
		out["includeAll"] = v.IncludeAll
		out["allValue"] = v.AllValue
		out["current"] = current
	default:
		return nil, fmt.Errorf("variable %s: unknown type %q", v.Name, v.Type)
	}
	return out, nil
}
