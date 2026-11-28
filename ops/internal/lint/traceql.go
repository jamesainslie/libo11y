package lint

import (
	"fmt"
	"regexp"
	"strings"
)

// traceAttributes are the attributes the pack's TraceQL may read.
var traceAttributes = map[string]bool{
	"session.id":          true,
	"o11y.rum.view.id":    true,
	"o11y.rum.span.shape": true,
	"o11y.rum.view.name":  true,
	"service.name":        true,
}

// traceScopes are the attribute scopes the pack's TraceQL may use.
var traceScopes = []string{"span.", "resource."}

// traceKeywords are names TraceQL itself defines.
var traceKeywords = map[string]bool{"true": true, "false": true, "nil": true}

var spansetFilter = regexp.MustCompile(`(?s)^\{\s*\S.*\}$`)

// CheckTraceQL checks the query is one {...} spanset filter on span. or
// resource. attributes the pack knows, and that string comparisons use =
// or =~ with a double-quoted value.
func CheckTraceQL(q string) []error {
	q = strings.TrimSpace(q)
	if !spansetFilter.MatchString(q) {
		return []error{fmt.Errorf("%s: not a non-empty {...} spanset filter", q)}
	}
	toks, err := scan(q, true)
	if err != nil {
		return []error{fmt.Errorf("%s: %w", q, err)}
	}
	var errs []error
	errorf := func(format string, a ...any) {
		errs = append(errs, fmt.Errorf("%s: "+format, append([]any{q}, a...)...))
	}
	braces := 0
	for i, t := range toks {
		if t.kind == tokOp && t.text == "{" {
			braces++
		}
		if t.kind != tokIdent || traceKeywords[t.text] {
			continue
		}
		name, scoped := "", false
		for _, s := range traceScopes {
			if n, ok := strings.CutPrefix(t.text, s); ok {
				name, scoped = n, true
			}
		}
		if !scoped {
			errorf("%s is not a span. or resource. attribute", t.text)
			continue
		}
		if !traceAttributes[name] {
			errorf("attribute %s is not one the pack reads", name)
		}
		if i+2 >= len(toks) {
			errorf("%s is not compared with anything", t.text)
			continue
		}
		op, val := toks[i+1], toks[i+2]
		if op.kind != tokOp || !comparisons[op.text] {
			errorf("%s is not compared with anything", t.text)
			continue
		}
		switch {
		case val.kind == tokString && !isQuoted(val):
			errorf("%s compares with %s; string values must be double-quoted", t.text, val.text)
		case val.kind == tokString && op.text != "=" && op.text != "=~":
			errorf("%s uses %s; string comparisons must use = or =~", t.text, op.text)
		case val.kind == tokIdent && !traceKeywords[val.text]:
			errorf("%s compares with %s; string values must be double-quoted", t.text, val.text)
		}
	}
	if braces != 1 {
		errs = append(errs, fmt.Errorf("%s: %d spanset filters, want one", q, braces))
	}
	return errs
}
