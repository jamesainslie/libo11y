package lint

import (
	"fmt"
	"maps"
	"slices"
	"strings"
)

// lokiIndexLabels are the only labels a stream selector may use. Logs
// reach Loki through its native OTLP endpoint, so service.name is the
// service_name index label and every other attribute is structured
// metadata.
var lokiIndexLabels = map[string]bool{"service_name": true}

// lokiFields are the structured metadata fields the pack reads after the
// stream selector, as label filters or grouping labels.
var lokiFields = map[string]bool{
	"session_id":                 true,
	"o11y_rum_view_id":           true,
	"event_name":                 true,
	"o11y_rum_error_fingerprint": true,
	"o11y_rum_element_selector":  true,
	"o11y_rum_error_source":      true,
	"exception_type":             true,
	"o11y_rum_frustration_type":  true,
	"o11y_rum_view_name":         true,
	"o11y_rum_view_kind":         true,
}

// lokiGroupingKeywords introduce a parenthesised label list.
var lokiGroupingKeywords = map[string]bool{"by": true, "without": true, "on": true, "ignoring": true}

// lokiTemplateStages hold templates or new label names rather than
// references to existing fields, so their names are not checked.
var lokiTemplateStages = map[string]bool{"line_format": true, "label_format": true}

// CheckLogQL checks the structure of a LogQL query: exactly one stream
// selector, holding only index labels; structured metadata fields only
// after it; and only fields the pack knows in label filters and grouping.
func CheckLogQL(expr string) []error {
	toks, err := scan(expr, false)
	if err != nil {
		return []error{fmt.Errorf("%s: %w", expr, err)}
	}
	var errs []error
	errorf := func(format string, a ...any) {
		errs = append(errs, fmt.Errorf("%s: "+format, append([]any{expr}, a...)...))
	}
	selectors := 0
	inSelector, afterSelector, inTemplateStage := false, false, false
	for i, t := range toks {
		next := func(k int) token {
			if i+k < len(toks) {
				return toks[i+k]
			}
			return token{}
		}
		switch {
		case t.kind == tokOp && t.text == "{":
			if inSelector {
				errorf("nested braces in a stream selector")
			}
			selectors++
			inSelector = true
		case t.kind == tokOp && t.text == "}":
			inSelector, afterSelector = false, true
		case inSelector && t.kind == tokIdent && comparisons[next(1).text]:
			if !lokiIndexLabels[t.text] {
				if lokiFields[t.text] {
					errorf("%s is structured metadata, so it belongs after the stream selector, not in it", t.text)
				} else {
					errorf("%s is not an index label; the stream selector may only use %v", t.text, slices.Sorted(maps.Keys(lokiIndexLabels)))
				}
			}
		case t.kind == tokOp && t.text == "|":
			// A pipeline stage starts; a template stage's names are its own.
			if !afterSelector {
				errorf("a pipeline stage appears before the stream selector")
			}
			inTemplateStage = next(1).kind == tokIdent && lokiTemplateStages[next(1).text]
		case t.kind == tokOp && (t.text == "|=" || t.text == "|~"):
			inTemplateStage = false
		case t.kind == tokIdent && lokiGroupingKeywords[t.text] && next(1).text == "(":
			for j := i + 2; j < len(toks) && toks[j].text != ")"; j++ {
				if toks[j].kind == tokIdent && !lokiIndexLabels[toks[j].text] && !lokiFields[toks[j].text] {
					errorf("%s (...) uses %s, which is not a field the pack knows", t.text, toks[j].text)
				}
			}
		case afterSelector && !inSelector && !inTemplateStage && t.kind == tokIdent && comparisons[next(1).text]:
			if !lokiIndexLabels[t.text] && !lokiFields[t.text] {
				errorf("label filter on %s, which is not a field the pack knows", t.text)
			}
		}
	}
	if selectors != 1 {
		errorf("%d stream selectors, want exactly one", selectors)
	}
	return errs
}

// isQuoted reports whether a string token uses double quotes.
func isQuoted(t token) bool {
	return t.kind == tokString && strings.HasPrefix(t.text, `"`)
}
