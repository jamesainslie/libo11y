// Package conformance checks emitted telemetry against the registered
// specification contracts. It lives under internal so the library's own
// tests and the o11ytest harness can enforce one shared definition.
package conformance

import (
	"fmt"
	"slices"
	"strings"

	"github.com/jamesainslie/libo11y/go/internal/spectables"
)

// CheckEvent reports every way a record for the named event, carrying the
// given attribute keys, violates its registered contract. Unregistered event
// names have no contract and yield nil.
func CheckEvent(name string, keys []string) []string {
	info, ok := spectables.Events[name]
	if !ok {
		return nil
	}
	present := make(map[string]bool, len(keys))
	for _, k := range keys {
		present[k] = true
	}
	var problems []string
	for _, req := range info.Required {
		if !present[string(req)] {
			problems = append(problems, fmt.Sprintf("event %s: missing required attribute %s", name, req))
		}
	}
	for _, tmpl := range info.RequiredTemplates {
		prefix := string(tmpl) + "."
		// A bare "<template>." carries no key, so it does not satisfy the
		// template.
		satisfied := slices.ContainsFunc(keys, func(k string) bool {
			return len(k) > len(prefix) && strings.HasPrefix(k, prefix)
		})
		if !satisfied {
			problems = append(problems, fmt.Sprintf("event %s: missing required template attribute %s<key>", name, prefix))
		}
	}
	return problems
}
