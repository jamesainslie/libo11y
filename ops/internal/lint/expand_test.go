package lint

import "testing"

func TestExpand(t *testing.T) {
	vars := map[string]string{"app": ".+", "view": "/products"}
	for in, want := range map[string]string{
		`x{service_name=~"$app"}`:                  `x{service_name=~".+"}`,
		`x{service_name=~"${app}"}`:                `x{service_name=~".+"}`,
		`x{service_name=~"${app:regex}"}`:          `x{service_name=~".+"}`,
		`rate(x[$__rate_interval])`:                `rate(x[5m])`,
		`increase(x[$__range])`:                    `increase(x[1h])`,
		`rate(x[$__interval])`:                     `rate(x[1m])`,
		`label_replace(x, "a", "$1", "b", "(.*)")`: `label_replace(x, "a", "$1", "b", "(.*)")`,
		`$view and $app`:                           `/products and .+`,
	} {
		got, err := Expand(in, vars)
		if err != nil || got != want {
			t.Errorf("Expand(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{`x{a="$nope"}`, `x{a="${nope}"}`} {
		if _, err := Expand(in, vars); err == nil {
			t.Errorf("Expand(%q): an unknown variable was accepted", in)
		}
	}
}

func TestExpandEdges(t *testing.T) {
	if _, err := Expand(`x{a="${nope:date:iso}"}`, nil); err == nil {
		t.Error("an unknown variable with two formats was accepted")
	}
	// Every built-in the dashboard check accepts also expands.
	for name := range builtins {
		if _, err := Expand("$"+name, nil); err != nil {
			t.Errorf("built-in $%s: %v", name, err)
		}
	}
}
