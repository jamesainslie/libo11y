package appregistry_test

import (
	"errors"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/jamesainslie/libo11y/go/internal/appregistry"
)

func ruleIDs(vs []appregistry.Violation) []string {
	ids := make([]string, len(vs))
	for i, v := range vs {
		ids[i] = v.RuleID
	}
	return ids
}

func TestValidRegistry(t *testing.T) {
	raw, err := os.ReadFile("testdata/valid.yaml")
	if err != nil {
		t.Fatal(err)
	}
	reg, err := appregistry.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if vs := reg.Validate(); len(vs) != 0 {
		t.Fatalf("Validate() = %v, want none", vs)
	}
	if reg.Namespace != "lor" || len(reg.Attributes) != 5 {
		t.Errorf("parsed namespace %q with %d attributes", reg.Namespace, len(reg.Attributes))
	}
	if got := reg.Attributes["lor.user.role"].Values; !slices.Equal(got, []string{"studio", "client"}) {
		t.Errorf("lor.user.role values = %v", got)
	}
}

func TestParseIsStrict(t *testing.T) {
	for name, tc := range map[string]struct {
		doc          string
		wantEmpty    bool   // the error is ErrEmpty
		wantSecond   bool   // the error is ErrSecondDocument
		wantContains string // the error text contains this, when set
	}{
		"unknown top-level key": {doc: "schema: libo11y.app-registry/v1\nnamespace: lor\nnamespaces: [x]\n"},
		"unknown attribute key": {doc: "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivty: public}\n"}, //nolint:misspell // the misspelt key is the test input
		"two documents":         {doc: "schema: libo11y.app-registry/v1\n---\nschema: x\n", wantSecond: true},
		"malformed second document": {
			doc:          "schema: libo11y.app-registry/v1\n---\nschema: [\n",
			wantContains: "parsing application registry:",
		},
		"empty":        {doc: "", wantEmpty: true},
		"comment only": {doc: "# nothing\n", wantEmpty: true},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := appregistry.Parse([]byte(tc.doc))
			if err == nil {
				t.Fatal("Parse succeeded, want an error")
			}
			if tc.wantSecond != errors.Is(err, appregistry.ErrSecondDocument) {
				t.Errorf("Parse error = %v, errors.Is ErrSecondDocument = %t, want %t", err, !tc.wantSecond, tc.wantSecond)
			}
			if tc.wantEmpty && !errors.Is(err, appregistry.ErrEmpty) {
				t.Errorf("Parse error = %v, want %v", err, appregistry.ErrEmpty)
			}
			if !strings.Contains(err.Error(), tc.wantContains) {
				t.Errorf("Parse error = %q, want it to contain %q", err, tc.wantContains)
			}
		})
	}
}

