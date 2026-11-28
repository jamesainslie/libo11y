package dash

import "fmt"

// layout renders rows of panels onto Grafana's 24-column grid. Each row
// starts below the tallest panel of the row before it, its panels go left
// to right at their widths, and IDs count up from 1 in reading order.
func layout(rows [][]Panel) ([]any, error) {
	var out []any
	id, y := 1, 0
	for i, row := range rows {
		x, tallest := 0, 0
		for _, p := range row {
			w, h := p.size()
			if w <= 0 || h <= 0 {
				return nil, fmt.Errorf("dash: row %d: panel %q has size %dx%d", i, p.Title, w, h)
			}
			if x+w > gridWidth {
				return nil, fmt.Errorf("dash: row %d: panels are wider than %d columns at %q", i, gridWidth, p.Title)
			}
			out = append(out, p.render(id, x, y))
			id++
			x += w
			tallest = max(tallest, h)
		}
		y += tallest
	}
	return out, nil
}
