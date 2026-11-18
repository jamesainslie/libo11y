// Package specrules holds the naming and classification rules shared by the
// spec registry checks (internal/specgen) and the application registry
// validator (internal/appregistry), so both enforce one definition.
package specrules

import "regexp"

// namePattern matches a dotted attribute, event, or metric name: lowercase
// namespaces separated by dots, snake_case within a segment, at least two
// segments.
var namePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)*(\.[a-z][a-z0-9]*(_[a-z0-9]+)*)+$`)

// ValidName reports whether name is a well-formed attribute, event, or
// metric name.
func ValidName(name string) bool { return namePattern.MatchString(name) }

// IsSensitivity reports whether class is a sensitivity class the redaction
// layer understands.
func IsSensitivity(class string) bool {
	switch class {
	case "public", "internal", "pii", "secret":
		return true
	}
	return false
}

// IsCardinality reports whether class is a cardinality budget.
func IsCardinality(class string) bool {
	switch class {
	case "enum", "bounded", "unbounded":
		return true
	}
	return false
}
