package dash

import "maps"

// Link is a dashboard link or a panel data link.
type Link struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

// Step is one absolute threshold step. The base step has a nil Value.
type Step struct {
	Color string
	Value *float64
}

// Panel is one Grafana panel. Layout fields other than W and H are worked
// out by the dashboard.
type Panel struct {
	Type        string // timeseries, stat, table, logs, text, bargauge, row
	Title       string
	Description string
	W, H        int // H defaults to 8; a row is always 24 by 1
	Datasource  *Datasource
	Targets     []Target
	Unit        string // fieldConfig.defaults.unit
	Thresholds  []Step // fieldConfig.defaults.thresholds, absolute
	Options     map[string]any
	Overrides   []any
	Transforms  []any
	Links       []Link // fieldConfig.defaults.links (data links)
	Content     string // text panels (markdown)
}

// Row panels span the grid and are one unit tall.
const (
	gridWidth     = 24
	defaultHeight = 8
)

func (p Panel) isRow() bool { return p.Type == "row" }

// size returns the panel's width and height on the grid.
func (p Panel) size() (w, h int) {
	if p.isRow() {
		return gridWidth, 1
	}
	h = p.H
	if h == 0 {
		h = defaultHeight
	}
	return p.W, h
}

// render returns the panel's JSON form at the given ID and position.
func (p Panel) render(id, x, y int) map[string]any {
	w, h := p.size()
	out := map[string]any{
		"id":      id,
		"type":    p.Type,
		"title":   p.Title,
		"gridPos": map[string]any{"x": x, "y": y, "w": w, "h": h},
	}
	if p.Description != "" {
		out["description"] = p.Description
	}
	if p.isRow() {
		out["collapsed"] = false
		out["panels"] = []any{}
		return out
	}
	if p.Datasource != nil {
		out["datasource"] = *p.Datasource
	}
	targets := make([]any, 0, len(p.Targets))
	for _, t := range p.Targets {
		c := maps.Clone(t)
		if _, set := c["datasource"]; !set && p.Datasource != nil {
			c["datasource"] = *p.Datasource
		}
		targets = append(targets, c)
	}
	out["targets"] = targets
	opts := maps.Clone(p.Options)
	if opts == nil {
		opts = map[string]any{}
	}
	if p.Type == "text" {
		opts["mode"] = "markdown"
		opts["content"] = p.Content
	}
	out["options"] = opts
	out["transformations"] = orEmpty(p.Transforms)
	out["fieldConfig"] = map[string]any{
		"defaults":  p.defaults(),
		"overrides": orEmpty(p.Overrides),
	}
	return out
}

func (p Panel) defaults() map[string]any {
	d := map[string]any{}
	if p.Unit != "" {
		d["unit"] = p.Unit
	}
	if len(p.Thresholds) > 0 {
		steps := make([]any, 0, len(p.Thresholds))
		for _, s := range p.Thresholds {
			var v any // a nil Value renders as null
			if s.Value != nil {
				v = *s.Value
			}
			steps = append(steps, map[string]any{"color": s.Color, "value": v})
		}
		d["thresholds"] = map[string]any{"mode": "absolute", "steps": steps}
	}
	if len(p.Links) > 0 {
		links := make([]any, 0, len(p.Links))
		for _, l := range p.Links {
			links = append(links, map[string]any{"title": l.Title, "url": l.URL})
		}
		d["links"] = links
	}
	return d
}

// orEmpty renders a nil list as [] rather than null.
func orEmpty(v []any) []any {
	if v == nil {
		return []any{}
	}
	return v
}