func TestValidateRules(t *testing.T) {
	const head = "schema: libo11y.app-registry/v1\nnamespace: lor\nattributes:\n"
	for name, tc := range map[string]struct {
		doc  string
		want []string
	}{
		"unknown schema": {
			"schema: libo11y.app-registry/v2\nnamespace: lor\nattributes:\n  lor.a.b: {type: string, sensitivity: public, cardinality: bounded}\n",
			[]string{"libo11y_app_schema_unknown"},
		},
		"dotted namespace": {
			"schema: libo11y.app-registry/v1\nnamespace: lor.portal\nattributes:\n  lor.portal.a: {type: string, sensitivity: public, cardinality: bounded}\n",
			[]string{"libo11y_app_namespace_invalid"},
		},
		"semconv namespace": {
			"schema: libo11y.app-registry/v1\nnamespace: http\nattributes:\n  http.thing: {type: string, sensitivity: public, cardinality: bounded}\n",
			[]string{"libo11y_app_namespace_reserved"},
		},
		"oracle namespace": {
			"schema: libo11y.app-registry/v1\nnamespace: oracle\nattributes:\n  oracle.db.name: {type: string, sensitivity: public, cardinality: bounded}\n",
			[]string{"libo11y_app_namespace_reserved"},
		},
		"deprecated semconv root namespace": {
			"schema: libo11y.app-registry/v1\nnamespace: state\nattributes:\n  state.thing: {type: string, sensitivity: public, cardinality: bounded}\n",
			[]string{"libo11y_app_namespace_reserved"},
		},
		"o11y namespace": {
			"schema: libo11y.app-registry/v1\nnamespace: o11y\nattributes:\n  o11y.thing: {type: string, sensitivity: public, cardinality: bounded}\n",
			[]string{"libo11y_app_namespace_reserved"},
		},
		"no attributes": {"schema: libo11y.app-registry/v1\nnamespace: lor\n", []string{"libo11y_app_attributes_empty"}},
		"outside namespace": {
			head + "  acme.a.b: {type: string, sensitivity: public, cardinality: bounded}\n",
			[]string{"libo11y_app_attr_outside_namespace"},
		},
		"bad name":   {head + "  lor.User: {type: string, sensitivity: public, cardinality: bounded}\n", []string{"libo11y_attr_naming"}},
		"bad type":   {head + "  lor.a.b: {type: uuid, sensitivity: public, cardinality: bounded}\n", []string{"libo11y_app_type_unknown"}},
		"no class":   {head + "  lor.a.b: {type: string, cardinality: bounded}\n", []string{"libo11y_sensitivity_missing"}},
		"bad class":  {head + "  lor.a.b: {type: string, sensitivity: secretish, cardinality: bounded}\n", []string{"libo11y_sensitivity_unknown"}},
		"no budget":  {head + "  lor.a.b: {type: string, sensitivity: public}\n", []string{"libo11y_cardinality_missing"}},
		"bad budget": {head + "  lor.a.b: {type: string, sensitivity: public, cardinality: huge}\n", []string{"libo11y_cardinality_unknown"}},
		"enum without values": {
			head + "  lor.a.b: {type: string, sensitivity: public, cardinality: enum}\n",
			[]string{"libo11y_app_enum_values_missing"},
		},
		"values without enum": {
			head + "  lor.a.b: {type: string, sensitivity: public, cardinality: bounded, values: [x]}\n",
			[]string{"libo11y_app_values_without_enum"},
		},
		"padded value": {
			head + "  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [\" x\"]}\n",
			[]string{"libo11y_enum_value_whitespace"},
		},
		"duplicate value": {
			head + "  lor.a.b: {type: string, sensitivity: public, cardinality: enum, values: [x, x]}\n",
			[]string{"libo11y_enum_duplicate_value"},
		},
	} {
		t.Run(name, func(t *testing.T) {
			reg, err := appregistry.Parse([]byte(tc.doc))
			if err != nil {
				t.Fatal(err)
			}
			if got := ruleIDs(reg.Validate()); !slices.Equal(got, tc.want) {
				t.Errorf("Validate() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestViolationString(t *testing.T) {
	v := appregistry.Violation{RuleID: "libo11y_attr_naming", Attribute: "lor.User", Detail: "not a dotted snake_case name"}
	if got := v.String(); !strings.Contains(got, "libo11y_attr_naming") || !strings.Contains(got, "lor.User") {
		t.Errorf("String() = %q", got)
	}
}

// TestValidateOrder pins the output order Validate documents: registry-level
// rules first, then attributes in name order, each attribute's rules in a
// fixed order.
func TestValidateOrder(t *testing.T) {
	doc := "schema: libo11y.app-registry/v2\nnamespace: lor\nattributes:\n" +
		"  lor.a: {type: uuid, cardinality: bounded}\n" +
		"  lor.B: {type: string, sensitivity: public, cardinality: bounded}\n"
	reg, err := appregistry.Parse([]byte(doc))
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"libo11y_app_schema_unknown",
		"libo11y_attr_naming",
		"libo11y_app_type_unknown",
		"libo11y_sensitivity_missing",
	}
	if got := ruleIDs(reg.Validate()); !slices.Equal(got, want) {
		t.Errorf("Validate() = %v, want %v", got, want)
	}
}
