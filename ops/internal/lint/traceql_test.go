package lint

import (
	"fmt"
	"strings"
	"testing"
)

func TestCheckTraceQL(t *testing.T) {
	ok := []string{
		`{ span.session.id = "s" }`,
		`{ span.session.id = "s" && span.o11y.rum.view.id = "v" }`,
		`{ resource.service.name =~ "shop-.*" && span.o11y.rum.span.shape = "view" }`,
	}
	for _, q := range ok {
		if errs := CheckTraceQL(q); len(errs) > 0 {
			t.Errorf("%s: %v", q, errs)
		}
	}
	bad := map[string]string{
		`{ span.user.email = "x" }`:  "user.email",
		`session.id = "s"`:           "spanset",
		`{ span.session.id != "s" }`: "!=",
		`{ span.session.id = s }`:    "quoted",
		`{ .session.id = "s" }`:      ".session.id",
		`{ span.session.id = 's' }`:  "quoted",
		`{}`:                         "spanset",
	}
	for q, want := range bad {
		errs := CheckTraceQL(q)
		if len(errs) == 0 || !strings.Contains(fmt.Sprint(errs), want) {
			t.Errorf("%s: %v, want an error mentioning %q", q, errs, want)
		}
	}
}

func TestCheckTraceQLEdges(t *testing.T) {
	for _, q := range []string{
		`{ span.session.id != nil }`,
		"{\n  span.session.id = \"s\"\n}",
	} {
		if errs := CheckTraceQL(q); len(errs) > 0 {
			t.Errorf("%q: %v", q, errs)
		}
	}
	errs := CheckTraceQL(`{ span.session.id && span.o11y.rum.view.id = "v" }`)
	if !strings.Contains(fmt.Sprint(errs), "not compared") {
		t.Errorf("an attribute with no comparison: %v", errs)
	}
}
