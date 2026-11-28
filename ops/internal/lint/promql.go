package lint

import (
	"fmt"
	"slices"
	"strings"

	"github.com/prometheus/common/model"
	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"

	"github.com/jamesainslie/libo11y/ops/internal/catalog"
)

// scrapeLabels are added to every series by the scrape.
var scrapeLabels = []string{"job", "instance"}

// counterFuncs need a counter, or a histogram's _bucket, _count or _sum.
var counterFuncs = map[string]bool{"rate": true, "increase": true, "irate": true}

// labelMakers name functions whose second argument is a label they add.
var labelMakers = map[string]bool{"label_replace": true, "label_join": true}

var promParser = parser.NewParser(parser.Options{})

// CheckPromQL parses expr and checks every selector and label against c.
// recorded maps each recording rule output to the labels it keeps. It
// returns every problem found, not only the first.
func CheckPromQL(expr string, c catalog.Catalog, recorded map[string][]string) []error {
	root, err := promParser.ParseExpr(expr)
	if err != nil {
		return []error{fmt.Errorf("parse %q: %w", expr, err)}
	}
	ck := promChecker{c: c, recorded: recorded}
	parser.Inspect(root, func(n parser.Node, _ []parser.Node) error {
		switch n := n.(type) {
		case *parser.VectorSelector:
			ck.selector(n)
		case *parser.AggregateExpr:
			ck.grouping(n, n.Grouping, "grouping")
		case *parser.BinaryExpr:
			if n.VectorMatching != nil {
				ck.grouping(n, n.VectorMatching.MatchingLabels, "matching")
				ck.grouping(n, n.VectorMatching.Include, "group_left/group_right")
			}
		case *parser.Call:
			ck.call(n)
		}
		return nil
	})
	for i := range ck.errs {
		ck.errs[i] = fmt.Errorf("%s: %w", expr, ck.errs[i])
	}
	return ck.errs
}

type promChecker struct {
	c        catalog.Catalog
	recorded map[string][]string
	errs     []error
}

func (ck *promChecker) errorf(format string, a ...any) {
	ck.errs = append(ck.errs, fmt.Errorf(format, a...))
}

// labelsOf returns the labels a series may carry, and whether the series is
// known at all.
func (ck *promChecker) labelsOf(name string) ([]string, bool) {
	if l, ok := ck.recorded[name]; ok {
		return l, true
	}
	f, ok := ck.c.Resolve(name)
	if !ok {
		return nil, false
	}
	l := slices.Concat(f.Labels, scrapeLabels)
	if f.Type == "histogram" && strings.HasSuffix(name, "_bucket") {
		l = append(l, "le")
	}
	return l, true
}

func selectorName(vs *parser.VectorSelector) string {
	if vs.Name != "" {
		return vs.Name
	}
	for _, m := range vs.LabelMatchers {
		if m.Name == model.MetricNameLabel && m.Type == labels.MatchEqual {
			return m.Value
		}
	}
	return ""
}

func (ck *promChecker) selector(vs *parser.VectorSelector) {
	name := selectorName(vs)
	if name == "" {
		ck.errorf("selector %s has no metric name", vs)
		return
	}
	known, ok := ck.labelsOf(name)
	if !ok {
		ck.errorf("unknown metric %s: it is neither in the gateway's catalog nor a recording rule output", name)
		return
	}
	if f, ok := ck.c[name]; ok && f.Type == "histogram" {
		ck.errorf("%s is a classic histogram with no series of its own; query %s_bucket, %s_sum or %s_count", name, name, name, name)
	}
	for _, m := range vs.LabelMatchers {
		if m.Name == model.MetricNameLabel {
			continue
		}
		if !slices.Contains(known, m.Name) {
			ck.errorf("label %s is not a label of %s", m.Name, name)
		}
	}
}

// available returns every label the series under n may carry, including
// labels that label_replace or label_join under n add.
func (ck *promChecker) available(n parser.Node) map[string]bool {
	out := map[string]bool{}
	parser.Inspect(n, func(n parser.Node, _ []parser.Node) error {
		switch n := n.(type) {
		case *parser.VectorSelector:
			l, _ := ck.labelsOf(selectorName(n))
			for _, k := range l {
				out[k] = true
			}
		case *parser.Call:
			if labelMakers[n.Func.Name] && len(n.Args) > 1 {
				if s, ok := n.Args[1].(*parser.StringLiteral); ok {
					out[s.Val] = true
				}
			}
		}
		return nil
	})
	return out
}

func (ck *promChecker) grouping(n parser.Node, names []string, what string) {
	if len(names) == 0 {
		return
	}
	have := ck.available(n)
	for _, l := range names {
		if !have[l] {
			ck.errorf("%s label %s is not a label of any series under it", what, l)
		}
	}
}

func (ck *promChecker) call(n *parser.Call) {
	switch {
	case counterFuncs[n.Func.Name]:
		ck.counterArg(n)
	case n.Func.Name == "histogram_quantile" && len(n.Args) == 2:
		agg, ok := unparen(n.Args[1]).(*parser.AggregateExpr)
		if !ok || agg.Without || !slices.Contains(agg.Grouping, "le") {
			ck.errorf("histogram_quantile must wrap an aggregation that groups by le")
		}
	}
}

func (ck *promChecker) counterArg(n *parser.Call) {
	if len(n.Args) != 1 {
		return
	}
	ms, ok := n.Args[0].(*parser.MatrixSelector)
	if !ok {
		return // a subquery; its inner selectors are checked on their own
	}
	vs, ok := ms.VectorSelector.(*parser.VectorSelector)
	if !ok {
		return
	}
	name := selectorName(vs)
	f, ok := ck.c.Resolve(name)
	if !ok {
		if _, rec := ck.recorded[name]; rec {
			ck.errorf("%s needs a counter, and %s is a recording rule output", n.Func.Name, name)
		}
		return // an unknown metric is reported by selector
	}
	switch {
	case f.Type == "counter":
	case f.Type == "histogram" && name != f.Name:
	default:
		ck.errorf("%s needs a counter or a histogram's _bucket, _count or _sum series, and %s is a %s", n.Func.Name, name, f.Type)
	}
}

func unparen(e parser.Expr) parser.Expr {
	for {
		p, ok := e.(*parser.ParenExpr)
		if !ok {
			return e
		}
		e = p.Expr
	}
}
