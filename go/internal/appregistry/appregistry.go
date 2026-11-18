// Package appregistry parses and validates an application attribute
// registry: the file in which a libo11y consumer declares its own
// namespaced attributes with their sensitivity, type, and cardinality, so
// the sensitivity layer classifies them exactly like spec keys. The rules
// it shares with the spec registry checks come from internal/specrules.
package appregistry

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"maps"
	"regexp"
	"slices"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/jamesainslie/libo11y/go/internal/specrules"
)

// SchemaV1 is the only registry schema this package reads.
const SchemaV1 = "libo11y.app-registry/v1"

// Registry is a parsed application registry.
type Registry struct {
	Schema     string               `yaml:"schema"`
	Namespace  string               `yaml:"namespace"`
	Attributes map[string]Attribute `yaml:"attributes"`
}

// Attribute is one declared application attribute.
type Attribute struct {
	Type        string   `yaml:"type"`
	Sensitivity string   `yaml:"sensitivity"`
	Cardinality string   `yaml:"cardinality"`
	Values      []string `yaml:"values"`
	Brief       string   `yaml:"brief"`
}

// Violation is one rule a registry breaks. Attribute is empty for a rule
// about the registry as a whole.
type Violation struct {
	RuleID    string
	Attribute string
	Detail    string
}

func (v Violation) String() string {
	if v.Attribute == "" {
		return fmt.Sprintf("%s: %s", v.RuleID, v.Detail)
	}
	return fmt.Sprintf("%s: attribute %s: %s", v.RuleID, v.Attribute, v.Detail)
}

// errEmpty reports a registry file with no YAML document.
var errEmpty = errors.New("application registry is empty")

// Parse decodes raw strictly: an unknown key, a second YAML document, and
// an empty file are errors. Parse does not apply the policy rules; call
// Validate for those.
func Parse(raw []byte) (*Registry, error) {
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	var reg Registry
	if err := dec.Decode(&reg); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, errEmpty
		}
		return nil, fmt.Errorf("parsing application registry: %w", err)
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("an application registry holds one YAML document, found a second")
		}
		return nil, fmt.Errorf("parsing application registry: %w", err)
	}
	return &reg, nil
}

// namespacePattern is one snake_case segment.
var namespacePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`)

// attributeTypes are the semconv attribute types an application may use.
var attributeTypes = map[string]bool{
	"string": true, "boolean": true, "int": true, "double": true,
	"string[]": true, "boolean[]": true, "int[]": true, "double[]": true,
}

// Validate applies the policy rules and returns every violation:
// registry-level rules first, then each attribute in name order, each
// attribute's rules in a fixed order.
func (r *Registry) Validate() []Violation {
	var vs []Violation
	fail := func(rule, attr, detail string) {
		vs = append(vs, Violation{RuleID: rule, Attribute: attr, Detail: detail})
	}

	if r.Schema != SchemaV1 {
		fail("libo11y_app_schema_unknown", "", fmt.Sprintf("schema %q, want %q", r.Schema, SchemaV1))
	}
	switch {
	case !namespacePattern.MatchString(r.Namespace):
		fail("libo11y_app_namespace_invalid", "", fmt.Sprintf("namespace %q is not one snake_case segment", r.Namespace))
	case reservedNamespaces[r.Namespace]:
		fail("libo11y_app_namespace_reserved", "", fmt.Sprintf("namespace %q belongs to libo11y, OpenTelemetry, or semconv", r.Namespace))
	}
	if len(r.Attributes) == 0 {
		fail("libo11y_app_attributes_empty", "", "the registry declares no attributes")
	}

	for _, name := range slices.Sorted(maps.Keys(r.Attributes)) {
		a := r.Attributes[name]
		if !strings.HasPrefix(name, r.Namespace+".") {
			fail("libo11y_app_attr_outside_namespace", name, fmt.Sprintf("not under the %s namespace", r.Namespace))
		}
		if !specrules.ValidName(name) {
			fail("libo11y_attr_naming", name, "not a dotted snake_case name with at least two segments")
		}
		if !attributeTypes[a.Type] {
			fail("libo11y_app_type_unknown", name, fmt.Sprintf("type %q", a.Type))
		}
		switch {
		case a.Sensitivity == "":
			fail("libo11y_sensitivity_missing", name, "no sensitivity class")
		case !specrules.IsSensitivity(a.Sensitivity):
			fail("libo11y_sensitivity_unknown", name, fmt.Sprintf("sensitivity %q", a.Sensitivity))
		}
		switch {
		case a.Cardinality == "":
			fail("libo11y_cardinality_missing", name, "no cardinality budget")
		case !specrules.IsCardinality(a.Cardinality):
			fail("libo11y_cardinality_unknown", name, fmt.Sprintf("cardinality %q", a.Cardinality))
		}
		switch {
		case a.Cardinality == "enum" && len(a.Values) == 0:
			fail("libo11y_app_enum_values_missing", name, "an enum declares its values")
		case a.Cardinality != "enum" && len(a.Values) > 0:
			fail("libo11y_app_values_without_enum", name, "values need cardinality enum")
		}
		seen := map[string]bool{}
		for _, v := range a.Values {
			if v != strings.TrimSpace(v) {
				fail("libo11y_enum_value_whitespace", name, fmt.Sprintf("value %q", v))
			}
			if seen[strings.TrimSpace(v)] {
				fail("libo11y_enum_duplicate_value", name, fmt.Sprintf("value %q", v))
			}
			seen[strings.TrimSpace(v)] = true
		}
	}
	return vs
}
