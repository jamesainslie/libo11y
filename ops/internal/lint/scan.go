package lint

import (
	"fmt"
	"strings"
	"unicode"
)

// token kinds of the small query scanner.
const (
	tokIdent  = iota // a name; dots are kept when the scanner allows them
	tokString        // a quoted string, quotes included
	tokNumber        // a number or a duration such as 5m
	tokOp            // an operator or punctuation
)

type token struct {
	kind int
	text string
}

// operators, longest first so "=~" wins over "=".
var operators = []string{"|=", "|~", "!=", "!~", "=~", "==", ">=", "<=", "&&", "||", "=", ">", "<", "|", "{", "}", "(", ")", "[", "]", ",", "!", "+", "-", "*", "/", "%", "^"}

// scan splits a LogQL or TraceQL query into tokens. It is not a parser:
// it knows strings, names, numbers and operators, which is all the
// structure checks need. dotted keeps dots inside names, for TraceQL
// attribute references.
func scan(q string, dotted bool) ([]token, error) {
	var out []token
	for i := 0; i < len(q); {
		r := rune(q[i])
		switch {
		case unicode.IsSpace(r):
			i++
		case r == '"' || r == '`' || r == '\'':
			end := closeQuote(q, i)
			if end < 0 {
				return nil, fmt.Errorf("unterminated string at offset %d", i)
			}
			out = append(out, token{tokString, q[i : end+1]})
			i = end + 1
		case r == '_' || unicode.IsLetter(r) || (dotted && r == '.'):
			j := i + 1
			for j < len(q) && (q[j] == '_' || q[j] == '.' && dotted || unicode.IsLetter(rune(q[j])) || unicode.IsDigit(rune(q[j]))) {
				j++
			}
			out = append(out, token{tokIdent, q[i:j]})
			i = j
		case unicode.IsDigit(r):
			j := i + 1
			for j < len(q) && (q[j] == '.' || unicode.IsLetter(rune(q[j])) || unicode.IsDigit(rune(q[j]))) {
				j++
			}
			out = append(out, token{tokNumber, q[i:j]})
			i = j
		default:
			op := ""
			for _, o := range operators {
				if strings.HasPrefix(q[i:], o) {
					op = o
					break
				}
			}
			if op == "" {
				return nil, fmt.Errorf("unexpected %q at offset %d", r, i)
			}
			out = append(out, token{tokOp, op})
			i += len(op)
		}
	}
	return out, nil
}

// closeQuote returns the index of the quote that closes the string opened
// at q[i], or -1. Backtick strings have no escapes.
func closeQuote(q string, i int) int {
	quote := q[i]
	for j := i + 1; j < len(q); j++ {
		switch {
		case q[j] == '\\' && quote != '`':
			j++
		case q[j] == quote:
			return j
		}
	}
	return -1
}

// comparisons are the operators of a label matcher or label filter.
var comparisons = map[string]bool{"=": true, "!=": true, "=~": true, "!~": true, "==": true, ">": true, ">=": true, "<": true, "<=": true}
